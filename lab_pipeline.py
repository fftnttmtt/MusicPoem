"""Persistent, explicitly staged experiments. No stage silently runs a model."""
from copy import deepcopy
import csv
import hashlib
import io
from itertools import combinations
import json
import math
import os
from pathlib import Path
import tempfile
import threading
import time
import traceback

import numpy as np
from spectra_prediction import DEFAULTS, TAGS, map_prediction_colors, make_spectra_bundle
from stem_separation import STEMS, LABELS, decode_audio, separate_source, release_accelerators, sw
from stem_pipeline import detect_meter, create_tester, make_stem_plan, predict_stem_rows, attach_track
from stem_features import realtime_features
from beat_centroid import beat_centroid_features
from beat_volume import beat_volume_features
from pitch_features import PITCH_REVISION, PITCH_SETTINGS, PITCH_RANGES, estimate_pitch, pitch_features
from melodia_pitch import MELODIA_REVISION, MELODIA_SETTINGS, MELODIA_RANGES, estimate_melodia, pitch_engine

ROOT = Path(__file__).resolve().parent
STAGES = ('meter', 'separation', 'features', 'emotion', 'mapping')
OVERLAP_COMBINATIONS=[tuple(c) for n in range(2,len(STEMS)+1) for c in combinations(STEMS,n)]
OVERLAP_REVISION=1
def overlap_key(stems): return '+'.join(stems)
LEGACY_GEOMETRY_DEFAULTS={'shape_p':1.,'shape_q':1.,'shape_r_low':-2.,'shape_r_high':2.,
    'orientation_v_low':3.,'orientation_v_high':7.,'rectangle_aspect':1.5}
OUTLINE_MULTIPLIERS={'bass':1.,'drums':1.2,'other':1.,'vocals':1.,'guitar':.6,'piano':1.}
GEOMETRY_DEFAULTS={'outline_arousal_scale':1.5,'outline_enabled':True,'rotation_enabled':True,'foote_motion_enabled':True,
    'texture_enabled':True,'texture_paper_strength':.3,'texture_pigment_strength':.35,'texture_edge_strength':.25,
    'drums_outline_gap':6.,'drums_inner_ratio':.35,
    'outline_bass_enabled':False,'outline_drums_enabled':True,'outline_other_enabled':False,
    'outline_vocals_enabled':False,'outline_guitar_enabled':True,'outline_piano_enabled':True,
    **{'outline_'+s+'_multiplier':v for s,v in OUTLINE_MULTIPLIERS.items()}}
DRAW_ORDER=['bass','guitar','piano','other','drums','vocals']
ROTATION_DIRECTIONS={'bass':-1,'guitar':-1,'drums':1,'piano':1,'other':1,'vocals':0}
INSTRUMENT_SHAPES={
    'bass':{'kind':'rectangle','aspect':3.},'drums':{'kind':'diamond','rotation_degrees':45.},
    'other':{'kind':'semicircle'},'vocals':{'kind':'circle'},
    'guitar':{'kind':'triangle_up','aspect':.8},'piano':{'kind':'square'}}
PARAMETERS = {**deepcopy(DEFAULTS), 'chunk_seconds': 0., 'amp': True, 'sw_weights': '',
              'gate_dbfs': -55., 'frame_seconds': .02, 'overlap_colors_enabled':False, 'pitch_confidence_threshold':.6, 'pitch_method':'hybrid', 'melodia_high_pitch_bias':4., 'melodia_voicing_tolerance':1.2, 'melodia_confidence_threshold':0., 'coordinate_percentiles':[5,95], **LEGACY_GEOMETRY_DEFAULTS, **GEOMETRY_DEFAULTS}
PRESENTATION_DEFAULTS={'size_percent':100,'pitch_mode':'beat_summary','overlap_preview':True,
    'guides':True,'clicks':True,'follow':True,'video_resolution':1080,'video_fps':30}
EDITABLE = {'device','beat_model','chunk_seconds','amp','sw_weights','gate_dbfs','frame_seconds','overlap_colors_enabled','pitch_confidence_threshold','pitch_method','melodia_high_pitch_bias','melodia_voicing_tolerance','melodia_confidence_threshold',
    'target_seconds','boundary_threshold','context_seconds','saturation_k','value_k','hue_gamma',
    'saturation_gamma','value_gamma','use_song_mean_centers','enhance_sv','enhancement_strength',
    'percentile_low','percentile_high','max_gain','saturation_range','value_range',
    'transition_strength','boundary_radius','max_transition_fraction',*LEGACY_GEOMETRY_DEFAULTS,*GEOMETRY_DEFAULTS}
DEPENDENTS = {'meter': ('features','emotion','mapping'), 'separation': ('features','emotion','mapping'),
              'features': ('emotion','mapping'), 'emotion': ('mapping',), 'mapping': ()}
PREREQUISITES = {'meter': (), 'separation': ('meter',), 'features': ('meter','separation'),
                 'emotion': ('features',), 'mapping': ('emotion',)}
_JSON_LOCK = threading.RLock()


def read_json(path):
    # Windows readers may deny rename/delete until their handle is closed.
    # Coordinate our polling readers with writers in this server process.
    with _JSON_LOCK:
        return json.loads(Path(path).read_text(encoding='utf-8'))


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload=json.dumps(value,ensure_ascii=False,allow_nan=False,indent=2)
    with _JSON_LOCK:
        # A fixed .json.tmp can be overwritten by another writer/process.
        fd,name=tempfile.mkstemp(prefix=path.name+'.',suffix='.tmp',dir=path.parent)
        temp=Path(name)
        try:
            with os.fdopen(fd,'w',encoding='utf-8') as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            for attempt in range(12):
                try:
                    os.replace(temp,path)
                    return
                except PermissionError as exc:
                    transient=getattr(exc,'winerror',None) in (5,32,33) or os.name=='nt'
                    if not transient:
                        raise
                    if attempt==11:
                        raise PermissionError(f'保存实验文件失败：{path}。文件持续被占用或无写入权限。'
                            '请关闭重复运行的实验台及占用此文件的程序，检查文件是否只读，然后重新运行；已有结果未覆盖。') from exc
                    time.sleep(min(.025*2**attempt,.25))
        finally:
            try:
                temp.unlink(missing_ok=True)
            except OSError:
                pass  # cleanup must never mask the original save error


def write_csv(path, rows, fields):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=fields,extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)


def validate_parameters(patch, previous=None):
    if not isinstance(patch,dict) or set(patch)-EDITABLE:
        raise ValueError('参数包含不支持的字段。')
    p={**deepcopy(PARAMETERS),**deepcopy(previous or {}),**patch}
    if p['device'] not in ('cpu','cuda') or p['beat_model'] not in ('final0','small0'):
        raise ValueError('设备或节拍模型无效。')
    if p['pitch_method'] not in ('hybrid','melodia','pyin'):
        raise ValueError('音高方法无效。')
    if not isinstance(p['sw_weights'],str) or len(p['sw_weights'])>4096:
        raise ValueError('权重路径无效。')
    for key in ('amp','enhance_sv','use_song_mean_centers','overlap_colors_enabled',*(k for k in GEOMETRY_DEFAULTS if k.endswith('_enabled'))):
        if not isinstance(p[key],bool):
            raise ValueError(f'{key} 须为开关。')
    bounds={'melodia_voicing_tolerance':(-1,1.4),'melodia_high_pitch_bias':(0,6),'melodia_confidence_threshold':(0,1000),'pitch_confidence_threshold':(0,1),'chunk_seconds':(0,4),'gate_dbfs':(-100,-5),'frame_seconds':(.01,.2),
        'target_seconds':(3,120),'boundary_threshold':(0,1),'context_seconds':(.1,20),
        'saturation_k':(0,40),'value_k':(0,40),'hue_gamma':(.1,10),
        'saturation_gamma':(.1,10),'value_gamma':(.1,10),'enhancement_strength':(0,1),
        'percentile_low':(0,49),'percentile_high':(51,100),'max_gain':(1,10),
        'transition_strength':(0,50),'boundary_radius':(.01,5),'max_transition_fraction':(0,1),
        'shape_p':(0,10),'shape_q':(0,10),'shape_r_low':(-100,100),'shape_r_high':(-100,100),
        'orientation_v_low':(1,9),'orientation_v_high':(1,9),
        'rectangle_aspect':(.2,5),'outline_arousal_scale':(.01,10),
        'texture_paper_strength':(0,1),'texture_pigment_strength':(0,1),'texture_edge_strength':(0,1),
        'drums_outline_gap':(.5,30),'drums_inner_ratio':(.1,.8),
        **{'outline_'+s+'_multiplier':(0,10) for s in STEMS}}
    for key,(a,b) in bounds.items():
        x=p[key]
        if isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) or not a<=x<=b:
            raise ValueError(f'{key} 须在 {a}–{b} 之间。')
    if p['chunk_seconds'] not in (0,2,4):
        raise ValueError('SW 计算块须为原配置、2秒或4秒。')
    if p['shape_r_low']>=p['shape_r_high'] or p['orientation_v_low']>=p['orientation_v_high']:
        raise ValueError('几何映射的两组下阈值均须小于对应上阈值。')
    for key in ('saturation_range','value_range'):
        x=p[key]
        if not isinstance(x,list) or len(x)!=2 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in x) or not 0<=x[0]<=x[1]<=1:
            raise ValueError(f'{key} 须为 0–1 内递增的两个数。')
    return p


def affected_stages(changes):
    stages=set()
    for key in changes:
        if key in GEOMETRY_DEFAULTS or key in LEGACY_GEOMETRY_DEFAULTS: continue  # presentation-only; never invalidate model results
        elif key=='overlap_colors_enabled': stages.add('emotion')
        elif key=='device': stages.update(('meter','separation','emotion'))
        elif key=='beat_model': stages.add('meter')
        elif key in ('chunk_seconds','amp','sw_weights'): stages.add('separation')
        elif key in ('gate_dbfs','frame_seconds','target_seconds','boundary_threshold','context_seconds'): stages.add('features')
        else: stages.add('mapping')
    for stage in tuple(stages): stages.update(DEPENDENTS[stage])
    return stages


def validate_presentation(patch):
    if not isinstance(patch,dict) or set(patch)-set(PRESENTATION_DEFAULTS):
        raise ValueError('预览设置包含不支持的字段。')
    p={**PRESENTATION_DEFAULTS,**patch}
    for key in ('overlap_preview','guides','clicks','follow'):
        if not isinstance(p[key],bool):raise ValueError(f'{key} 须为开关。')
    size=p['size_percent']
    if isinstance(size,bool) or not isinstance(size,(int,float)) or not math.isfinite(size) or not 10<=size<=300:
        raise ValueError('尺寸须在10%–300%内。')
    if p['pitch_mode'] not in ('beat_summary','continuous') or p['video_resolution'] not in (720,1080) or p['video_fps'] not in (30,60):
        raise ValueError('音高预览模式或视频选项无效。')
    return p


def waveform(audio,sr,max_points=2400):
    step=max(1,math.ceil(len(audio)/max_points))
    values=np.max(np.abs(audio),axis=1) if audio.ndim==2 else np.abs(audio)
    positions=np.arange(0,len(values),step)
    return {'times':(positions/sr).tolist(),'peaks':np.maximum.reduceat(values,positions).tolist(),
            'duration_seconds':len(audio)/sr,'units':'linear peak amplitude; no independent normalization'}


def foote_motion_curve(plan):
    d=plan.get('diagnostic',{});times=d.get('time_s',[]);values=d.get('novelty',[])
    if len(times)<2 or len(times)!=len(values) or any(not isinstance(t,(int,float)) or not math.isfinite(t) or t<0 for t in times) or any(b<=a for a,b in zip(times,times[1:])) or any(not isinstance(v,(int,float)) or not math.isfinite(v) for v in values):return None
    return {'times':list(times),'values':[max(0.,v) for v in values],'source':'same_stem_cached_Foote'}


def bundle_scene_revision(bundle):
    value={k:bundle[k] for k in ('audio','stems','volume','bars')}
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def geometry_metadata(parameters):
    return {'revision':47,'type':'instrument_identity','parameters':{k:parameters[k] for k in GEOMETRY_DEFAULTS},
        'instrument_shapes':deepcopy(INSTRUMENT_SHAPES),'default_size_percent':100,'size_multiplier':9,'size_reference':'R52 100% = R51 300%','volume_release_seconds':.35,
        'renderer_revision':56,'semicircle_base_pose':'arc down, straight edge above; high-valence target',
        'volume_envelope':{'method':'causal Hann smoothing of finite peak release','drums_smoothing_seconds':.06,'other_smoothing_seconds':.10,'target_step_seconds':.01,'continuity':'continuous radius and rate; no positive-radius cutoff'},
        'input_range':[1,9],'orientation':'instrument base pose plus valence rotation',
        'draw_order_back_to_front':list(DRAW_ORDER),'layer_order_front_to_back':list(reversed(DRAW_ORDER)),
        'rotation':{'enabled':parameters['rotation_enabled'],'percentiles':[10,90],'method':'percentile_linear',
            'scope':'each stem valid bar valence','degrees_low':180,'degrees_high':0,
            'direction_when_valence_rises':{s:('clockwise' if d>0 else 'counterclockwise' if d<0 else 'none') for s,d in ROTATION_DIRECTIONS.items()},
            'transition':'interpolate target angles over the full current bar; no anticipation',
            'clamp':True,'constant_valence':'upright'},
        'area':'all outer shapes have area pi * volume_radius^2; centered at area centroid',
        'mean_statistics':'retained for inspection only; no effect on shape identity',
        'outline':parameters['outline_enabled'],'outline_color':'#000000',
        'outline_instruments':{s:parameters['outline_'+s+'_enabled'] for s in STEMS},
        'outline_multipliers':{s:parameters['outline_'+s+'_multiplier'] for s in STEMS},
        'material':{'revision':1,'style':'matte_paint_on_fine_paper','seed':'fixed per instrument; object-local pattern; static background','overlap':'apply material over predicted mixed-audio color'},
        'drums_outline':{'lines':2,'outer':'arousal driven','inner_ratio':parameters['drums_inner_ratio'],'gap_540p':parameters['drums_outline_gap'],'tiny_shape':'compress both widths and gap inside silhouette'},
        'outline_formula':'outline_arousal_scale * outline_multipliers[stem] * raw_arousal * viewport_height / 540; inset, capped to inradius',
        'transition':'instrument family stays fixed; border and rotation interpolate over full current bar; no early shift'}


def attach_geometry_reference(track):
    rows=track['segments']
    valid=[r for r in rows if r.get('status')=='ok' and all(
        isinstance(r.get(k),(int,float)) and not isinstance(r[k],bool) and math.isfinite(r[k]) for k in ('valence','arousal'))]
    def mean(key):
        if not valid: return None
        if all(r[key]==valid[0][key] for r in valid): return valid[0][key]
        return sum(r[key] for r in valid)/len(valid)
    a,b=mean('valence'),mean('arousal')
    valid_ids={id(r) for r in valid}
    reference={'valence_mean':a,'arousal_mean':b,'valid_segments':len(valid),'total_segments':len(rows),
        'complete':all(r.get('prediction_status',r.get('status'))=='silent' or id(r) in valid_ids for r in rows),
        'method':'arithmetic_mean_of_valid_bar_predictions','equality':'high'}
    for row in rows:
        if id(row) not in valid_ids: row['geometry_kind']=None;continue
        row['geometry_kind']=INSTRUMENT_SHAPES[track['id']]['kind']
    track['shape_reference']=reference
    track['shape_identity']=deepcopy(INSTRUMENT_SHAPES[track['id']])
    if valid:
        low,high=(float(v) for v in np.percentile([r['valence'] for r in valid],[10,90],method='linear'))
    else: low,high=None,None
    track['rotation_reference']={'method':'percentile_linear','percentiles':[10,90],
        'valence_low':low,'valence_high':high,'valid_segments':len(valid),'total_segments':len(rows),
        'complete':reference['complete'],'constant':not valid or high-low<=1e-9}
    return reference


class Lab:
    def __init__(self,root=None):
        self.root=Path(root or ROOT/'spectra_lab').resolve()
        self.root.mkdir(parents=True,exist_ok=True)
        self.lock=threading.RLock()
        self._scene_checked=set()

    def defaults(self):
        path=self.root/'defaults.json'
        if not path.is_file():
            return {'schema':'spectra-lab-defaults-v1','parameters':deepcopy(PARAMETERS),
                    'presentation':deepcopy(PRESENTATION_DEFAULTS),'custom':False}
        value=read_json(path)
        if not isinstance(value,dict) or not isinstance(value.get('parameters'),dict):
            raise ValueError('默认参数文件无效，请检查spectra_lab/defaults.json。')
        return {'schema':'spectra-lab-defaults-v1',
                'parameters':validate_parameters({k:v for k,v in value['parameters'].items() if k in EDITABLE}),
                'presentation':validate_presentation(value.get('presentation',{})),
                'custom':True,'updated':value.get('updated')}

    def save_defaults(self,options):
        if not isinstance(options,dict):raise ValueError('默认参数请求无效。')
        value={'schema':'spectra-lab-defaults-v1','parameters':validate_parameters(options.get('parameters',{})),
               'presentation':validate_presentation(options.get('presentation',{})),'updated':time.time()}
        write_json(self.root/'defaults.json',value)
        return {**value,'custom':True}

    def folder(self,run_id):
        import re
        if not re.fullmatch(r'[0-9a-f]{32}',run_id): raise ValueError('实验编号无效。')
        folder=self.root/run_id
        if not (folder/'manifest.json').is_file(): raise FileNotFoundError('实验不存在。')
        return folder

    def manifest(self,run_id):
        m=read_json(self.folder(run_id)/'manifest.json')
        m['parameters']={**deepcopy(PARAMETERS),**m['parameters']}
        if m.get('lab_revision',34)<35 and m['stages']['mapping']['status']=='ready':
            m['stages']['mapping'].update(status='stale',reason='升级后请运行情绪步骤以生成整曲背景色，再映射。')
        elif m.get('lab_revision',34)<37 and m['stages']['mapping']['status']=='ready':
            m['stages']['mapping'].update(status='stale',reason='升级动态背景与拍均质心：点一键补齐原曲小节背景，已有六声部预测会复用。')
        elif m.get('pitch_revision',0)<PITCH_REVISION and m['stages']['mapping']['status']=='ready':
            m['stages']['mapping'].update(status='stale',reason='升级pYIN音高与P5/P95坐标：运行第5步映射补算音高，已有情绪预测全部复用。')
        elif m.get('melody_revision',0)<MELODIA_REVISION and m['stages']['mapping']['status']=='ready':
            m['stages']['mapping'].update(status='stale',reason='R50：运行第5步映射以启用Melodia；只补算音高，分轨、节拍及情绪复用。')
        elif m.get('geometry_revision',0)<47 and m['stages']['mapping']['status']=='ready':
            m['stages']['mapping'].update(status='stale',reason='升级音高预览与P5/P95坐标标尺：仅需重跑第5步映射，已有模型结果全部复用。')
        elif m.get('volume_revision',0)<41 and m['stages']['mapping']['status']=='ready':
            m['stages']['mapping'].update(status='stale',reason='升级非鼓声部拍均音量：仅需重跑第5步映射，已有模型预测全部复用。')
        if run_id not in self._scene_checked and m['stages']['mapping']['status']=='ready':
            path=self.folder(run_id)/'mapped.json'
            if path.is_file():
                bundle=read_json(path)
                if not bundle.get('scene_revision'):
                    bundle['scene_revision']=bundle_scene_revision(bundle);write_json(path,bundle)
                self._scene_checked.add(run_id)
        return m

    def log(self,folder,message,**extra):
        with (folder/'process.log').open('a',encoding='utf-8') as f:
            f.write(json.dumps({'time':time.strftime('%Y-%m-%d %H:%M:%S'),'message':message,**extra},ensure_ascii=False)+'\n')

    def list_runs(self):
        runs=[]
        for path in self.root.glob('*/manifest.json'):
            try:
                m=read_json(path)
                runs.append({k:m[k] for k in ('id','name','updated','duration_seconds')})
            except (OSError,ValueError,KeyError): pass
        return sorted(runs,key=lambda x:x['updated'],reverse=True)

    def snapshot(self,run_id):
        with self.lock:
            folder=self.folder(run_id)
            m=self.manifest(run_id)
            # A running/interrupted stage is never advertised as a valid result.
            artifacts=[]
            for path in sorted(folder.rglob('*')):
                if not path.is_file() or path.suffix not in ('.json','.csv','.wav','.log','.mp4'): continue
                relative=path.relative_to(folder).as_posix()
                group=relative.split('/')[0]
                stage={'meter.json':'meter','bars.csv':'meter','separated':'separation','previews':'separation',
                    'motion':'features','plans':'features','emotions':'emotion','mapped.json':'mapping',
                    'colors.csv':'mapping','beat_motion':'mapping','beat_volume':'mapping','song_prediction.json':'emotion',
                    'background_prediction.json':'emotion','background_prediction.csv':'emotion',
                    'pitch_raw':'mapping','pitch_cache':'mapping','pitch':'mapping','background.colors.json':'mapping','overlap_predictions':'emotion','overlap_colors.json':'mapping'}.get(group)
                artifacts.append({'path':relative,'bytes':path.stat().st_size,'stage':stage,
                    'current':group!='pitch_cache' and (stage is None or m['stages'][stage]['status'] in ('ready','partial')) and (group not in ('overlap_predictions','overlap_colors.json') or m['parameters']['overlap_colors_enabled'])})
            m['artifacts']=artifacts
            m['directory']=str(folder)
            m['logs']=(folder/'process.log').read_text(encoding='utf-8').splitlines()[-80:]
            m['busy']=any(s['status']=='running' for s in m['stages'].values())
            return m

    def upload(self,path,name,digest,report):
        import soundfile as sf
        run_id=digest[:32]
        folder=self.root/run_id
        if (folder/'manifest.json').is_file():
            report('已恢复这首歌曲的实验记录',1.)
            return self.snapshot(run_id)
        profile=self.defaults()
        report('解码原曲，建立实验时间轴（尚未运行模型）',.1)
        audio=decode_audio(path,start=0.,duration=0.,sample_rate=sw.SAMPLE_RATE,channels=2)
        sr=sw.SAMPLE_RATE
        if len(audio)<3*sr: raise ValueError('整首音乐至少需要3秒。')
        folder.mkdir(parents=True,exist_ok=True)
        sf.write(folder/'source.wav',audio,sr,subtype='FLOAT')
        peak=float(np.max(np.abs(audio)))
        gain=min(1.,.98/max(peak,1e-12))
        sf.write(folder/'listen.wav',audio*gain,sr,subtype='PCM_16')
        write_json(folder/'waveform.json',waveform(audio,sr))
        now=time.time()
        m={'schema':'spectra-lab-v1','lab_revision':35,'id':run_id,'name':name,'sha256':digest,'created':now,'updated':now,
            'sample_rate':sr,'frames':len(audio),'duration_seconds':len(audio)/sr,
            'preview_gain':gain,'parameters':deepcopy(profile['parameters']),'presentation':deepcopy(profile['presentation']),
            'stages':{s:{'status':'pending'} for s in STAGES}}
        write_json(folder/'manifest.json',m)
        self.log(folder,'导入原曲；模型尚未运行',source_name=name,sha256=digest)
        report('原曲已导入，可先运行节拍分析',1.)
        return self.snapshot(run_id)

    def configure(self,m,patch):
        p=validate_parameters(patch,m['parameters'])
        changed=[k for k in patch if p[k]!=m['parameters'][k]]
        for stage in affected_stages(changed):
            previous=m['stages'][stage]
            if previous['status']!='pending':
                m['stages'][stage]={**previous,'status':'stale','reason':'参数已改变：'+', '.join(changed)}
        m['parameters']=p
        if any(k in GEOMETRY_DEFAULTS for k in changed) and m['stages']['mapping']['status']=='ready':
            path=self.folder(m['id'])/'mapped.json'
            if path.is_file():
                bundle=read_json(path)
                bundle['geometry']=geometry_metadata(p)
                bundle['defaults'].update({k:p[k] for k in GEOMETRY_DEFAULTS})
                bundle.setdefault('movement',{})['foote_motion_enabled']=p['foote_motion_enabled']
                write_json(path,bundle)
        if changed: self.log(self.folder(m['id']),'应用参数',changed={k:p[k] for k in changed})
        return changed

    def action(self,run_id,options,report):
        folder=self.folder(run_id)
        m=self.manifest(run_id)
        stage=options.get('stage')
        if stage=='all': return self.run_all(run_id,options,report)
        if stage=='overlap': return self.predict_visible_overlaps(run_id,options,report)
        if stage not in (*STAGES,'configure'): raise ValueError('未知实验步骤。')
        presentation=validate_presentation(options['presentation']) if 'presentation' in options else None
        self.configure(m,options.get('parameters',{}))
        if presentation is not None:m['presentation']=presentation
        m['updated']=time.time()
        write_json(folder/'manifest.json',m)
        if stage=='configure': return self.snapshot(run_id)
        for needed in PREREQUISITES[stage]:
            if m['stages'][needed]['status'] not in ('ready','partial'):
                raise ValueError(f'请先完成或重跑 {needed}，当前为 {m["stages"][needed]["status"]}。')
        # Reject invalid subset options before changing any stage state.
        if stage=='emotion':
            selected=options.get('stems',list(STEMS))
            if not isinstance(selected,list) or not selected or any(s not in STEMS for s in selected):
                raise ValueError('至少选择一个有效声部。')
            count=len(read_json(folder/'meter.json')['segments'])
            a,b=options.get('bar_start',1),options.get('bar_end',count)
            if isinstance(a,bool) or isinstance(b,bool) or not isinstance(a,int) or not isinstance(b,int) or not 1<=a<=b<=count:
                raise ValueError(f'片段序号范围须为 1–{count}。')
        old_status=m['stages'][stage]['status']
        for downstream in DEPENDENTS[stage]:
            if m['stages'][downstream]['status']!='pending':
                m['stages'][downstream]['status']='stale'
                m['stages'][downstream]['reason']=f'{stage} 已重新运行'
        m['stages'][stage]={'status':'running','started':time.time()}
        write_json(folder/'manifest.json',m)
        self.log(folder,'开始步骤',stage=stage,parameters=m['parameters'])
        def progress(message,fraction=0.):
            report(message,float(fraction))
            self.log(folder,message,stage=stage,progress=float(fraction))
        try:
            detail=getattr(self,'run_'+stage)(folder,m,options,progress,old_status) or {}
            m['stages'][stage].update(status=detail.pop('status','ready'),finished=time.time(),**detail)
            self.log(folder,'步骤完成',stage=stage,summary=m['stages'][stage])
        except Exception as exc:
            error={'stage':stage,'message':f'{type(exc).__name__}: {exc}','traceback':traceback.format_exc()}
            write_json(folder/'errors'/(stage+'.json'),error)
            m['stages'][stage].update(status='error',error=error['message'])
            self.log(folder,'步骤失败',stage=stage,error=error['message'],traceback=error['traceback'])
            raise
        finally:
            m['updated']=time.time()
            write_json(folder/'manifest.json',m)
            release_accelerators()
        return self.snapshot(run_id)

    def run_all(self,run_id,options,report):
        """Serial, resumable full-song execution, independent of the trial subset."""
        self.action(run_id,{'stage':'configure','parameters':options.get('parameters',{}),
            **({'presentation':options['presentation']} if 'presentation' in options else {})},report)
        folder=self.folder(run_id)
        self.log(folder,'一键执行全部过程；六声部全部片段，复用当前有效步骤')
        for i,stage in enumerate(STAGES):
            m=self.manifest(run_id)
            ready=m['stages'][stage]['status']=='ready'
            markers={'meter':['meter.json'],'separation':[f'previews/{s}.wav' for s in STEMS]+[f'separated/{s}.wav' for s in STEMS],
                'features':[f'{group}/{s}.json' for group in ('motion','plans') for s in STEMS],
                'emotion':['song_prediction.json','background_prediction.json']+[f'emotions/{s}.json' for s in STEMS],
                'mapping':['mapped.json','colors.csv']}
            ready=ready and all((folder/p).is_file() for p in markers[stage])
            if stage=='emotion':
                ready=ready and m['stages'][stage].get('song_status')=='ok' and m['stages'][stage].get('background_status')=='ok'
            if ready:
                report(f'{i+1}/{len(STAGES)} · 复用已完成的 {stage}',(i+1)/len(STAGES))
                self.log(folder,'一键执行复用步骤',stage=stage)
                continue
            action={'stage':stage}
            if stage=='emotion': action.update(stems=list(STEMS),bar_start=1,bar_end=len(read_json(folder/'meter.json')['segments']))
            result=self.action(run_id,action,lambda text,fraction:report(f'{i+1}/{len(STAGES)} · {text}',(i+fraction)/len(STAGES)))
            if stage=='emotion' and result['stages']['emotion']['status']!='ready':
                self.log(folder,'一键执行暂停：情绪或整曲预测存在失败，请检查过程文件后重试')
                raise RuntimeError('情绪或整曲预测尚未全部成功，请查看错误并重试；已完成结果已保存。')
        self.log(folder,'一键执行全部完成')
        report('全部过程完成：六声部全曲预测、原曲动态背景与映射已就绪',1.)
        return self.snapshot(run_id)

    def song_prediction(self,folder,m,tester):
        """Predict the original full mix, never the average of local/stem scores."""
        import soundfile as sf
        from bar_context import predict_bar_plan
        audio,sr=sf.read(folder/'source.wav',dtype='float32',always_2d=True)
        mono=audio.mean(axis=1)
        plan={'sample_rate':sr,'num_samples':len(mono),'offset_sample':0,'segment_rows':[],'prediction_unit':'bar'}
        song=predict_bar_plan(mono,sr,plan,tester,compare_raw=False,whole_audio=mono)['whole_song_prediction']
        if song['status']=='ok':
            song['scores']=[s for s in song.get('scores',[]) if s.get('tag') in TAGS and isinstance(s.get('score'),(int,float)) and math.isfinite(s['score']) and 0<=s['score']<=1]
            if not song['scores'] or not all(isinstance(song.get(k),(int,float)) and math.isfinite(song[k]) for k in ('arousal','valence')):
                song.update(status='error',error='整曲模型返回无效的 VA 或标签得分。')
        song.update(audio_sha256=m['sha256'],inference_device=m['parameters']['device'],prediction_input='original_full_mix_mono')
        write_json(folder/'song_prediction.json',song)
        return song

    def predict_background(self,folder,m,tester,report):
        """Original-mix bars supply a time-varying background, with their own cache."""
        import soundfile as sf
        path=folder/'background_prediction.json'
        revision=m['stages']['features']['finished']
        previous=read_json(path) if path.is_file() else {}
        audio,sr=sf.read(folder/'source.wav',dtype='float32',always_2d=True)
        if previous.get('lab_input_revision')==revision:
            result=previous
        else:
            plan=make_stem_plan(audio,sr,read_json(folder/'meter.json'),m['parameters'])
            plan['parameters']['context_scope']='original_mix_only'
            result={**plan,'lab_input_revision':revision,'audio_name':m['name'],'audio_sha256':m['sha256'],
                'prediction_input':'original_mix_bar_context','segments':[
                    {**r,'status':'pending','scores':[],'arousal':None,'valence':None} for r in plan['segment_rows']]}
            write_json(path,result)
        rows=[r for r in result['segments'] if r['status'] not in ('ok','silent')]
        if rows:
            if tester is None and any(r['target_rms']>=10**(m['parameters']['gate_dbfs']/20) or r.get('independent_prediction_skipped') for r in rows):
                tester=create_tester(m['parameters']['device'])
            def persist(row):
                result['segments']=[row if r['segment']==row['segment'] else r for r in result['segments']]
                write_json(path,result)
            predict_stem_rows(audio,sr,{**result,'segment_rows':rows},tester,
                progress=lambda done,total:report(f'原曲动态背景 · {done}/{total}',.9+.07*done/total),
                gate_dbfs=m['parameters']['gate_dbfs'],on_row=persist)
        table=[{**r,**{t:next((s['score'] for s in r.get('scores',[]) if s['tag']==t),None) for t in TAGS}}
            for r in result['segments']]
        write_csv(folder/'background_prediction.csv',table,
            ['segment','label','start_seconds','end_seconds','prediction_start_seconds','prediction_end_seconds','status','arousal','valence',*TAGS,'error'])
        return result,tester

    def predict_overlaps(self,folder,m,tester,report,a,b,force=False,requirements=None):
        """Predict actual aligned subset audio, with durable per-combination/bar caches."""
        from overlap_audio import mix_stems
        p=m['parameters'];analysis=read_json(folder/'meter.json')
        revision={'features':m['stages']['features']['finished'],'device':p['device'],'algorithm':OVERLAP_REVISION}
        counts={k:0 for k in ('ok','silent','error','pending')}
        required=requirements or {}
        selected=[c for c in OVERLAP_COMBINATIONS if required.get(overlap_key(c))]
        for i,stems in enumerate(selected):
            key=overlap_key(stems);wanted=set(required[key]);path=folder/'overlap_predictions'/(key+'.json')
            previous=read_json(path) if path.is_file() else {}
            audio=None
            if previous.get('overlap_input_revision')==revision:
                result=previous
            else:
                report(f'可见混音组合 {i+1}/{len(selected)} · {" + ".join(LABELS[s] for s in stems)}：计算混音 Foote 与窗口',.05+.9*i/max(1,len(selected)))
                audio=mix_stems(folder/'separated',stems,m['frames'],m['sample_rate'])
                plan=make_stem_plan(audio,m['sample_rate'],analysis,p)
                plan['parameters']['context_scope']='same_combination_mix_only'
                result={**plan,'key':key,'stems':list(stems),'overlap_input_revision':revision,
                    'prediction_input':'sample_aligned_stem_sum_no_independent_normalization',
                    'segments':[{**r,'status':'pending','scores':[],'arousal':None,'valence':None} for r in plan['segment_rows']]}
                write_json(path,result)
            rows=[r for j,r in enumerate(result['segments'],1) if a<=j<=b and j in wanted and (force or r['status'] not in ('ok','silent'))]
            if rows:
                if audio is None:audio=mix_stems(folder/'separated',stems,m['frames'],m['sample_rate'])
                if tester is None and any(r['target_rms']>=10**(p['gate_dbfs']/20) or r.get('independent_prediction_skipped') for r in rows):
                    tester=create_tester(p['device'])
                def persist(row):
                    result['segments']=[row if r['segment']==row['segment'] else r for r in result['segments']]
                    write_json(path,result)
                predict_stem_rows(audio,m['sample_rate'],{**result,'segment_rows':rows},tester,
                    gate_dbfs=p['gate_dbfs'],on_row=persist,
                    progress=lambda done,total:report(f'可见混音组合 {i+1}/{len(selected)} · {key} · {done}/{total}',.05+.9*(i+done/total)/max(1,len(selected))))
            for j,row in enumerate(result['segments'],1):
                if j in wanted:counts[row['status']]+=1
            write_csv(path.with_suffix('.csv'),[
                {**r,**{t:next((s['score'] for s in r.get('scores',[]) if s['tag']==t),None) for t in TAGS}} for r in result['segments']],
                ['segment','start_seconds','end_seconds','prediction_start_seconds','prediction_end_seconds','status','arousal','valence',*TAGS,'error'])
            del audio
        return counts,tester

    def map_overlaps(self,folder,m,p,scene_revision=None):
        output={'enabled':p['overlap_colors_enabled'],'combination_count':0,'combinations':[],
            'region_rule':'exact set of intersecting instrument silhouettes, clipped to viewport',
            'audio_rule':'sample-aligned original-gain sum, no score/color averaging',
            'missing_color':'ordinary layered fill, visible missing predictions reported',
            'outline_rule':'all enabled instrument borders painted last','coverage_status':'disabled'}
        if not output['enabled']:return output
        plan_path=folder/'overlap_requirements.json'
        coverage=read_json(plan_path) if plan_path.is_file() else None
        if not coverage or coverage.get('revision')!=3 or (scene_revision and coverage.get('scene_revision')!=scene_revision):
            output.update(coverage_status='needs_geometry',counts={k:0 for k in ('ok','silent','error','pending')});return output
        output.update(coverage=coverage,coverage_status='ready')
        revision={'features':m['stages']['features']['finished'],'device':p['device'],'algorithm':OVERLAP_REVISION}
        counts={k:0 for k in ('ok','silent','error','pending')}
        for stems in OVERLAP_COMBINATIONS:
            key=overlap_key(stems);wanted=set(coverage['requirements'].get(key,[]))
            if not wanted:continue
            path=folder/'overlap_predictions'/(key+'.json')
            result=read_json(path) if path.is_file() else None
            if not result or result.get('overlap_input_revision')!=revision:
                counts['pending']+=len(wanted);continue
            # Irrelevant cached bars stay on disk, but do not influence colors or
            # generate transitions through gaps where this mixed region is absent.
            scoped={**result,'segments':[{**r} if j in wanted else {**r,'status':'not_required','scores':[],'arousal':None,'valence':None}
                for j,r in enumerate(result['segments'],1)]}
            for j,r in enumerate(result['segments'],1):
                if j in wanted:counts[r['status']]+=1
            mapped=make_spectra_bundle(scoped,p)
            output['combinations'].append({'key':key,'stems':list(stems),'required_rows':sorted(wanted),
                **{k:mapped[k] for k in ('segments','transition','mapping')}})
        output.update(combination_count=len(coverage['requirements']),counts=counts)
        if counts['pending'] or counts['error']:output['coverage_status']='partial'
        write_json(folder/'overlap_colors.json',output)
        return output

    def predict_visible_overlaps(self,run_id,options,report):
        folder=self.folder(run_id);m=self.manifest(run_id);p=m['parameters']
        if not p['overlap_colors_enabled'] or m['stages']['mapping']['status']!='ready':
            raise ValueError('请先开启混音重叠色，并完成基础颜色/坐标映射。')
        bundle=read_json(folder/'mapped.json');coverage=deepcopy(options.get('coverage'))
        if not isinstance(coverage,dict) or coverage.get('revision')!=3 or coverage.get('scene_revision')!=bundle['scene_revision']:
            raise ValueError('几何数据已变化，请重新筛选当前布局。')
        profile=coverage.get('profile');requirements=coverage.get('requirements');n=len(bundle['bars'])
        if not isinstance(profile,dict) or profile.get('revision')!=3 or not isinstance(requirements,dict):raise ValueError('交叠筛选格式无效。')
        for key in ('width','height','size'):
            v=profile.get(key)
            if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or v<=0:raise ValueError('交叠画面参数无效。')
        if not .1<=profile['size']<=3 or abs(profile['width']/profile['height']-16/9)>.001:raise ValueError('交叠画面比例或尺寸无效。')
        if profile.get('pitch_mode') not in ('beat_summary','continuous') or profile.get('stem') not in STEMS:raise ValueError('交叠预览模式无效。')
        for key in ('solo','foote_motion_enabled','rotation_enabled'):
            if not isinstance(profile.get(key),bool):raise ValueError('交叠开关无效。')
        allowed={overlap_key(c) for c in OVERLAP_COMBINATIONS}
        if set(requirements)-allowed:raise ValueError('交叠声部组合无效。')
        for key,rows in requirements.items():
            if not isinstance(rows,list) or not rows or any(isinstance(i,bool) or not isinstance(i,int) or not 1<=i<=n for i in rows) or rows!=sorted(set(rows)):
                raise ValueError('交叠小节序号无效。')
        coverage['required_count']=sum(len(rows) for rows in requirements.values());coverage['theoretical_count']=57*n
        write_json(folder/'overlap_requirements.json',coverage)
        tester=None
        try:
            counts,tester=self.predict_overlaps(folder,m,tester,report,1,n,options.get('force',False),requirements=requirements)
        finally:
            del tester;release_accelerators()
        bundle['overlap']=self.map_overlaps(folder,m,p,bundle['scene_revision'])
        bundle['warnings']=[w for w in bundle.get('warnings',[]) if not w.startswith('混音重叠色')]
        if counts['pending'] or counts['error']:bundle['warnings'].append('混音重叠色所需小节尚未全部成功，可点击补齐重试。')
        write_json(folder/'mapped.json',bundle)
        m['stages']['emotion'].update(overlap_status='ok' if not counts['pending'] and not counts['error'] else 'partial',overlap_counts=counts)
        m['stages']['mapping'].update(overlap_required=coverage['required_count'],overlap_avoided=coverage['theoretical_count']-coverage['required_count'])
        m['updated']=time.time();write_json(folder/'manifest.json',m)
        self.log(folder,'可见交叠色完成',required=coverage['required_count'],theoretical=coverage['theoretical_count'],counts=counts)
        return self.snapshot(run_id)

    def run_meter(self,folder,m,options,report,old_status):
        import soundfile as sf
        audio,sr=sf.read(folder/'source.wav',dtype='float32',always_2d=True)
        report('Beat This!：只检测原曲节拍和小节',.05)
        analysis=detect_meter(audio,sr,m['parameters']['device'],model=m['parameters']['beat_model'])
        write_json(folder/'meter.json',analysis)
        write_csv(folder/'bars.csv',analysis['segments'],['index','label','kind','bar_number','start','end','start_sample','end_sample'])
        return {'bars':len(analysis['segments']),'beats':len(analysis['beats'])}

    def run_separation(self,folder,m,options,report,old_status):
        import soundfile as sf
        audio,sr=sf.read(folder/'source.wav',dtype='float32',always_2d=True)
        p=m['parameters']
        separated=folder/'separated'
        meta=separate_source(audio,separated,device=p['device'],weights=p['sw_weights'] or None,
            chunk_seconds=p['chunk_seconds'],amp=p['amp'],progress=report)
        # One common gain keeps relative loudness intact, including audition.
        gain=meta['preview_common_gain']
        m['preview_gain']=gain
        previews=folder/'previews'; previews.mkdir(exist_ok=True)
        sf.write(folder/'listen.wav',audio*gain,sr,subtype='PCM_16')
        for stem in STEMS:
            source,rate=sf.read(separated/(stem+'.wav'),dtype='float32',always_2d=True)
            if len(source)!=m['frames'] or rate!=sr or source.shape[1]!=2:
                raise ValueError(f'{stem} 分轨未与原曲逐采样对齐。')
            sf.write(previews/(stem+'.wav'),source*gain,sr,subtype='PCM_16')
            write_json(folder/'waveforms'/(stem+'.json'),waveform(source,sr))
        return {'stems':list(STEMS),'common_preview_gain':gain}

    def run_features(self,folder,m,options,report,old_status):
        import soundfile as sf
        p=m['parameters']; analysis=read_json(folder/'meter.json'); peaks=[]
        for i,stem in enumerate(STEMS):
            report(f'{LABELS[stem]}：实时特征、Foote 与预测上下文',i/6)
            audio,sr=sf.read(folder/'separated'/(stem+'.wav'),dtype='float32',always_2d=True)
            motion=realtime_features(audio,sr,gate_dbfs=p['gate_dbfs'],frame_seconds=p['frame_seconds'])
            peaks.append(motion['rms_peak'])
            plan=make_stem_plan(audio,sr,analysis,p)
            write_json(folder/'motion'/(stem+'.json'),motion)
            write_json(folder/'plans'/(stem+'.json'),plan)
            write_csv(folder/'plans'/(stem+'.csv'),plan['segment_rows'],
                ['segment','label','start_seconds','end_seconds','duration_seconds','prediction_start_seconds',
                 'prediction_end_seconds','target_rms','independent_prediction_skipped','inherited_from_segment','stop_reason'])
            write_csv(folder/'motion'/(stem+'.csv'),(dict(time=t,rms=r,raw_rms=raw,centroid_hz=c,y_normalized=y)
                for t,r,raw,c,y in zip(motion['times'],motion['rms'],motion['raw_rms'],motion['centroid_hz'],motion['centroid_normalized'])),
                ['time','rms','raw_rms','centroid_hz','y_normalized'])
        return {'context_target_seconds':p['target_seconds'],'minimum_seconds':3.,'gate_dbfs':p['gate_dbfs'],
            'reference_rms':max(peaks,default=0.)}

    def run_emotion(self,folder,m,options,report,old_status):
        import soundfile as sf
        p=m['parameters']; selected=options.get('stems',list(STEMS)); tester=None
        source_fraction=.9
        total_bars=len(read_json(folder/'meter.json')['segments'])
        a,b=options.get('bar_start',1),options.get('bar_end',total_bars)
        input_revision=m['stages']['features']['finished']
        # All tracks retain pending rows: a partial experiment never invents predictions.
        results={}
        for stem in STEMS:
            plan=read_json(folder/'plans'/(stem+'.json'))
            path=folder/'emotions'/(stem+'.json')
            previous=read_json(path) if path.is_file() else {}
            results[stem]=previous if previous.get('lab_input_revision')==input_revision else {**plan,
                'lab_input_revision':input_revision,'segments':[
                {**r,'status':'pending','scores':[],'arousal':None,'valence':None} for r in plan['segment_rows']]}
            write_json(path,results[stem])
        try:
            for i,stem in enumerate(selected):
                result=results[stem]
                rows=[r for j,r in enumerate(result['segments'],1) if a<=j<=b and (options.get('force',False) or r['status'] not in ('ok','silent'))]
                if not rows: continue
                audio,sr=sf.read(folder/'separated'/(stem+'.wav'),dtype='float32',always_2d=True)
                if tester is None and any(r['target_rms']>=10**(p['gate_dbfs']/20) or r.get('independent_prediction_skipped') for r in rows):
                    report('加载情绪模型（声部选定范围与原曲整首）',source_fraction*i/len(selected))
                    tester=create_tester(p['device'])
                subset={**result,'segment_rows':rows}
                # Save each finished bar so even an interrupted experiment is inspectable.
                def save_row(done,total):
                    report(f'{LABELS[stem]} · {done}/{total}',source_fraction*(i+done/total)/len(selected))
                def persist(row):
                    result['segments']=[row if r['segment']==row['segment'] else r for r in result['segments']]
                    write_json(folder/'emotions'/(stem+'.json'),result)
                prediction=predict_stem_rows(audio,sr,subset,tester,progress=save_row,gate_dbfs=p['gate_dbfs'],on_row=persist)
                predicted={r['segment']:r for r in prediction['segments']}
                result['segments']=[predicted.get(r['segment'],r) for r in result['segments']]
                write_json(folder/'emotions'/(stem+'.json'),result)
            overlap_counts=None
            background,tester=self.predict_background(folder,m,tester,report)
            cached=read_json(folder/'song_prediction.json') if (folder/'song_prediction.json').is_file() else {}
            if cached.get('status')=='ok' and cached.get('audio_sha256')==m['sha256'] and cached.get('inference_device')==p['device']:
                song=cached
            else:
                report('原曲整首独立预测：生成背景色标签',.98)
                if tester is None: tester=create_tester(p['device'])
                song=self.song_prediction(folder,m,tester)
        finally:
            del tester
        for stem,result in results.items():
            write_json(folder/'emotions'/(stem+'.json'),result)
            table=[{**r,**{t:next((s['score'] for s in r.get('scores',[]) if s['tag']==t),None) for t in TAGS}}
                for r in result['segments']]
            write_csv(folder/'emotions'/(stem+'.csv'),table,
                ['segment','label','start_seconds','end_seconds','prediction_start_seconds','prediction_end_seconds','status','arousal','valence',*TAGS,'error'])
        counts={s:sum(r['status']==s for v in results.values() for r in v['segments']) for s in ('ok','silent','error','pending')}
        background_counts={s:sum(r['status']==s for r in background['segments']) for s in ('ok','silent','error','pending')}
        background_ok=not (background_counts['pending'] or background_counts['error'])
        overlap_ok=overlap_counts is None or not (overlap_counts['pending'] or overlap_counts['error'])
        return {'status':'partial' if counts['pending'] or counts['error'] or song['status']!='ok' or not background_ok or not overlap_ok else 'ready',
            'counts':counts,'song_status':song['status'],'background_status':'ok' if background_ok else 'error','background_counts':background_counts,
            'selected_stems':selected,'selected_row_range':[a,b],
            'overlap_status':'awaiting_geometry' if p['overlap_colors_enabled'] else 'disabled','overlap_counts':overlap_counts}

    def motion_foote(self,run_id):
        folder=self.folder(run_id);m=self.manifest(run_id)
        if m['stages']['features']['status'] not in ('ready','partial'):
            raise ValueError('请先完成特征计算，再读取Foote运动曲线。')
        curves={}
        for stem in STEMS:
            path=folder/'plans'/(stem+'.json')
            if not path.is_file():continue
            curve=foote_motion_curve(read_json(path))
            if curve is not None:curves[stem]=curve
        return {'tracks':curves,'source':'cached_same_stem_foote','inference':False}

    def cached_pitch(self,folder,m,stem,progress):
        import soundfile as sf
        engine=pitch_engine(m['parameters'],stem)
        revision={'algorithm':PITCH_REVISION,'separation':m['stages']['separation']['finished'],
            'sample_rate':m['sample_rate'],'frames':m['frames'],'settings':PITCH_SETTINGS,'range':list(PITCH_RANGES[stem])}
        if engine=='melodia':
            revision.update(algorithm='melodia-'+str(MELODIA_REVISION),settings={**MELODIA_SETTINGS,
                'high_pitch_bias':m['parameters']['melodia_high_pitch_bias'],'voicing_tolerance':m['parameters']['melodia_voicing_tolerance']},range=list(MELODIA_RANGES[stem]))
        def cache_path(rev):
            digest=hashlib.sha256(json.dumps(rev,sort_keys=True,separators=(',',':')).encode()).hexdigest()[:24]
            return folder/'pitch_cache'/stem/(digest+'.json')
        path=folder/'pitch_raw'/(stem+'.json')
        cached=read_json(path) if path.is_file() else {}
        if cached.get('input_revision')==revision:return cached
        # Preserve the previous engine/parameter result before replacing active files.
        if cached.get('input_revision'):
            archived=cache_path(cached['input_revision'])
            if not archived.is_file():write_json(archived,cached)
        stored=cache_path(revision)
        if stored.is_file():raw=read_json(stored)
        else:
            audio,sr=sf.read(folder/'separated'/(stem+'.wav'),dtype='float32',always_2d=True)
            progress(0.)
            raw=estimate_melodia(audio,sr,stem,progress=progress,high_pitch_bias=m['parameters']['melodia_high_pitch_bias'],voicing_tolerance=m['parameters']['melodia_voicing_tolerance']) if engine=='melodia' else estimate_pitch(audio,sr,stem,progress=progress)
            raw['input_revision']=revision
            write_json(stored,raw)
        write_json(path,raw)
        write_csv(path.with_suffix('.csv'),[dict(time=t,f0_hz=hz,voiced_flag=v,voiced_probability=p,rms=r)
            for t,hz,v,p,r in zip(raw['times'],raw['f0_hz'],raw['voiced_flag'],raw['voiced_probability'],raw['rms'])],
            ['time','f0_hz','voiced_flag','voiced_probability','rms'])
        return raw

    def run_mapping(self,folder,m,options,report,old_status):
        p=m['parameters']; analysis=read_json(folder/'meter.json'); tracks=[]
        song=read_json(folder/'song_prediction.json') if (folder/'song_prediction.json').is_file() else {}
        if song.get('status')!='ok' or song.get('audio_sha256')!=m['sha256'] or song.get('inference_device')!=p['device']:
            raise ValueError('请先运行情绪步骤，完成原曲整首独立预测以生成背景色。')
        song_mapped=map_prediction_colors({'segments':[],'whole_song_prediction':song},p)
        if song_mapped['whole_song_color']['status']!='ok':
            raise ValueError('整曲色彩映射无效，请检查 song_prediction.json 中的标签与 VA。')
        background_path=folder/'background_prediction.json'
        if not background_path.is_file():
            raise ValueError('请先运行情绪步骤或一键执行，补齐原曲逐小节动态背景预测；已有声部结果可复用。')
        background_result=read_json(background_path)
        if background_result.get('lab_input_revision')!=m['stages']['features']['finished']:
            raise ValueError('原曲背景预测窗口已过期，请重新运行情绪步骤。')
        background=make_spectra_bundle(background_result,p)
        background['source']='original_mix_bar_context'
        write_json(folder/'background.colors.json',background)
        for i,stem in enumerate(STEMS):
            report(f'{LABELS[stem]}：HSV / 坐标 / 音高（复用情绪）',i/6)
            result=read_json(folder/'emotions'/(stem+'.json'))
            motion=read_json(folder/'motion'/(stem+'.json'))
            track=attach_track(result,motion,stem,p)
            attach_geometry_reference(track)
            track['motion_foote']=foote_motion_curve(read_json(folder/'plans'/(stem+'.json')))
            beat_motion=beat_centroid_features(motion,analysis['beats'],m['duration_seconds'],percentiles=p['coordinate_percentiles'])
            track['beat_motion']=beat_motion
            track['normalization'].update(centroid_min_hz=beat_motion['centroid_min_hz'],
                centroid_max_hz=beat_motion['centroid_max_hz'],centroid_scope=beat_motion['scope'])
            write_json(folder/'beat_motion'/(stem+'.json'),beat_motion)
            write_csv(folder/'beat_motion'/(stem+'.csv'),beat_motion['rows'],
                ['index','kind','start_seconds','end_seconds','status','centroid_hz','normalized','active_seconds',
                 'from_centroid_hz','target_centroid_hz','from_normalized','target_normalized'])
            if stem!='drums':
                engine=pitch_engine(p,stem)
                raw=self.cached_pitch(folder,m,stem,lambda amount:report(f'{LABELS[stem]}：{engine} 音高 {amount:.0%}',(i+amount*.8)/6))
                threshold=p['melodia_confidence_threshold'] if engine=='melodia' else p['pitch_confidence_threshold']
                pitch=pitch_features(raw,analysis['beats'],m['duration_seconds'],threshold,p['gate_dbfs'])
                track['pitch']=pitch
                track['normalization'].update(y_source=engine,pitch_midi_p5=pitch['midi_p5'],pitch_midi_p95=pitch['midi_p95'],pitch_scope=pitch['scope'],pitch_coverage=pitch['coverage'])
                write_json(folder/'pitch'/(stem+'.json'),pitch)
                write_csv(folder/'pitch'/(stem+'.beats.csv'),pitch['rows'],['index','start_seconds','end_seconds','status','midi','normalized','valid_frames','confidence_median','from_midi','target_midi','from_normalized','target_normalized'])
                write_csv(folder/'pitch'/(stem+'.continuous.csv'),pitch['continuous'],['start_seconds','end_seconds','status','midi','f0_hz','confidence','from_midi','target_midi','from_normalized','target_normalized'])
                volume=beat_volume_features(motion,analysis['beats'],m['duration_seconds'])
                track['beat_volume']=volume
                write_json(folder/'beat_volume'/(stem+'.json'),volume)
                write_csv(folder/'beat_volume'/(stem+'.csv'),volume['rows'],
                    ['index','kind','start_seconds','end_seconds','status','mean_rms','from_rms','target_rms'])
            if stem=='drums':track['normalization']['y_source']='beat_centroid'
            tracks.append(track)
        bars=[dict(id=r['index'],label=r['label'],kind=r['kind'],bar_number=r.get('bar_number'),start_seconds=r['start'],end_seconds=r['end']) for r in analysis['segments']]
        counts=m['stages']['emotion'].get('counts',{})
        pending=counts.get('pending',0)+counts.get('error',0)
        current_scene_revision=bundle_scene_revision({'audio':{'sha256':m['sha256'],'duration_seconds':m['duration_seconds']},'stems':tracks,'volume':{'reference_rms':max(t['motion']['rms_peak'] for t in tracks)},'bars':bars})
        overlap=self.map_overlaps(folder,m,p,current_scene_revision)
        overlap_missing=overlap.get('counts',{}).get('pending',0)+overlap.get('counts',{}).get('error',0)
        bundle={'schema':'spectra-stems-v1','scene_revision':current_scene_revision,'pipeline_version':'stems-lab-r56','run_id':m['id'],'geometry':geometry_metadata(p),
            'prediction_unit':'bar','defaults':p,'audio':{'name':m['name'],'sha256':m['sha256'],
                'duration_seconds':m['duration_seconds'],'sample_rate':m['sample_rate'],'frames':m['frames'],
                'playback_url':f'/api/lab/runs/{m["id"]}/files/listen.wav'},
            'beats':analysis['beats'],'downbeats':analysis['downbeats'],'bars':bars,'stems':tracks,
            'whole_song_prediction':song,'whole_song_color':song_mapped['whole_song_color'],
            'whole_song_mapping':song_mapped['whole_song_mapping'],
            'background':background,'overlap':overlap,
            'movement':{'x':'full current bar: previous arousal position to current arousal position',
                'y':'non-drums: accepted MIDI pitch, beat median or continuous; drums: beat mean centroid',
                'coordinate_percentiles':[5,95],'pitch_preview_mode':'beat_summary','pitch_method':p['pitch_method'],'melodia_high_pitch_bias':p['melodia_high_pitch_bias'],'melodia_voicing_tolerance':p['melodia_voicing_tolerance'],
                'foote_motion_enabled':p['foote_motion_enabled'],'foote_motion_rule':'quintic easing of normalized Foote integral; continuous pitch uses integrated Foote followed by causal 60ms Hann smoothing',
                'velocity_continuity':'C1 across anchors, pitch frames, loss of voicing, percentile limits and terminal braking',
                'terminal_braking_seconds':.12,'continuous_motion_smoothing_seconds':.06,
                'fraction':1.,'easing':'quintic_foote_integral_when_enabled_else_smoothstep','anticipation':False},
            'volume':{'reference_rms':max(t['motion']['rms_peak'] for t in tracks),'scale':'shared_all_six_stems','gate_dbfs':p['gate_dbfs'],
                'instrument_modes':{stem:'realtime' if stem=='drums' else 'beat_average' for stem in STEMS},
                'non_drum_transition':'full_current_beat_smoothstep','anticipation':False},
            'warnings':analysis.get('warnings',[])+(['混音重叠色尚有待测或失败片段，缺失区域暂用普通层叠填色；请补齐情绪预测。'] if overlap_missing else [])+(['部分试算：坐标、均值和颜色增强统计仅依据已成功预测的小节；补全后会更新。'] if pending else [])}
        write_json(folder/'mapped.json',bundle)
        m['lab_revision']=37
        m['geometry_revision']=47
        m['volume_revision']=41
        m['pitch_revision']=PITCH_REVISION
        m['melody_revision']=MELODIA_REVISION
        rows=[{'stem':t['id'],**{k:r.get(k) for k in ('segment','start_seconds','end_seconds','arousal','valence','dominant_tag','hue_degrees','saturation','value','hex','x_normalized','prediction_status','geometry_kind')}} for t in tracks for r in t['segments']]
        write_csv(folder/'colors.csv',rows,list(rows[0]))
        return {'valid_colors':sum(r['hex'] is not None for r in rows),'partial_statistics':bool(pending)}

    def inspect(self,run_id,stem):
        if stem not in STEMS: raise ValueError('声部无效。')
        folder=self.folder(run_id); m=self.manifest(run_id)
        def load(path,stage):
            return read_json(folder/path) if m['stages'][stage]['status'] in ('ready','partial') and (folder/path).is_file() else None
        return {'stem':stem,'waveform':load(f'waveforms/{stem}.json','separation'),
            'meter':load('meter.json','meter'),'motion':load(f'motion/{stem}.json','features'),
            'beat_motion':load(f'beat_motion/{stem}.json','mapping'),
            'pitch':load(f'pitch/{stem}.json','mapping') if stem!='drums' else None,
            'pitch_raw':load(f'pitch_raw/{stem}.json','mapping') if stem!='drums' else None,
            'beat_volume':load(f'beat_volume/{stem}.json','mapping') if stem!='drums' else None,
            'plan':load(f'plans/{stem}.json','features'),'emotion':load(f'emotions/{stem}.json','emotion')}

    def file(self,run_id,relative):
        folder=self.folder(run_id)
        path=(folder/relative).resolve()
        if not path.is_relative_to(folder.resolve()) or path.suffix not in ('.wav','.json','.csv','.log','.mp4') or not path.is_file():
            raise FileNotFoundError('文件不存在或不属于本次实验。')
        return path

    def clip(self,run_id,stem,row_number,kind):
        import soundfile as sf
        if stem not in STEMS or kind not in ('target','context'): raise ValueError('试听参数无效。')
        m=self.manifest(run_id)
        if m['stages']['features']['status']!='ready': raise ValueError('请先完成当前参数的特征与窗口计算。')
        folder=self.folder(run_id); plan=read_json(folder/'plans'/(stem+'.json'))
        if not 1<=row_number<=len(plan['segment_rows']): raise ValueError('片段序号无效。')
        row=plan['segment_rows'][row_number-1]
        a,b=(row['start_sample'],row['end_sample']) if kind=='target' else (row['prediction_start_sample'],row['prediction_end_sample'])
        audio,sr=sf.read(folder/'separated'/(stem+'.wav'),start=a,stop=b,dtype='float32',always_2d=True)
        # Model uses mono contexts; audition the exact pre-gain mono signal.
        audio=audio.mean(axis=1) if kind=='context' else audio
        stream=io.BytesIO(); sf.write(stream,audio*m['preview_gain'],sr,format='WAV',subtype='PCM_16')
        return stream.getvalue(),{'start_sample':a,'end_sample':b,'gain':m['preview_gain']}
