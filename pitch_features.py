"""Cached pYIN baseline and two deterministic, per-stem pitch position modes."""
import math
from fractions import Fraction
import numpy as np

PITCH_REVISION=1
PITCH_SETTINGS={'sample_rate':11025,'frame_length':2048,'hop_length':220,
    'resolution':.2,'chunk_seconds':12.,'context_seconds':1.,'center':True}
PITCH_RANGES={'bass':(27.5,440.),'vocals':(65.4064,1567.982),
    'piano':(27.5,4186.009),'guitar':(65.4064,2093.005),'other':(55.,2093.005)}


def estimate_pitch(audio,sr,stem,progress=None):
    """Frame centers use the original audio clock; chunks share a global hop grid."""
    from scipy.signal import resample_poly
    audio=np.asarray(audio,dtype=np.float32)
    if audio.ndim==1:audio=audio[:,None]
    if audio.ndim!=2 or not len(audio) or not np.isfinite(audio).all() or sr<=0 or stem not in PITCH_RANGES:
        raise ValueError('pYIN需要有效分轨音频、采样率和非鼓声部。')
    duration=len(audio)/sr;settings=PITCH_SETTINGS;rate=settings['sample_rate'];hop=settings['hop_length']
    channel=int(np.argmax(np.mean(np.square(audio,dtype=np.float64),axis=0)))
    ratio=Fraction(rate,int(sr));mono=resample_poly(audio[:,channel],ratio.numerator,ratio.denominator).astype(np.float32)
    count=int(math.floor(duration*rate/hop))+1;times=np.arange(count)*hop/rate
    hz=np.full(count,np.nan);flags=np.zeros(count,dtype=bool);probs=np.zeros(count)
    # Causal energy gate avoids accepting a centered window's pitch before an onset.
    pos=np.minimum(np.rint(times*rate).astype(int),len(mono));left=np.maximum(0,pos-round(.08*rate))
    energy=np.r_[0.,np.cumsum(mono.astype(np.float64)**2)]
    rms=np.sqrt(np.divide(energy[pos]-energy[left],pos-left,out=np.zeros(count),where=pos>left))
    if np.max(np.abs(mono))>1e-9:
        import librosa
        block_frames=max(1,round(settings['chunk_seconds']*rate/hop));context=math.ceil(settings['context_seconds']*rate/hop)
        low,high=PITCH_RANGES[stem]
        for first in range(0,count,block_frames):
            last=min(count,first+block_frames);origin=max(0,first-context)
            end=min(len(mono),(last+context)*hop)
            f0,voiced,prob=librosa.pyin(mono[origin*hop:end],sr=rate,fmin=low,fmax=high,
                frame_length=settings['frame_length'],hop_length=hop,resolution=settings['resolution'],
                center=True,fill_na=np.nan,pad_mode='constant')
            indices=np.arange(first,last)-origin
            if indices[-1]>=len(f0):raise ValueError('pYIN返回的帧数未覆盖原始时间轴。')
            hz[first:last]=f0[indices];flags[first:last]=voiced[indices];probs[first:last]=prob[indices]
            if progress:progress(last/count)
    elif progress:progress(1.)
    return {'version':PITCH_REVISION,'method':'pyin','stem':stem,'duration_seconds':duration,
        'settings':dict(settings),'frequency_range_hz':list(PITCH_RANGES[stem]),
        'selected_channel':channel,'channel_rule':'highest whole-track RMS channel; avoid stereo phase cancellation',
        'time_alignment':'center=True; frame k centered at global sample k*hop; no frame-length offset',
        'times':times.tolist(),'f0_hz':[float(v) if np.isfinite(v) and v>0 else None for v in hz],
        'voiced_flag':flags.tolist(),'voiced_probability':np.clip(np.nan_to_num(probs),0,1).tolist(),'rms':rms.tolist()}


def pitch_features(raw,beats,duration,confidence=.6,gate_dbfs=-55.):
    limit=1000 if raw.get('method')=='melodia' else 1
    if not math.isfinite(confidence) or not 0<=confidence<=limit or not math.isfinite(duration) or duration<=0:raise ValueError('音高映射参数无效。')
    times=np.asarray(raw['times'],dtype=float);n=len(times)
    hz=np.asarray([v if v is not None else np.nan for v in raw['f0_hz']],dtype=float)
    prob=np.asarray(raw['voiced_probability'],dtype=float);flags=np.asarray(raw['voiced_flag'],dtype=bool);rms=np.asarray(raw['rms'],dtype=float)
    if not n or any(len(a)!=n for a in (hz,prob,flags,rms)) or not np.isfinite(times).all() or abs(times[0])>1e-9 or np.any(np.diff(times)<=0) or times[-1]>duration+1e-8:
        raise ValueError('音高帧必须使用覆盖原曲的有效递增时间轴。')
    valid=np.isfinite(hz)&(hz>0)&flags&np.isfinite(prob)&(prob>=confidence)&np.isfinite(rms)&(rms>=10**(gate_dbfs/20))
    midi=np.full(n,np.nan);midi[valid]=69+12*np.log2(hz[valid]/440.)
    beat_times=sorted({float(t) for t in beats if isinstance(t,(int,float)) and math.isfinite(t) and 0<=t<duration})
    bounds=sorted({0.,duration,*beat_times});medians=[];ranges=[]
    for a,b in zip(bounds[:-1],bounds[1:]):
        i,j=np.searchsorted(times,[a,b],side='left');indices=np.arange(i,j)[valid[i:j]]
        medians.append(float(np.median(midi[indices])) if len(indices) else None);ranges.append(indices)
    values=[m for m in medians if m is not None]
    low,high=(float(v) for v in np.percentile(values,[5,95],method='linear')) if values else (None,None)
    constant=low is None or high-low<=1e-9
    def normalized(value):return .5 if value is None or constant else float(np.clip((value-low)/(high-low),0,1))
    rows=[];last_midi=None;last_y=.5
    for i,(a,b) in enumerate(zip(bounds[:-1],bounds[1:])):
        m=medians[i];y=normalized(m) if m is not None else None;indices=ranges[i]
        start=last_midi if last_midi is not None else m;start_y=last_y if last_midi is not None else (y if y is not None else .5)
        target=m if m is not None else start;target_y=y if y is not None else start_y
        rows.append({'index':i+1,'start_seconds':a,'end_seconds':b,'status':'ok' if m is not None else 'unvoiced',
            'kind':'leading' if beat_times and a<beat_times[0] else 'beat','midi':m,'normalized':y,
            'valid_frames':len(indices),'confidence_median':float(np.median(prob[indices])) if len(indices) else None,
            'from_midi':start,'target_midi':target,'from_normalized':start_y,'target_normalized':target_y})
        if m is not None:last_midi,last_y=m,y
    # Continuous mode changes targets only once their frame timestamp has arrived.
    continuous=[];display=None;previous_time=0.;previous_target=None;previous_valid=False;tau=.06
    for i,t in enumerate(times):
        if t>=duration:break
        if previous_valid and display is not None:
            display=previous_target+(display-previous_target)*math.exp(-(t-previous_time)/tau)
        m=float(midi[i]) if valid[i] else None
        if m is not None and display is None:display=m
        target=m if m is not None else display
        continuous.append({'start_seconds':float(t),'end_seconds':float(min(duration,times[i+1] if i+1<n else duration)),
            'status':'ok' if m is not None else 'unvoiced','midi':m,'f0_hz':float(hz[i]) if m is not None else None,
            'confidence':float(prob[i]) if np.isfinite(prob[i]) else 0.,
            'from_midi':display,'target_midi':target,'from_normalized':normalized(display),'target_normalized':normalized(target)})
        previous_time=float(t);previous_target=target;previous_valid=m is not None
    return {'version':PITCH_REVISION,'method':raw.get('method','pyin'),'confidence_kind':raw.get('confidence_kind','pyin_voiced_probability'),'rows':rows,'continuous':continuous,
        'midi_p5':low,'midi_p95':high,'percentiles':[5,95],'constant_position':.5,'continuous_tau_seconds':tau,
        'confidence_threshold':confidence,'gate_dbfs':gate_dbfs,'valid_frames':int(valid.sum()),'total_frames':n,
        'coverage':float(valid.mean()),'valid_beats':len(values),'total_beats':len(rows),
        'scope':'this_stem_valid_beat_midi_medians','units':'MIDI = 69 + 12*log2(Hz/440)',
        'beat_statistic':'median of accepted MIDI frames whose centers lie in the original beat',
        'invalid':'exclude below engine-specific confidence threshold, unvoiced, nonfinite and quiet frames; hold last position; start centered',
        'transition':'beat: full-current-beat smoothstep; continuous: causal MIDI exponential response; no lookahead targets'}
