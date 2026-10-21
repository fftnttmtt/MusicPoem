"""Aligned subset summation. Preserve source gains; never clip/normalize each stem."""
from pathlib import Path
import numpy as np


def mix_stems(folder, stems, frames, sample_rate):
    import soundfile as sf
    mix = np.zeros((frames, 2), dtype=np.float32)
    for stem in stems:
        audio, sr = sf.read(Path(folder)/(stem+'.wav'), dtype='float32', always_2d=True)
        if sr != sample_rate or audio.shape != mix.shape:
            raise ValueError(f'{stem} 混音分轨未与原曲逐采样对齐。')
        if not np.isfinite(audio).all():
            raise ValueError(f'{stem} 混音分轨含无效采样。')
        mix += audio
    if not np.isfinite(mix).all():
        raise ValueError('混音含无效采样。')
    return mix
