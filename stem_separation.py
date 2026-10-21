"""Reuse the supplied SW runner, releasing GPU memory before emotion inference."""
from pathlib import Path
import gc
import json
import math
import sys

ROOT = Path(__file__).resolve().parent
VENDOR_SRC = ROOT/'stem_separator/vendor/bs_roformer_infer/src'
if str(VENDOR_SRC) not in sys.path:
    sys.path.insert(0, str(VENDOR_SRC))
from stem_separator import bs_roformer_test as sw
from stem_separator.audio_io import decode_audio, export_audio

STEMS = sw.STEMS
LABELS = dict(bass='贝斯', drums='鼓', other='其他伴奏', vocals='人声', guitar='吉他', piano='钢琴')


def release_accelerators():
    gc.collect()
    if 'torch' in sys.modules:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def separate_source(mix, output, *, device='cuda', weights=None, chunk_seconds=0., amp=True, progress=None):
    import numpy as np
    import torch
    from bs_roformer.utils import get_model_from_config
    progress = progress or (lambda message, fraction: None)
    if device == 'cuda':
        from gpu_compat import ensure_cuda_works
        ensure_cuda_works()
    progress('校验 BS Roformer SW 六声部权重…', 0.)
    checkpoint = sw.ensure_weights(ROOT/'models', weights)
    config = sw.load_config()
    hop = int(config.model.stft_hop_length)
    requested = int(config.audio.chunk_size) if not chunk_seconds else math.ceil(chunk_seconds*sw.SAMPLE_RATE/hop)*hop
    chunk = max(4*int(config.model.stft_n_fft), requested)
    model = None
    try:
        progress('加载 BS Roformer SW 六声部模型…', .02)
        model = get_model_from_config('bs_roformer', config)
        with torch.serialization.safe_globals([torch._C._nn.gelu]):
            state = torch.load(checkpoint, map_location='cpu', weights_only=True)
        state.pop('_metadata', None)
        model.load_state_dict(state, strict=True)
        del state
        model = model.to(device).eval()
        sources = sw.infer_chunks(model, torch.from_numpy(mix.T.copy()), device=device,
            chunk_size=chunk, overlap=2, amp=amp and device == 'cuda',
            progress=lambda done, total, elapsed: progress(f'六声部分离 {done}/{total}', .04+.90*done/total)).numpy()
    finally:
        del model
        release_accelerators()
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    stems = {name: sources[i].T for i, name in enumerate(STEMS)}
    gain, stats = export_audio(output, sw.SAMPLE_RATE, mix, stems)
    # The player needs one canonical mixture. Float source WAVs remain the
    # authoritative stems; avoid retaining six redundant PCM16 preview copies.
    for name in STEMS:
        (output/'preview'/(name+'.wav')).unlink(missing_ok=True)
    metadata = dict(model='BS Roformer SW (6 stems)', checkpoint_sha256=sw.WEIGHT_SHA256,
        config_sha256=sw.CONFIG_SHA256, inference_source_revision=sw.UPSTREAM_COMMIT,
        sample_rate=sw.SAMPLE_RATE, frames=len(mix), stems=list(STEMS),
        chunk_samples=chunk, overlap=2, cuda_autocast=amp and device == 'cuda', preview_common_gain=gain, audio_stats=stats,
        export_subtype='FLOAT', independently_normalized=False)
    (output/'separation.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
    progress('六声部分离完成', 1.)
    return metadata
