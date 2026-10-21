"""Per-source realtime envelopes; normalization never mixes instruments."""
import math
import numpy as np

FRAME_SECONDS = .02
GATE_DBFS = -55.


def normalized(values, minimum=None, maximum=None):
    a = np.asarray(values, dtype=float)
    low = float(np.min(a)) if minimum is None and a.size else float(minimum or 0)
    high = float(np.max(a)) if maximum is None and a.size else float(maximum or 0)
    return np.full_like(a, .5) if high-low <= 1e-9 else np.clip((a-low)/(high-low), 0, 1)


def realtime_features(audio, sr, *, gate_dbfs=GATE_DBFS, frame_seconds=FRAME_SECONDS):
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 1:
        audio = audio[:, None]
    if audio.ndim != 2 or not len(audio) or sr <= 0 or not np.isfinite(audio).all():
        raise ValueError('实时特征需要有限数值的非空音频。')
    hop = max(1, round(sr*frame_seconds))
    window_size = max(64, 2**int(math.ceil(math.log2(sr*.046))))
    # Causal windows end at the timestamp: no attack is borrowed from the future.
    positions = np.arange(0, len(audio)+hop, hop, dtype=int)
    positions = positions[positions <= len(audio)]
    if positions[-1] != len(audio):
        positions = np.r_[positions, len(audio)]
    times = positions/sr
    rms, centroids = [], []
    gate = 10**(gate_dbfs/20)
    frequencies = np.fft.rfftfreq(window_size, 1/sr)
    window = np.hanning(window_size)
    power_window = max(1, round(sr*.08))
    for center in positions:
        left, right = max(0, center-power_window), min(len(audio), center)
        block = audio[left:right].astype(np.float64)
        raw_rms = float(np.sqrt(np.mean(block*block))) if block.size else 0.
        a, b = max(0, center-window_size), min(len(audio), center)
        samples = np.zeros((window_size, audio.shape[1]), dtype=np.float64)
        start = a-(center-window_size)
        samples[start:start+b-a] = audio[a:b]
        # Average magnitudes, rather than cancelling opposite stereo phases.
        spectrum = np.abs(np.fft.rfft(samples*window[:, None], axis=0)).mean(axis=1)
        centroid = float(np.dot(spectrum, frequencies)/max(spectrum.sum(), 1e-20))
        rms.append(raw_rms)
        centroids.append(centroid if raw_rms >= gate else 0.)
    rms = np.asarray(rms)
    centroids = np.asarray(centroids)
    smooth_rms, smooth_centroid = np.zeros_like(rms), np.zeros_like(rms)
    last_rms, last_centroid, seen = 0., 0., False
    for i, (volume, centroid) in enumerate(zip(rms, centroids)):
        dt = times[i]-times[i-1] if i else frame_seconds
        tau = .04 if volume > last_rms else .12
        last_rms += (volume-last_rms)*(1-math.exp(-dt/tau))
        if volume >= gate:
            last_centroid = centroid if not seen else last_centroid+(centroid-last_centroid)*(1-math.exp(-dt/.12))
            seen = True
        smooth_rms[i], smooth_centroid[i] = last_rms, last_centroid
    active = rms >= gate
    valid = smooth_centroid[active]
    low, high = (float(valid.min()), float(valid.max())) if valid.size else (0., 0.)
    return dict(times=times.tolist(), rms=smooth_rms.tolist(), raw_rms=rms.tolist(),
        centroid_hz=smooth_centroid.tolist(), centroid_normalized=normalized(smooth_centroid, low, high).tolist(),
        centroid_min_hz=low, centroid_max_hz=high, gate_dbfs=gate_dbfs,
        frame_seconds=frame_seconds, active_frame_count=int(active.sum()),
        rms_peak=float(smooth_rms.max()), sample_rate=int(sr), frames=len(audio))


def normalize_arousal(rows,percentiles=None):
    valid = [r['arousal'] for r in rows if r.get('status') == 'ok' and isinstance(r.get('arousal'), (int, float)) and math.isfinite(r['arousal'])]
    low, high = ((float(v) for v in np.percentile(valid,percentiles,method='linear')) if percentiles else (min(valid),max(valid))) if valid else (None,None)
    for row in rows:
        row['x_normalized'] = float(normalized([row['arousal']], low, high)[0]) if row.get('status') == 'ok' and low is not None else None
    return dict(arousal_min=low, arousal_max=high, constant_position=.5,
        scope='this_stem_all_valid_bars',percentiles=list(percentiles) if percentiles else None, centroid_scope='this_stem_active_frames')
