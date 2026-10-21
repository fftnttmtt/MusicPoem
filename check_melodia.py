"""Small real WASM check; no song, CUDA or model downloads."""
import numpy as np
from melodia_pitch import estimate_melodia

if __name__=='__main__':
    sr=22050;t=np.arange(sr)/sr
    raw=estimate_melodia((.2*np.sin(2*np.pi*440*t)).astype(np.float32),sr,'other')
    values=[hz for t,hz in zip(raw['times'],raw['f0_hz']) if .2<t<.8 and hz is not None]
    if not values or abs(float(np.median(values))-440)>8:raise RuntimeError('Melodia self-check failed.')
    print('Melodia WASM OK: median %.2f Hz; original audio clock; CPU.'%float(np.median(values)))
