#!/usr/bin/env python3
"""Fixed BS-RoFormer SW six-stem experiment, with a verified checkpoint/config pair."""
from __future__ import annotations

import argparse
from contextlib import nullcontext
from datetime import datetime
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import subprocess
import sys
import time
import traceback
import urllib.request
import uuid

try:
    from .audio_io import decode_audio, export_audio, ffmpeg_executable, nonnegative
except ImportError:
    from audio_io import decode_audio, export_audio, ffmpeg_executable, nonnegative

ROOT = Path(__file__).resolve().parent
STEMS = ("bass", "drums", "other", "vocals", "guitar", "piano")
SAMPLE_RATE = 44100
WEIGHT_NAME = "BS-Rofo-SW-Fixed.ckpt"
WEIGHT_URL = "https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed/resolve/a443a2985534b3bc815ef54a5d446c6a0390f974/BS-Rofo-SW-Fixed.ckpt"
WEIGHT_SHA256 = "24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e"
WEIGHT_BYTES = 699412152
CONFIG_SHA256 = "f9fada9f94e5ba2d2e4600196299459294bc5f532b314c209cc156ac63e4329b"
UPSTREAM_COMMIT = "95c8de7b0b091d00f064d694bf916a21866c32f5"


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_weights(path):
    path = Path(path)
    if not path.is_file() or path.stat().st_size != WEIGHT_BYTES:
        raise ValueError(f"权重不存在或大小不符：{path}；应为 {WEIGHT_BYTES:,} 字节。")
    print("正在校验六声部权重 SHA-256…", flush=True)
    if file_sha256(path) != WEIGHT_SHA256:
        raise ValueError("权重校验失败，请移走该文件并重新下载。")
    return path


def ensure_weights(cache, explicit=None):
    if explicit:
        return verify_weights(Path(explicit).expanduser().resolve())
    cache = Path(cache).expanduser().resolve()
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / WEIGHT_NAME
    if target.is_file():
        return verify_weights(target)
    partial = target.with_suffix(target.suffix + ".part")
    offset = partial.stat().st_size if partial.is_file() else 0
    if offset == WEIGHT_BYTES and file_sha256(partial) == WEIGHT_SHA256:
        partial.replace(target)
        return target
    if offset >= WEIGHT_BYTES:
        partial.unlink()
        offset = 0
    print(f"首次运行下载约 700 MB 权重：{target}", flush=True)
    headers = {"User-Agent": "BSRoformerLocalTest/1.0"}
    if offset:
        headers["Range"] = f"bytes={offset}-"
        print(f"尝试从 {offset / 1e6:.1f} MB 继续下载…", flush=True)
    request = urllib.request.Request(WEIGHT_URL, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.status == 206 and offset:
                if not response.headers.get("Content-Range", "").startswith(f"bytes {offset}-"):
                    raise RuntimeError("服务器返回的续传位置不匹配。")
                mode = "ab"
            else:
                offset, mode = 0, "wb"
            done, last_log = offset, 0.0
            with partial.open(mode) as handle:
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    handle.write(block)
                    done += len(block)
                    now = time.monotonic()
                    if now - last_log >= 2:
                        print(f"下载 {min(100, done / WEIGHT_BYTES * 100):.1f}% · {done / 1e6:.1f} MB", flush=True)
                        last_log = now
    except Exception as exc:
        raise RuntimeError(
            f"权重下载失败：{exc}\n可重试（保留 .part 以续传），或手动下载 {WEIGHT_URL}\n"
            f"然后放到 {target}，也可用 --weights 指定文件。"
        ) from exc
    try:
        verify_weights(partial)
    except ValueError:
        partial.unlink(missing_ok=True)
        raise
    partial.replace(target)
    print("权重下载与校验完成。", flush=True)
    return target


def load_config():
    import yaml
    from ml_collections import ConfigDict
    from bs_roformer.inference import SafeLoaderWithTuple
    path = ROOT / "model_config.yaml"
    if file_sha256(path) != CONFIG_SHA256:
        raise ValueError("model_config.yaml 与指定 SW 权重不匹配，请重新解压原测试包。")
    config = ConfigDict(yaml.load(path.read_text(encoding="utf-8"), Loader=SafeLoaderWithTuple))
    if (tuple(config.training.instruments) != STEMS or config.model.num_stems != 6
            or not config.model.stereo or config.audio.sample_rate != SAMPLE_RATE):
        raise ValueError("配置必须为 44.1 kHz 双声道的 SW 六声部版本。")
    return config


def infer_chunks(model, mix, *, device, chunk_size, overlap=2, amp=True, progress=None):
    """Windowed overlap-add with CPU accumulation, bounded accelerator audio storage.

    mix: (channels, samples), CPU float32 tensor; output: (6, channels, samples).
    The configured chunk must be a multiple of the model STFT hop (512).
    """
    import torch
    import torch.nn.functional as F
    if chunk_size < 10 or overlap < 1 or chunk_size // overlap < 1:
        raise ValueError("计算块或重叠参数无效。")
    original_length = mix.shape[-1]
    if original_length < 1:
        raise ValueError("输入为空。")
    step = chunk_size // overlap
    border = chunk_size - step
    padded = border > 0 and original_length > 2 * border
    if padded:
        mix = F.pad(mix, (border, border), mode="reflect")
    total_length = mix.shape[-1]
    result = torch.zeros((6, mix.shape[0], total_length), dtype=torch.float32)
    counter = torch.zeros(total_length, dtype=torch.float32)
    fade_size = max(1, chunk_size // 10)
    window_template = torch.ones(chunk_size)
    window_template[:fade_size] = torch.linspace(0, 1, fade_size)
    window_template[-fade_size:] = torch.linspace(1, 0, fade_size)
    offsets = range(0, total_length, step)
    blocks = len(offsets)
    started = time.perf_counter()
    model.eval()
    with torch.inference_mode():
        for block_index, offset in enumerate(offsets, 1):
            part = mix[:, offset:offset + chunk_size]
            length = part.shape[-1]
            if length < chunk_size:
                mode = "reflect" if length > chunk_size // 2 + 1 else "constant"
                part = F.pad(part, (0, chunk_size - length), mode=mode)
            context = torch.autocast(device_type="cuda") if amp and str(device).startswith("cuda") else nullcontext()
            with context:
                estimate = model(part.unsqueeze(0).to(device))[0]
            estimate = estimate.float().cpu()
            if estimate.shape[:2] != result.shape[:2] or estimate.shape[-1] < length:
                raise ValueError(f"六声部模型输出尺寸异常：{tuple(estimate.shape)}")
            if not torch.isfinite(estimate).all():
                raise ValueError("模型输出出现非有限值，请关闭 GPU 半精度后重试。")
            window = window_template.clone()
            if offset == 0:
                window[:fade_size] = 1
            if offset + chunk_size >= total_length:
                window[-fade_size:] = 1
            result[..., offset:offset + length] += estimate[..., :length] * window[:length]
            counter[offset:offset + length] += window[:length]
            if progress:
                progress(block_index, blocks, time.perf_counter() - started)
            del estimate, part
    if not (counter > 0).all():
        raise RuntimeError("分块拼接有未覆盖的采样点。")
    result /= counter
    if padded:
        result = result[..., border:border + original_length]
    if result.shape[-1] != original_length:
        raise RuntimeError("分轨长度与输入不一致。")
    return result


def check_environment():
    report = {"python": sys.version.split()[0], "executable": sys.executable}
    ok = True
    for name in ("torch", "bs-roformer-infer", "numpy", "soundfile", "imageio-ffmpeg"):
        try:
            report[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            report[name] = "NOT INSTALLED"
            ok = False
    try:
        import torch
        import soundfile
        from bs_roformer import BSRoformer
        load_config()
        report["cuda_available"] = torch.cuda.is_available()
        report["gpu"] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
        subprocess.run([ffmpeg_executable(), "-version"], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15)
    except Exception as exc:
        report["error"] = str(exc)
        ok = False
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    return 0 if ok else 1


def separate(args):
    import numpy as np
    import torch
    from bs_roformer.utils import get_model_from_config

    started = time.perf_counter()
    if args.threads:
        torch.set_num_threads(args.threads)
    torch.manual_seed(42)
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA 不可用，请选 CPU，或重新安装 GPU 版 Torch 并检查驱动。")
    device = ("cuda" if torch.cuda.is_available() else "cpu") if args.device == "auto" else args.device
    config = load_config()
    mix = decode_audio(args.input, args.start, args.duration, SAMPLE_RATE, 2)
    checkpoint = ensure_weights(args.cache, args.weights)
    hop = int(config.model.stft_hop_length)
    requested_chunk = (int(config.audio.chunk_size) if args.chunk_seconds == 0
                       else math.ceil(args.chunk_seconds * SAMPLE_RATE / hop) * hop)
    chunk_size = max(4 * int(config.model.stft_n_fft), requested_chunk)
    print(f"设备：{device} | BS Roformer SW · 六声部", flush=True)
    print(f"实际片段 {len(mix)/SAMPLE_RATE:.3f} 秒 | 起点 {args.start:.3f} 秒", flush=True)
    print(f"计算块 {chunk_size/SAMPLE_RATE:.3f} 秒 | 重叠倍数 {args.overlap}", flush=True)
    print("正在加载模型…", flush=True)
    model = get_model_from_config("bs_roformer", config)
    with torch.serialization.safe_globals([torch._C._nn.gelu]):
        state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    state.pop("_metadata", None)
    model.load_state_dict(state, strict=True)
    del state
    model = model.to(device).eval()

    def progress(done, total, elapsed):
        remaining = elapsed / done * (total - done)
        print(f"计算块 {done}/{total} · {done/total*100:.1f}% · 预计剩余 {remaining:.0f} 秒", flush=True)

    print("开始分离；第一个计算块完成前可能需要等待。", flush=True)
    sources = infer_chunks(model, torch.from_numpy(mix.T.copy()), device=device,
                           chunk_size=chunk_size, overlap=args.overlap,
                           amp=not args.no_amp, progress=progress).numpy()
    del model
    if device == "cuda":
        torch.cuda.empty_cache()
    stems = {name: sources[index].T for index, name in enumerate(STEMS)}
    base = args.output.expanduser().resolve()
    base.mkdir(parents=True, exist_ok=True)
    output = base / (datetime.now().strftime("run_%Y%m%d_%H%M%S_") + uuid.uuid4().hex[:6])
    output.mkdir()
    gain, stats = export_audio(output, SAMPLE_RATE, mix, stems)
    residual = sources.sum(axis=0).T - mix
    metadata = {
        "model": "BS Roformer SW (6 stems)", "input": str(args.input),
        "checkpoint": str(checkpoint), "checkpoint_sha256": WEIGHT_SHA256,
        "config_sha256": CONFIG_SHA256, "inference_source_revision": UPSTREAM_COMMIT,
        "device": device, "torch_version": torch.__version__,
        "sample_rate": SAMPLE_RATE, "channels": 2, "frames": len(mix),
        "start_seconds": args.start, "duration_seconds": len(mix)/SAMPLE_RATE,
        "stems": list(STEMS), "chunk_samples": chunk_size, "overlap": args.overlap,
        "cuda_autocast": not args.no_amp and device == "cuda", "export_subtype": "FLOAT",
        "preview_common_gain": gain, "audio_stats": stats,
        "sum_residual_rms": float(np.sqrt(np.mean(residual.astype(np.float64)**2))),
        "elapsed_seconds": time.perf_counter() - started,
        "note": "六声部均保留模型输出电平；未单独归一化。分轨时间 0 对应 start_seconds。"
    }
    result_path = output / "result.json"
    result_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"完成：{output}", flush=True)
    print("RESULT_JSON=" + str(result_path), flush=True)
    return result_path


def parser():
    p = argparse.ArgumentParser(description="BS Roformer SW 六声部本地实验（默认前 30 秒）")
    p.add_argument("input", type=Path, nargs="?", help="输入音乐路径")
    p.add_argument("--check", action="store_true", help="检查环境与配置，不下载模型")
    p.add_argument("--download-only", action="store_true", help="只下载并校验权重")
    p.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    p.add_argument("--start", type=nonnegative, default=0.0)
    p.add_argument("--duration", type=nonnegative, default=30.0, help="秒；0 表示到曲终")
    p.add_argument("--chunk-seconds", type=nonnegative, default=0.0,
                   help="计算块秒数；0 使用原配置约 13.35 秒；内存不足可设 4 或 2")
    p.add_argument("--overlap", type=int, choices=(2, 4), default=2)
    p.add_argument("--no-amp", action="store_true", help="关闭 CUDA 半精度，CPU 一直使用 FP32")
    p.add_argument("--threads", type=int, default=0, help="CPU 线程数，0 使用 Torch 默认")
    p.add_argument("--output", type=Path, default=ROOT / "outputs")
    p.add_argument("--cache", type=Path, default=ROOT / "models")
    p.add_argument("--weights", type=Path, help="手动下载的指定 SW 权重路径，仍校验 SHA-256")
    return p


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    p = parser()
    args = p.parse_args()
    if args.threads < 0 or 0 < args.chunk_seconds < 1:
        p.error("线程数不能为负；自定义计算块至少 1 秒。")
    if args.check:
        return check_environment()
    if not args.download_only:
        if args.input is None:
            p.error("请提供音乐路径，或使用 --check / --download-only")
        args.input = args.input.expanduser().resolve()
        if not args.input.is_file():
            p.error(f"音频不存在：{args.input}")
    try:
        if args.download_only:
            ensure_weights(args.cache, args.weights)
        else:
            separate(args)
        return 0
    except KeyboardInterrupt:
        print("\n已取消；下载中的 .part 文件可留待续传。", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"\n失败：{exc}", file=sys.stderr)
        if "out of memory" in str(exc).lower():
            print("先试 --chunk-seconds 4 或 2，仍不足则 --device cpu。", file=sys.stderr)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
