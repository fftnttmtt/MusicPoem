"""Audio decode/export helpers; all previews share one attenuation factor."""
import argparse
import math
import os
from pathlib import Path
import shutil
import subprocess

def nonnegative(value):
    value = float(value)
    if not math.isfinite(value) or value < 0:
        raise argparse.ArgumentTypeError("必须是大于等于 0 的有限数值")
    return value

def ffmpeg_executable():
    explicit = os.environ.get("IMAGEIO_FFMPEG_EXE")
    if explicit:
        return explicit
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        executable = shutil.which("ffmpeg")
        if executable:
            return executable
        raise RuntimeError("未找到 FFmpeg，请运行 install.bat 或安装 imageio-ffmpeg。")

def decode_audio(source, start=0.0, duration=30.0, sample_rate=44100, channels=2):
    """Decode a selected interval; FFmpeg handles MP3/AAC/etc without torchaudio I/O."""
    import numpy as np
    if not Path(source).is_file():
        raise FileNotFoundError(f"音频不存在：{source}")
    command = [ffmpeg_executable(), "-nostdin", "-hide_banner", "-loglevel", "error",
               "-ss", str(start), "-i", str(source)]
    if duration > 0:
        command += ["-t", str(duration)]
    command += ["-map", "0:a:0", "-vn", "-ac", str(channels), "-ar", str(sample_rate),
                "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError("音频解码失败：\n" + result.stderr.decode("utf-8", errors="replace"))
    audio = np.frombuffer(result.stdout, dtype="<f4")
    if audio.size < channels * 2:
        raise ValueError("所选时间范围没有音频，请检查起点是否超过曲长。")
    if audio.size % channels:
        raise ValueError("解码得到的声道数据不完整。")
    audio = audio.reshape(-1, channels).copy()
    if not np.isfinite(audio).all():
        raise ValueError("音频含有 NaN 或无穷值。")
    return audio

def preview_gain(arrays):
    """One common attenuation for ALL previews. Never boost quiet stems separately."""
    import numpy as np
    peak = max(float(np.max(np.abs(a))) for a in arrays)
    return min(1.0, 0.99 / max(peak, 1e-12))

def export_audio(output, sample_rate, mix, stems):
    import numpy as np
    import soundfile as sf
    arrays = {"mixture": mix, **stems}
    gain = preview_gain(arrays.values())
    preview_dir = output / "preview"
    preview_dir.mkdir(exist_ok=True)
    stats = {}
    for name, audio in arrays.items():
        if audio.shape != mix.shape or not np.isfinite(audio).all():
            raise ValueError(f"{name} 的形状或采样值异常。")
        # Float WAV preserves even peaks above 1.0: no clipping and no individual rescale.
        sf.write(str(output / f"{name}.wav"), audio, sample_rate, subtype="FLOAT")
        sf.write(str(preview_dir / f"{name}.wav"), audio * gain, sample_rate, subtype="PCM_16")
        rms = float(np.sqrt(np.mean(np.square(audio.astype(np.float64)))))
        stats[name] = {"peak": float(np.max(np.abs(audio))), "rms": rms,
                       "rms_dbfs": 20 * math.log10(max(rms, 1e-12))}
    return gain, stats
