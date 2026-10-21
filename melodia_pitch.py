"""Official Essentia WASM Melodia, with optional salience weighting before contours.

The WASM build runs inside Python's embedded V8 on Windows/Linux/macOS; no Node,
Essentia Python build, network, neural weights or GPU is needed at inference.
"""
from fractions import Fraction
from pathlib import Path
import math
import numpy as np

MELODIA_REVISION=1
MELODIA_SETTINGS={'sample_rate':44100,'frame_length':2048,'hop_length':128,
    'output_stride':7,'chunk_seconds':24.,'context_seconds':3.,'bin_resolution_cents':10,
    'equal_loudness':True,'guess_unvoiced':False,'engine':'essentia.js-0.1.3/mini-racer-0.12.4'}
MELODIA_RANGES={'bass':(27.5,440.),'vocals':(65.4064,1567.982),
    'piano':(55.,1760.),'guitar':(65.4064,2000.),'other':(55.,1760.)}
ROOT=Path(__file__).resolve().parent


def pitch_engine(parameters,stem):
    method=parameters.get('pitch_method','hybrid')
    return 'pyin' if method=='pyin' or method=='hybrid' and stem in ('vocals','bass') else 'melodia'


def new_runtime():
    try:
        from py_mini_racer import MiniRacer
    except ImportError as exc:
        raise RuntimeError('Melodia 缺少运行依赖。请关闭实验台，双击 install_melodia.bat，完成后重新启动；已有分轨和情绪结果保留。') from exc
    ctx=MiniRacer()
    try:
        ctx.eval('var exports={};var console={log:function(){},warn:function(){},error:function(){}};')
        ctx.eval((ROOT/'vendor/essentia_js/essentia-wasm.umd.js').read_text(encoding='utf-8'))
        ctx.eval('var EssentiaWASM=exports.EssentiaWASM;exports=undefined;')
        ctx.eval((ROOT/'vendor/essentia_js/essentia.js-core.umd.js').read_text(encoding='utf-8'))
        ctx.eval((ROOT/'melodia_engine.js').read_text(encoding='utf-8'))
    except Exception:
        ctx.close()
        raise
    return ctx


def estimate_melodia(audio,sr,stem,progress=None,high_pitch_bias=4.,voicing_tolerance=1.2):
    from scipy.signal import resample_poly
    import json
    audio=np.asarray(audio,dtype=np.float32)
    if audio.ndim==1:audio=audio[:,None]
    if audio.ndim!=2 or not len(audio) or not np.isfinite(audio).all() or sr<=0 or stem not in MELODIA_RANGES:
        raise ValueError('Melodia 需要有效非鼓声部分轨音频。')
    if isinstance(high_pitch_bias,bool) or not math.isfinite(high_pitch_bias) or not 0<=high_pitch_bias<=6:
        raise ValueError('Melodia 高音偏好须为 0–6。')
    if isinstance(voicing_tolerance,bool) or not math.isfinite(voicing_tolerance) or not -1<=voicing_tolerance<=1.4:
        raise ValueError('Melodia 旋律保留容差须在 -1–1.4 之间。')
    settings=MELODIA_SETTINGS;rate=settings['sample_rate'];hop=settings['hop_length'];duration=len(audio)/sr
    channel=int(np.argmax(np.mean(np.square(audio,dtype=np.float64),axis=0)))
    ratio=Fraction(rate,int(sr));mono=resample_poly(audio[:,channel],ratio.numerator,ratio.denominator).astype(np.float32)
    count=int(math.floor(duration*rate/hop))+1;times=np.arange(count)*hop/rate
    hz=np.full(count,np.nan);confidence=np.zeros(count)
    pos=np.minimum(np.rint(times*rate).astype(int),len(mono));left=np.maximum(0,pos-round(.08*rate))
    energy=np.r_[0.,np.cumsum(mono.astype(np.float64)**2)]
    rms=np.sqrt(np.divide(energy[pos]-energy[left],pos-left,out=np.zeros(count),where=pos>left))
    block=max(1,round(settings['chunk_seconds']*rate/hop));context=math.ceil(settings['context_seconds']*rate/hop)
    low,high=MELODIA_RANGES[stem]
    if np.max(np.abs(mono))>1e-9:
        with new_runtime() as ctx:
            for first in range(0,count,block):
                last=min(count,first+block);origin=max(0,first-context);end=min(len(mono),(last+context)*hop)
                signal=np.ascontiguousarray(mono[origin*hop:end],dtype='<f4')
                memory=ctx.eval(f'var audioBytes=new ArrayBuffer({signal.nbytes});audioBytes')
                memory[:]=signal.tobytes();del memory
                result=json.loads(ctx.eval(f'JSON.stringify(melody(new Float32Array(audioBytes),{low!r},{high!r},{float(high_pitch_bias)!r},{float(voicing_tolerance)!r}))'))
                indices=np.arange(first,last)-origin
                if len(result['pitch'])<=indices[-1] or len(result['pitch'])!=len(result['confidence']):
                    raise RuntimeError('Melodia 帧数未覆盖原始时间轴，结果未写入缓存。')
                hz[first:last]=np.asarray(result['pitch'])[indices];confidence[first:last]=np.asarray(result['confidence'])[indices]
                ctx.eval('audioBytes=null;')
                if progress:progress(last/count)
    elif progress:progress(1.)
    # Keep the native 128-sample analysis, export every seventh frame (~20ms),
    # matching the previous preview resolution without a 7x larger mapped JSON.
    stride=settings['output_stride'];times=times[::stride];hz=hz[::stride];confidence=confidence[::stride];rms=rms[::stride]
    valid=np.isfinite(hz)&(hz>0)&np.isfinite(confidence)&(confidence>0)
    return {'version':MELODIA_REVISION,'method':'melodia','stem':stem,'duration_seconds':duration,
        'settings':{**settings,'high_pitch_bias':high_pitch_bias,'voicing_tolerance':voicing_tolerance},'frequency_range_hz':[low,high],
        'selected_channel':channel,'channel_rule':'highest whole-track RMS channel; avoid stereo phase cancellation',
        'confidence_kind':'melodia_salience','confidence_description':'Melodia salience confidence, not pYIN voiced probability; voiced_probability is a compatibility field',
        'high_pitch_rule':'candidate salience *= 2**(bias*clip(log2(hz/min)/log2(max/min),0,1)); normalize each frame to its original peak salience; no transposition',
        'time_alignment':'native frame k centered at sample k*128; export every seventh original frame; overlap context discarded; no frame-length offset',
        'times':times.tolist(),'f0_hz':[float(v) if np.isfinite(v) and v>0 else None for v in hz],
        'voiced_flag':valid.tolist(),'voiced_probability':np.maximum(np.nan_to_num(confidence,nan=0,posinf=0,neginf=0),0).tolist(),
        'rms':rms.tolist()}
