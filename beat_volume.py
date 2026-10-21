"""Time-weighted beat means of cached linear RMS envelopes."""
import math
import numpy as np


def beat_volume_features(motion, beats, duration):
    times = np.asarray(motion['times'], dtype=float)
    rms = np.asarray(motion['rms'], dtype=float)
    if (not math.isfinite(duration) or duration <= 0 or times.ndim != 1 or rms.ndim != 1
            or len(times) < 2 or len(rms) != len(times)
            or not np.isfinite(times).all() or not np.isfinite(rms).all()
            or np.any(rms < 0) or np.any(np.diff(times) <= 0)
            or abs(times[0]) > 1e-6 or abs(times[-1] - duration) > 1e-5):
        raise ValueError('拍均音量需要覆盖原曲、严格递增的时间轴与有限非负 RMS。')
    beat_times = sorted({float(t) for t in beats if isinstance(t, (int, float))
                         and not isinstance(t, bool) and math.isfinite(t) and 0 <= t < duration})
    boundaries = np.asarray(sorted({0., duration, *beat_times}))
    # Causal feature samples end at their timestamp. Include quiet parts of
    # the beat in the average, and weight partial frame overlaps by duration.
    integral = np.r_[0., np.cumsum(np.diff(times) * rms[1:])]
    means = np.maximum(0., np.diff(np.interp(boundaries, times, integral)) / np.diff(boundaries))
    gate = 10 ** (motion.get('gate_dbfs', -55.) / 20)
    rows = []
    for i, (a, b) in enumerate(zip(boundaries[:-1], boundaries[1:])):
        value = float(means[i])
        rows.append({'index': i + 1, 'start_seconds': float(a), 'end_seconds': float(b),
                     'kind': 'leading' if beat_times and a < beat_times[0] else 'beat',
                     'status': 'ok' if value >= gate else 'silent',
                     'mean_rms': value, 'from_rms': float(means[i - 1]) if i else value,
                     'target_rms': value})
    return {'version': 1, 'mode': 'beat_average', 'source': 'motion.rms',
            'method': 'time_weighted_arithmetic_mean', 'include_silence': True,
            'units': 'linear_RMS_amplitude', 'transition': 'full_current_beat',
            'easing': 'smoothstep', 'anticipation': False, 'rows': rows}
