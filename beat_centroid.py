"""Beat means from cached frame features; no audio/model inference required."""
import math
import numpy as np


def beat_centroid_features(motion,beats,duration,percentiles=None):
    times=np.asarray(motion['times'],dtype=float)
    centroids=np.asarray(motion['centroid_hz'],dtype=float)
    rms=np.asarray(motion.get('raw_rms',motion['rms']),dtype=float)
    if not math.isfinite(duration) or duration<=0 or len(times)<2 or len(centroids)!=len(times) or len(rms)!=len(times):
        raise ValueError('拍均质心需要有效的时长与逐帧特征。')
    if not np.isfinite(times).all() or np.any(np.diff(times)<=0) or abs(times[0])>1e-6 or abs(times[-1]-duration)>1e-5:
        raise ValueError('逐帧质心时间轴必须覆盖原曲且严格递增。')
    beat_times=sorted({float(t) for t in beats if isinstance(t,(int,float)) and math.isfinite(t) and 0<=t<duration})
    boundaries=np.asarray(sorted({0.,duration,*beat_times}))
    # Features are causal windows ENDING at their timestamp. The right-end
    # sample represents each preceding hop, including a short final hop.
    values=centroids[1:]
    active=np.isfinite(values)&(values>=0)&np.isfinite(rms[1:])&(rms[1:]>=10**(motion.get('gate_dbfs',-55.)/20))
    dt=np.diff(times)
    area=np.r_[0.,np.cumsum(dt*np.where(active,values,0.))]
    exposure=np.r_[0.,np.cumsum(dt*active)]
    weights=np.maximum(0.,np.diff(np.interp(boundaries,times,exposure)))
    integrals=np.diff(np.interp(boundaries,times,area))
    valid=weights>1e-9
    means=np.divide(integrals,weights,out=np.zeros_like(integrals),where=valid)
    low,high=((float(v) for v in np.percentile(means[valid],percentiles,method='linear')) if percentiles else (float(means[valid].min()),float(means[valid].max()))) if np.any(valid) else (0.,0.)
    normalized=np.full_like(means,.5) if high-low<=1e-9 else np.clip((means-low)/(high-low),0,1)
    rows=[];previous_hz=None;previous_y=.5
    for i,(a,b) in enumerate(zip(boundaries[:-1],boundaries[1:])):
        hz=float(means[i]) if valid[i] else None
        y=float(normalized[i]) if valid[i] else None
        # First audible beat has no invented predecessor; silent beats hold.
        start_hz=previous_hz if previous_hz is not None else hz
        start_y=previous_y if previous_hz is not None else (y if y is not None else .5)
        target_hz=hz if hz is not None else previous_hz
        target_y=y if y is not None else start_y
        rows.append({'index':i+1,'start_seconds':float(a),'end_seconds':float(b),
            'kind':'leading' if beat_times and a<beat_times[0] else 'beat',
            'status':'ok' if valid[i] else 'silent','centroid_hz':hz,'normalized':y,
            'active_seconds':float(weights[i]),'from_centroid_hz':start_hz,'from_normalized':start_y,
            'target_centroid_hz':target_hz,'target_normalized':target_y})
        if hz is not None: previous_hz,previous_y=hz,y
    return {'version':1,'mode':'beat_average','rows':rows,'centroid_min_hz':low,'centroid_max_hz':high,
        'valid_beats':int(valid.sum()),'percentiles':list(percentiles) if percentiles else None,'scope':'this_stem_valid_beat_means',
        'mean':'duration-weighted mean of existing frame centroid over active audio in each original beat',
        'silence':'exclude quiet frames from means and min/max; hold last position in silent beats',
        'transition':'previous beat mean to current beat mean over entire current beat; no anticipation'}
