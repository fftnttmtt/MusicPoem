"""Shared original-song bars -> SW stems -> same-stem emotion and realtime features."""
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import tempfile
import time
import traceback
import numpy as np

from spectra_prediction import DEFAULTS, TAGS, make_spectra_bundle
from stem_features import realtime_features, normalize_arousal, GATE_DBFS
from stem_separation import STEMS, LABELS, sw, decode_audio, separate_source, release_accelerators

ROOT = Path(__file__).resolve().parent
PIPELINE_VERSION = 'stems-r33-v1'
CACHE_ROOT = ROOT/'spectra_runs'


def source_hash(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024*1024), b''):
            digest.update(block)
    return digest.hexdigest()


def detect_meter(mix, sr, device, model='final0'):
    from beat_core import get_tracker, build_analysis
    tracker, selected = get_tracker(model, device)
    try:
        beats, downbeats = tracker(mix, sr)
        return build_analysis(mix, sr, beats, downbeats, model=model, device=selected)
    finally:
        del tracker
        release_accelerators()


def create_tester(device):
    from backend import Tester, missing_files
    missing = missing_files()
    if missing:
        raise RuntimeError('缺少 Music2Emo/MERT 文件：'+', '.join(missing)+'；请先运行 download_models.bat。')
    return Tester(device)


def make_stem_plan(audio, sr, analysis, defaults=None):
    from acoustic_features import extract_features, foote_novelty
    from bar_context import extend_interval, inherit_short_leading
    d = {**DEFAULTS, **(defaults or {})}
    mono = np.asarray(audio, dtype=np.float32).mean(axis=1) if audio.ndim == 2 else audio
    features, times, step = extract_features(mono, sr)
    novelty = sum(w*foote_novelty(features[k], step, d['context_seconds']) for k,w in [('timbre',.45),('chroma',.35),('energy',.20)])
    rows = []
    for bar in analysis['segments']:
        a, b = bar['start_sample'], bar['end_sample']
        # New six-source mode always has exactly one result per original bar.
        extension = extend_interval(a,b,len(mono),sr,analysis['beat_samples'],times,novelty,
            target_seconds=max(d['target_seconds'], (b-a)/sr+1/sr), boundary_threshold=d['boundary_threshold'])
        row = {**bar, **extension, 'segment':bar['index'], 'start_seconds':a/sr, 'end_seconds':b/sr,
            'duration_seconds':(b-a)/sr, 'prediction_unit':'bar', 'prediction_source':'context',
            'independent_prediction_skipped':False, 'inherited_from_segment':None,
            'forced_split':False, 'source_kind':bar['kind']}
        row['prediction_start_seconds'] = row['prediction_start_sample']/sr
        row['prediction_end_seconds'] = row['prediction_end_sample']/sr
        row['target_rms'] = float(np.sqrt(np.mean(np.asarray(audio[a:b], dtype=np.float64)**2)))
        rows.append(row)
    inherit_short_leading(rows, sr)
    return dict(sample_rate=sr, num_samples=len(mono), offset_sample=0, prediction_unit='bar',
        segment_rows=rows, beat_analysis=analysis,
        parameters={**d, 'force_split_long_targets':False, 'context_scope':'same_stem_only'},
        diagnostic={'time_s':times.tolist(),'novelty':novelty.tolist()})


def predict_stem_rows(audio, sr, plan, tester, progress=None, gate_dbfs=GATE_DBFS, on_row=None):
    import soundfile as sf
    rows, cache = [], {}
    mono = audio.mean(axis=1) if audio.ndim == 2 else audio
    gate = 10**(gate_dbfs/20)
    with tempfile.TemporaryDirectory(prefix='spectra_stem_emotion_') as tmp:
        wav = Path(tmp)/'context.wav'
        for index, item in enumerate(plan['segment_rows']):
            row = dict(item)
            a, b = row['prediction_start_sample'], row['prediction_end_sample']
            if row['target_rms'] < gate and not row.get('independent_prediction_skipped'):
                prediction = dict(status='silent', scores=[], valence=None, arousal=None)
            else:
                if (a,b) not in cache:
                    try:
                        if b-a < math.ceil(3*sr):
                            raise ValueError('同一分轨的预测上下文不足模型要求的3秒。')
                        sf.write(wav, mono[a:b], sr, subtype='FLOAT')
                        prediction = {**tester.predict(wav, threshold=.5), 'status':'ok'}
                        if not all(isinstance(prediction.get(k), (int,float)) and math.isfinite(prediction[k]) for k in ['arousal','valence']):
                            raise ValueError('情绪模型返回了无效的唤醒度或愉悦度。')
                        prediction['scores'] = [s for s in prediction.get('scores',[]) if s.get('tag') in TAGS
                            and isinstance(s.get('score'),(int,float)) and math.isfinite(s['score']) and 0<=s['score']<=1]
                        if not prediction['scores']:
                            raise ValueError('情绪模型没有返回九个有效标签的分数。')
                    except Exception as exc:
                        prediction = dict(status='error', scores=[], valence=None, arousal=None,
                            error=f'{type(exc).__name__}: {exc}', error_traceback=traceback.format_exc())
                    cache[a,b] = prediction
                prediction = cache[a,b]
            row.update(deepcopy(prediction))
            row['padding_seconds'] = 0.
            rows.append(row)
            if on_row:
                on_row(row)
            if progress:
                progress(index+1, len(plan['segment_rows']))
    return {**plan, 'segments':rows}


def attach_track(result, motion, stem_id, defaults=None):
    bundle = make_spectra_bundle(result, defaults)
    raw = {r['segment']:r for r in result['segments']}
    for row in bundle['segments']:
        source = raw[row['segment']]
        row.update(arousal=source.get('arousal'),valence=source.get('valence'),target_rms=source['target_rms'],
            prediction_start_seconds=source['prediction_start_seconds'], prediction_end_seconds=source['prediction_end_seconds'],
            error_traceback=source.get('error_traceback'),
            context_info={k:source.get(k) for k in ['left_context_seconds','right_context_seconds','forced_boundary_crossings',
                'minimum_extension_required','independent_prediction_skipped','inherited_from_segment','stop_reason']})
        row['dominant_tag'] = max(row['tag_scores'], key=row['tag_scores'].get) if row['status']=='ok' and row['tag_scores'] else None
    normalization = normalize_arousal(bundle['segments'],percentiles=(defaults or {}).get('coordinate_percentiles'))
    normalization.update(centroid_min_hz=motion['centroid_min_hz'],centroid_max_hz=motion['centroid_max_hz'])
    return dict(id=stem_id,label=LABELS[stem_id],segments=bundle['segments'],transition=bundle['transition'],
        mapping=bundle['mapping'],normalization=normalization,motion=motion)


def validate_separation(output, sr, frames):
    import soundfile as sf
    for name in ['mixture',*STEMS,'preview/mixture']:
        path = Path(output)/(name+'.wav')
        info = sf.info(path)
        if info.samplerate != sr or info.frames != frames or info.channels != 2:
            raise ValueError(f'{name} 分轨未与原曲逐采样对齐。')


def cached_bundle(folder):
    try:
        data = json.loads((folder/'stems.spectra.json').read_text(encoding='utf-8'))
        if data.get('pipeline_version') != PIPELINE_VERSION or len(data.get('stems',[])) != 6:
            return None
        if any(row.get('prediction_status')=='error' for track in data['stems'] for row in track['segments']):
            return None  # retry transient inference failures rather than pinning them forever
        validate_separation(folder, data['audio']['sample_rate'], data['audio']['frames'])
        if not (folder/'preview/mixture.wav').is_file():
            return None
        return data
    except (OSError, ValueError, KeyError, RuntimeError):
        return None


def predict_stems_file(path, *, prediction_unit='bar', progress=None, resources=None, audio_name=None,
                       sha256=None, sw_weights=None, chunk_seconds=0., amp=True, cache_root=None):
    import soundfile as sf
    progress = progress or (lambda message, fraction: None)
    if prediction_unit != 'bar':
        raise ValueError('六声部模式固定使用原曲小节。')
    started = time.perf_counter()
    digest = sha256 or source_hash(path)
    options = dict(pipeline=PIPELINE_VERSION, source=digest, chunk_seconds=chunk_seconds,amp=bool(amp),
        checkpoint_sha256=sw.WEIGHT_SHA256, defaults=DEFAULTS)
    run_id = hashlib.sha256(json.dumps(options,sort_keys=True).encode()).hexdigest()[:32]
    folder = Path(cache_root or CACHE_ROOT)/run_id
    cached = cached_bundle(folder)
    if cached:
        progress('已复用这首歌曲的六声部分离与情绪缓存', 1.)
        return {**cached, 'cache_hit':True}
    if resources is not None:
        resources.clear()
    release_accelerators()
    progress('解码整首歌曲，建立统一时间轴…', .01)
    mix = decode_audio(path, start=0., duration=0., sample_rate=sw.SAMPLE_RATE, channels=2)
    sr, frames = sw.SAMPLE_RATE, len(mix)
    if frames < 3*sr:
        raise ValueError('整首歌曲不足3秒，无法使用当前情绪模型。')
    progress('Beat This! final0：检测原曲节拍与小节…', .03)
    analysis = detect_meter(mix, sr, DEFAULTS['device'])
    folder.mkdir(parents=True, exist_ok=True)
    try:
        validate_separation(folder,sr,frames)
        separation_ready=(folder/'preview/mixture.wav').is_file()
    except (OSError,RuntimeError,ValueError):
        separation_ready=False
    if not separation_ready:
        separate_source(mix,folder,device=DEFAULTS['device'],weights=sw_weights,chunk_seconds=chunk_seconds,amp=amp,
            progress=lambda message,fraction:progress(message,.08+.32*fraction))
    validate_separation(folder,sr,frames)
    release_accelerators()
    bars = [dict(id=r['index'],label=r['label'],kind=r['kind'],bar_number=r.get('bar_number'),
        start_seconds=r['start'],end_seconds=r['end']) for r in analysis['segments']]
    tracks, tester = [], None
    try:
        for index, stem_id in enumerate(STEMS):
            progress(f'{LABELS[stem_id]}：提取实时音量与频谱质心…', .41+.57*index/6)
            audio, rate = sf.read(folder/(stem_id+'.wav'),dtype='float32',always_2d=True)
            motion = realtime_features(audio,rate)
            plan = make_stem_plan(audio,sr,analysis)
            if motion['active_frame_count']:
                if tester is None:
                    progress('加载 Music2Emo / MERT，逐分轨预测小节情绪…', .41+.57*index/6)
                    tester = create_tester(DEFAULTS['device'])
                result = predict_stem_rows(audio,sr,plan,tester,
                    progress=lambda done,total:progress(f'{LABELS[stem_id]}：小节情绪 {done}/{total}',.41+.57*(index+done/max(1,total))/6))
            else:
                result = {**plan,'segments':[{**r,'status':'silent','scores':[],'arousal':None,'valence':None} for r in plan['segment_rows']]}
            tracks.append(attach_track(result,motion,stem_id))
    finally:
        del tester
        release_accelerators()
    volume_reference = max((t['motion']['rms_peak'] for t in tracks), default=0.)
    bundle = dict(schema='spectra-stems-v1', pipeline_version=PIPELINE_VERSION, run_id=run_id, cache_hit=False,
        prediction_unit='bar', defaults=deepcopy(DEFAULTS),
        audio=dict(name=audio_name or Path(path).name,sha256=digest,duration_seconds=frames/sr,
            sample_rate=sr,frames=frames,playback_url=f'/api/stems/{run_id}/mixture.wav'),
        beats=analysis['beats'],downbeats=analysis['downbeats'],bars=bars,stems=tracks,
        volume=dict(reference_rms=volume_reference,scale='shared_all_six_stems',mapping='area proportional to smoothed short-time RMS',gate_dbfs=GATE_DBFS),
        semantics=dict(x='per-stem arousal min/max across valid bars',y='per-stem centroid min/max across active frames; high frequencies at top',
            body_color='previous HSV mapper applied separately to each stem',outline='dominant tag original outline',background='black',
            target='one original bar per source, no long-bar subdivision',context='same source only; minimum 3s, target 6s'),
        separation=dict(checkpoint_sha256=sw.WEIGHT_SHA256,config_sha256=sw.CONFIG_SHA256,source_revision=sw.UPSTREAM_COMMIT),
        warnings=analysis.get('warnings',[]),elapsed_seconds=round(time.perf_counter()-started,3))
    target = folder/'stems.spectra.json'
    temp = target.with_suffix('.json.tmp')
    temp.write_text(json.dumps(bundle,ensure_ascii=False,allow_nan=False),encoding='utf-8')
    temp.replace(target)
    progress('六声部小节情绪与实时图形数据已完成',1.)
    return bundle
