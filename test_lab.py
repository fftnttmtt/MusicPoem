"""Lab orchestration/HTTP checks; heavy models are controlled test doubles."""
import http.client
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import numpy as np
import soundfile as sf

from beat_core import build_analysis
import lab_pipeline as lp
from spectra_server import Jobs, make_server
from stem_separator.audio_io import export_audio


class LabChecks(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.sr=8000;t=np.arange(self.sr*12)/self.sr
        signal=(.1*np.sin(2*np.pi*220*t)*(1+.4*np.sin(t))).astype(np.float32)
        self.audio=np.column_stack([signal,signal])
        self.analysis=build_analysis(self.audio,self.sr,np.arange(0,12,.5),[0,2,9,12],model='final0',device='cpu')
        self.lab=lp.Lab(Path(self.tmp.name)/'lab');self.progress=lambda *args:None
        self.calls=[]
        outer=self
        class Tester:
            def predict(self,path,threshold):
                y,sr=sf.read(path);outer.calls.append((sr,len(y),float(y.mean())))
                return {'arousal':3+float(np.std(y))*20,'valence':6.,'scores':[
                    {'tag':tag,'score':.8 if tag=='happy' else .4 if tag=='sad' else .1} for tag in lp.TAGS]}
        def separate(audio,folder,**kwargs):
            folder.mkdir(parents=True,exist_ok=True)
            stems={stem:audio*(i+1)/6 if stem!='piano' else np.zeros_like(audio) for i,stem in enumerate(lp.STEMS)}
            gain,stats=export_audio(folder,self.sr,audio,stems)
            meta={'preview_common_gain':gain,'audio_stats':stats}
            lp.write_json(folder/'separation.json',meta)
            return meta
        def estimate(audio,sr,stem,progress=None):
            times=np.linspace(0,len(audio)/sr,49)
            active=bool(np.max(np.abs(audio))>1e-9)
            return {'method':'pyin','times':times.tolist(),'f0_hz':[220.*2**((i%12)/12) if active else None for i in range(49)],
                'voiced_flag':[active]*49,'voiced_probability':[.95 if active else 0.]*49,'rms':[.05 if active else 0.]*49}
        patches=[patch.object(lp.sw,'SAMPLE_RATE',self.sr),patch.object(lp,'decode_audio',return_value=self.audio),
            patch.object(lp,'detect_meter',return_value=self.analysis),patch.object(lp,'separate_source',side_effect=separate),
            patch.object(lp,'create_tester',return_value=Tester()),patch.object(lp,'estimate_pitch',side_effect=estimate)]
        self.mocks=[p.start() for p in patches]
        for p in patches:self.addCleanup(p.stop)
        source=Path(self.tmp.name)/'in.wav';sf.write(source,self.audio,self.sr)
        self.source=source
        self.run=self.lab.upload(source,'试验曲.wav','a'*64,self.progress)
        self.run_id=self.run['id'];self.folder=self.lab.folder(self.run_id)
        self.lab.action(self.run_id,{'stage':'configure','parameters':{'pitch_method':'pyin'}},self.progress)

    def action(self,stage,**options):
        return self.lab.action(self.run_id,{'stage':stage,**options},self.progress)

    def features(self):
        for stage in ('meter','separation','features'):self.action(stage)

    def coverage(self,requirements):
        bundle=lp.read_json(self.folder/'mapped.json')
        return {'revision':3,'scene_revision':bundle['scene_revision'],
            'profile':{'revision':3,'width':960,'height':540,'size':1.,'pitch_mode':'beat_summary',
                'solo':False,'stem':'bass','foote_motion_enabled':True,'rotation_enabled':True},
            'requirements':requirements}

    def test_overlap_mode_predicts_only_visible_requested_bars_and_reuses_all_old_cache(self):
        self.action('all');single_calls=len(self.calls)
        original={s:lp.read_json(self.folder/'emotions'/(s+'.json')) for s in lp.STEMS}
        self.action('all',parameters={'overlap_colors_enabled':True})
        self.assertEqual(len(self.calls),single_calls)
        self.assertFalse((self.folder/'overlap_predictions').exists())
        self.assertEqual(lp.read_json(self.folder/'mapped.json')['overlap']['coverage_status'],'needs_geometry')
        plan=self.coverage({'bass+drums':[1],'drums+vocals':[2]})
        self.action('overlap',coverage=plan)
        self.assertEqual(len(self.calls),single_calls+2)
        self.assertEqual({p.stem for p in (self.folder/'overlap_predictions').glob('*.json')},{'bass+drums','drums+vocals'})
        mixed=lp.read_json(self.folder/'mapped.json')['overlap']
        self.assertEqual(mixed['counts'],{'ok':2,'silent':0,'error':0,'pending':0})
        self.assertEqual(mixed['coverage']['required_count'],2);self.assertEqual(mixed['coverage']['theoretical_count'],171)
        self.assertEqual(mixed['coverage_status'],'ready')
        self.assertEqual(mixed['combinations'][0]['segments'][1]['prediction_status'],'not_required')
        calls=len(self.calls);self.action('overlap',coverage=plan);self.assertEqual(len(self.calls),calls)
        # A changed layout requests one previously invisible bar, not the other 169.
        larger=self.coverage({'bass+drums':[1,2],'drums+vocals':[2]})
        self.action('overlap',coverage=larger);self.assertEqual(len(self.calls),calls+1)
        old=(self.folder/'overlap_predictions/bass+drums.json').read_bytes()
        self.action('overlap',coverage=self.coverage({}));self.assertEqual((self.folder/'overlap_predictions/bass+drums.json').read_bytes(),old)
        self.assertEqual(lp.read_json(self.folder/'mapped.json')['overlap']['combination_count'],0)
        calls=len(self.calls);self.action('overlap',coverage=plan);self.assertEqual(len(self.calls),calls)
        self.assertEqual(original,{s:lp.read_json(self.folder/'emotions'/(s+'.json')) for s in lp.STEMS})
        self.action('all',parameters={'overlap_colors_enabled':False});self.assertEqual(len(self.calls),calls)
        self.assertTrue((self.folder/'overlap_predictions/bass+drums.json').is_file())
        self.mocks[2].assert_called_once();self.mocks[3].assert_called_once()

    def test_old_r52_mapping_is_upgraded_without_prediction_or_repeated_large_file_reads(self):
        self.action('all');calls=len(self.calls)
        value=lp.read_json(self.folder/'mapped.json');value.pop('scene_revision');lp.write_json(self.folder/'mapped.json',value)
        restored=lp.Lab(self.lab.root);restored.manifest(self.run_id)
        self.assertEqual(len(lp.read_json(self.folder/'mapped.json')['scene_revision']),64)
        with patch.object(lp,'read_json',wraps=lp.read_json) as reader:
            restored.manifest(self.run_id);restored.manifest(self.run_id)
            self.assertTrue(all(Path(c.args[0]).name!='mapped.json' for c in reader.call_args_list))
        self.assertEqual(len(self.calls),calls)

    def test_stale_or_invalid_geometry_plans_do_not_start_prediction(self):
        self.action('all',parameters={'overlap_colors_enabled':True});calls=len(self.calls)
        plan=self.coverage({'bass+drums':[1]})
        for value in ({**plan,'revision':1},{**plan,'revision':2},{**plan,'profile':{**plan['profile'],'revision':2}},
                      {**plan,'scene_revision':'wrong'},{**plan,'requirements':{'bass+drums':[0]}},
                      {**plan,'requirements':{'bass+drums':[1,1]}},{**plan,'requirements':{'unknown':[1]}}):
            with self.assertRaises(ValueError):self.action('overlap',coverage=value)
        self.assertEqual(len(self.calls),calls);self.assertFalse((self.folder/'overlap_predictions').exists())

    def test_overlap_combinations_and_aligned_summation_preserve_gain_and_cancellation(self):
        from overlap_audio import mix_stems
        self.assertEqual(len(lp.OVERLAP_COMBINATIONS),57)
        self.assertEqual(len({lp.overlap_key(c) for c in lp.OVERLAP_COMBINATIONS}),57)
        self.assertEqual({len(c) for c in lp.OVERLAP_COMBINATIONS},{2,3,4,5,6})
        folder=Path(self.tmp.name)/'mix-test';folder.mkdir()
        a=np.full((32,2),1.4,dtype=np.float32);b=np.full((32,2),-.3,dtype=np.float32)
        sf.write(folder/'bass.wav',a,self.sr,subtype='FLOAT');sf.write(folder/'drums.wav',b,self.sr,subtype='FLOAT')
        mix=mix_stems(folder,('bass','drums'),32,self.sr)
        np.testing.assert_allclose(mix,a+b);self.assertGreater(float(mix.max()),1.)
        sf.write(folder/'drums.wav',-a,self.sr,subtype='FLOAT')
        np.testing.assert_array_equal(mix_stems(folder,('bass','drums'),32,self.sr),np.zeros_like(a))
        with self.assertRaisesRegex(ValueError,'对齐'):mix_stems(folder,('bass','drums'),31,self.sr)

    def test_lab_launcher_is_ascii_crlf_and_calls_quoted_project_venv(self):
        content=(Path(__file__).parent/'start_lab.bat').read_bytes()
        content.decode('ascii')
        self.assertEqual(content.count(b'\n'),content.count(b'\r\n'))
        self.assertNotIn(b'(',content)
        self.assertIn(b'"%SPECTRA_PY%" "%~dp0spectra_server.py" --lab %*',content)
        self.assertIn(b'DisableDelayedExpansion',content)

    def test_pitch_cache_confidence_mapping_and_upgrade_reuse_all_emotion_results(self):
        self.action('all');calls=len(self.calls);pitch_calls=self.mocks[5].call_count
        self.assertEqual(pitch_calls,5)
        bundle=lp.read_json(self.folder/'mapped.json')
        for track in bundle['stems']:
            self.assertEqual(track['normalization']['percentiles'],[5,95])
            self.assertEqual(track['beat_motion']['percentiles'],[5,95])
            if track['id']=='drums':self.assertNotIn('pitch',track);continue
            self.assertEqual(track['normalization']['y_source'],'pyin')
            self.assertEqual(track['pitch']['coverage'],0.) if track['id']=='piano' else self.assertGreater(track['pitch']['coverage'],0.)
            self.assertEqual(self.lab.inspect(self.run_id,track['id'])['pitch'],track['pitch'])
            self.assertTrue((self.folder/'pitch_raw'/(track['id']+'.csv')).is_file())
            self.assertEqual(self.lab.inspect(self.run_id,track['id'])['pitch_raw'],lp.read_json(self.folder/'pitch_raw'/(track['id']+'.json')))
        m=self.action('configure',parameters={'pitch_confidence_threshold':.99})
        self.assertEqual(m['stages']['mapping']['status'],'stale');self.assertEqual(m['stages']['emotion']['status'],'ready')
        self.action('mapping');self.assertEqual(self.mocks[5].call_count,pitch_calls)
        mapped=lp.read_json(self.folder/'mapped.json')
        self.assertTrue(all(t['pitch']['coverage']==0 for t in mapped['stems'] if t['id']!='drums'))
        m=lp.read_json(self.folder/'manifest.json');m.pop('pitch_revision');lp.write_json(self.folder/'manifest.json',m)
        self.action('all',parameters={'pitch_confidence_threshold':.6})
        self.assertEqual(self.mocks[5].call_count,pitch_calls);self.assertEqual(len(self.calls),calls)
        self.mocks[2].assert_called_once();self.mocks[3].assert_called_once()
        self.assertEqual(self.lab.manifest(self.run_id)['pitch_revision'],lp.PITCH_REVISION)

    def test_melodia_hybrid_switch_preserves_emotions_and_all_pitch_variants(self):
        self.action('all');calls=len(self.calls);pyin_calls=self.mocks[5].call_count
        original={stem:lp.read_json(self.folder/'pitch_raw'/(stem+'.json')) for stem in lp.STEMS if stem!='drums'}
        colors=lp.read_json(self.folder/'mapped.json')['background']
        def melodia(audio,sr,stem,progress=None,high_pitch_bias=4.,voicing_tolerance=1.2):
            raw=self.mocks[5].side_effect(audio,sr,stem,progress)
            raw.update(method='melodia',confidence_kind='melodia_salience',settings={'high_pitch_bias':high_pitch_bias,'voicing_tolerance':voicing_tolerance})
            raw['voiced_probability']=[v*.2 for v in raw['voiced_probability']]
            return raw
        with patch.object(lp,'estimate_melodia',side_effect=melodia) as estimator:
            m=self.action('configure',parameters={'pitch_method':'hybrid'})
            self.assertEqual(m['stages']['mapping']['status'],'stale')
            self.assertTrue(all(m['stages'][stage]['status']=='ready' for stage in ('meter','separation','features','emotion')))
            self.action('mapping');self.assertEqual(estimator.call_count,3)
            self.assertEqual(self.mocks[5].call_count,pyin_calls);self.assertEqual(len(self.calls),calls)
            bundle=lp.read_json(self.folder/'mapped.json')
            self.assertEqual(bundle['background']['segments'],colors['segments'])
            self.assertEqual(bundle['whole_song_color'],lp.map_prediction_colors({'segments':[],'whole_song_prediction':lp.read_json(self.folder/'song_prediction.json')},self.lab.manifest(self.run_id)['parameters'])['whole_song_color'])
            for track in bundle['stems']:
                if track['id']=='drums':self.assertNotIn('pitch',track);continue
                engine='pyin' if track['id'] in ('bass','vocals') else 'melodia'
                self.assertEqual(track['pitch']['method'],engine)
                self.assertEqual(track['normalization']['y_source'],engine)
                self.assertEqual(track['pitch']['confidence_threshold'],.6 if engine=='pyin' else 0.)
                self.assertEqual(self.lab.inspect(self.run_id,track['id'])['pitch_raw']['method'],engine)
            self.action('configure',parameters={'melodia_high_pitch_bias':2.})
            self.action('mapping');self.assertEqual(estimator.call_count,6)
            self.action('configure',parameters={'melodia_high_pitch_bias':4.,'melodia_confidence_threshold':.05})
            self.action('mapping');self.assertEqual(estimator.call_count,6)  # cached bias 4; threshold is mapping only
            self.action('configure',parameters={'melodia_voicing_tolerance':.2})
            self.action('mapping');self.assertEqual(estimator.call_count,9)
            self.action('configure',parameters={'melodia_voicing_tolerance':1.2})
            self.action('mapping');self.assertEqual(estimator.call_count,9)
            self.action('configure',parameters={'pitch_method':'pyin'})
            self.action('mapping')
            self.assertEqual(self.mocks[5].call_count,pyin_calls)
            self.assertEqual(original,{stem:lp.read_json(self.folder/'pitch_raw'/(stem+'.json')) for stem in original})
            self.assertEqual(len(list((self.folder/'pitch_cache'/'other').glob('*.json'))),4)
            self.assertEqual(len(self.calls),calls)
            self.mocks[2].assert_called_once();self.mocks[3].assert_called_once()

    def test_foote_motion_reads_existing_plans_without_mutating_or_repredicting(self):
        self.action('all');calls=len(self.calls);pitch_calls=self.mocks[5].call_count
        mapped=lp.read_json(self.folder/'mapped.json')
        self.assertTrue(mapped['movement']['foote_motion_enabled'])
        expected={s:lp.foote_motion_curve(lp.read_json(self.folder/'plans'/(s+'.json'))) for s in lp.STEMS}
        self.assertEqual({t['id']:t['motion_foote'] for t in mapped['stems']},expected)
        for track in mapped['stems']:track.pop('motion_foote')
        lp.write_json(self.folder/'mapped.json',mapped)
        before=(self.folder/'mapped.json').read_bytes()
        curves=self.lab.motion_foote(self.run_id)
        self.assertEqual(curves['tracks'],expected);self.assertFalse(curves['inference'])
        self.assertEqual((self.folder/'mapped.json').read_bytes(),before)
        m=self.action('configure',parameters={'foote_motion_enabled':False})
        self.assertTrue(all(s['status']=='ready' for s in m['stages'].values()))
        saved=lp.read_json(self.folder/'mapped.json')
        self.assertFalse(saved['movement']['foote_motion_enabled']);self.assertFalse(saved['defaults']['foote_motion_enabled'])
        self.action('all');self.assertEqual(len(self.calls),calls);self.assertEqual(self.mocks[5].call_count,pitch_calls)

    def test_import_does_not_run_models_and_restore_is_durable(self):
        self.assertTrue(all(s['status']=='pending' for s in self.run['stages'].values()))
        for mock in self.mocks[2:]:mock.assert_not_called()
        self.assertTrue((self.folder/'source.wav').is_file())
        again=self.lab.upload(self.source,'different.wav','a'*64,self.progress)
        self.assertEqual(again['name'],'试验曲.wav')
        self.assertEqual(len(lp.Lab(self.lab.root).list_runs()),1)
        self.assertEqual(lp.Lab(self.lab.root).snapshot(self.run_id)['sha256'],'a'*64)

    def test_features_preserve_long_bar_and_export_exact_context(self):
        with self.assertRaisesRegex(ValueError,'请先完成'):self.action('features')
        self.features()
        self.mocks[2].assert_called_once();self.mocks[3].assert_called_once();self.mocks[4].assert_not_called()
        inspect=self.lab.inspect(self.run_id,'bass');plan=inspect['plan']
        self.assertEqual(len(plan['segment_rows']),3)
        self.assertEqual(plan['segment_rows'][1]['duration_seconds'],7.)
        self.assertTrue(all(r['prediction_end_sample']-r['prediction_start_sample']>=3*self.sr for r in plan['segment_rows']))
        clip,meta=self.lab.clip(self.run_id,'bass',1,'context')
        y,sr=sf.read(io.BytesIO(clip))
        original,_=sf.read(self.folder/'separated/bass.wav',start=meta['start_sample'],stop=meta['end_sample'])
        self.assertEqual(y.ndim,1);self.assertEqual(len(y),len(original));self.assertEqual(sr,self.sr)
        np.testing.assert_allclose(y,original.mean(axis=1)*self.lab.manifest(self.run_id)['preview_gain'],atol=3.1e-5)
        self.assertTrue((self.folder/'plans/bass.csv').is_file())
        self.assertEqual(inspect['motion']['sample_rate'],self.sr)

    def test_partial_prediction_mapping_and_color_only_recompute(self):
        self.features()
        result=self.action('emotion',stems=['bass'],bar_start=1,bar_end=1)
        self.assertEqual(result['stages']['emotion']['status'],'partial')
        self.assertEqual(result['stages']['emotion']['counts'],{'ok':1,'silent':0,'error':0,'pending':17})
        self.assertTrue(self.calls);self.assertTrue(all(n>=3*sr for sr,n,_ in self.calls))
        self.action('mapping');before=lp.read_json(self.folder/'mapped.json')
        self.assertEqual(sum(r['status']=='ok' for t in before['stems'] for r in t['segments']),1)
        self.assertTrue(before['warnings'])
        old_color=before['stems'][0]['segments'][0]['hue_degrees']
        model_calls=len(self.calls);meter_calls=self.mocks[2].call_count;sw_calls=self.mocks[3].call_count
        updated=self.action('configure',parameters={'hue_gamma':1.})
        self.assertEqual(updated['stages']['mapping']['status'],'stale')
        self.assertEqual(updated['stages']['emotion']['status'],'partial')
        self.action('mapping');after=lp.read_json(self.folder/'mapped.json')
        self.assertNotEqual(old_color,after['stems'][0]['segments'][0]['hue_degrees'])
        self.assertEqual(len(self.calls),model_calls);self.assertEqual(self.mocks[2].call_count,meter_calls);self.assertEqual(self.mocks[3].call_count,sw_calls)
        self.assertEqual(after['defaults']['hue_gamma'],1.)

    def test_subset_resume_and_force_preserve_other_completed_rows(self):
        self.features()
        self.action('emotion',stems=['bass','drums'],bar_start=1,bar_end=2)
        before=lp.read_json(self.folder/'emotions/drums.json')
        count=len(self.calls)
        self.action('emotion',stems=['bass','drums'],bar_start=1,bar_end=2)
        self.assertEqual(len(self.calls),count)
        self.action('emotion',stems=['bass'],bar_start=1,bar_end=1,force=True)
        self.assertGreater(len(self.calls),count)
        after=lp.read_json(self.folder/'emotions/drums.json')
        self.assertEqual(before['segments'],after['segments'])
        bass=lp.read_json(self.folder/'emotions/bass.json')['segments']
        self.assertEqual([r['status'] for r in bass],['ok','ok','pending'])
        self.action('emotion',stems=['piano'],bar_start=1,bar_end=3)
        self.assertEqual(self.lab.manifest(self.run_id)['stages']['emotion']['counts']['silent'],3)

    def test_changed_context_invalidates_results_but_keeps_separation(self):
        self.features();self.action('emotion',stems=['bass'],bar_start=1,bar_end=1);self.action('mapping')
        m=self.action('configure',parameters={'target_seconds':8.})
        self.assertEqual(m['stages']['separation']['status'],'ready')
        self.assertEqual(m['stages']['features']['status'],'stale')
        self.assertIsNone(self.lab.inspect(self.run_id,'bass')['emotion'])
        self.assertTrue((self.folder/'emotions/bass.json').is_file())
        self.assertTrue(any(x['path']=='mapped.json' and not x['current'] for x in m['artifacts']))
        with self.assertRaises(ValueError):self.action('mapping')
        self.action('features');self.action('emotion',stems=['drums'],bar_start=1,bar_end=1)
        self.assertEqual(lp.read_json(self.folder/'emotions/bass.json')['segments'][0]['status'],'pending')
        self.mocks[3].assert_called_once()

    def test_failure_keeps_full_trace_and_parameter_validation_is_atomic(self):
        self.features();before=self.lab.manifest(self.run_id)
        with self.assertRaises(ValueError):self.action('configure',parameters={'target_seconds':2.})
        self.assertEqual(self.lab.manifest(self.run_id)['parameters'],before['parameters'])
        with patch.object(lp,'create_tester',side_effect=RuntimeError('missing checkpoint')):
            with self.assertRaises(RuntimeError):self.action('emotion',stems=['bass'],bar_start=1,bar_end=1)
        m=self.lab.snapshot(self.run_id)
        self.assertEqual(m['stages']['emotion']['status'],'error')
        error=lp.read_json(self.folder/'errors/emotion.json')
        self.assertIn('missing checkpoint',error['traceback'])
        self.assertTrue((self.folder/'emotions/bass.json').is_file())
        self.action('emotion',stems=['bass'],bar_start=1,bar_end=1)
        self.assertEqual(self.lab.manifest(self.run_id)['stages']['emotion']['counts']['ok'],1)

    def test_http_page_artifacts_ranges_traversal_and_async_action(self):
        jobs=Jobs(cache_root=Path(self.tmp.name)/'old')
        server=make_server(0,jobs=jobs,lab=self.lab)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
        def get(path,headers=None):
            conn.request('GET',path,headers=headers or {});r=conn.getresponse();return r.status,r.read(),dict(r.getheaders())
        try:
            status,body,_=get('/lab/');self.assertEqual(status,200);self.assertIn('分轨实验台 R56',body.decode())
            status,body,_=get('/api/lab/runs');self.assertEqual(len(json.loads(body)['runs']),1)
            status,body,_=get('/api/lab/defaults');self.assertEqual(status,200);self.assertFalse(json.loads(body)['custom'])
            conn.request('POST','/api/lab/defaults',json.dumps({'parameters':{'hue_gamma':1.7},'presentation':{'size_percent':140}}),{'X-Spectra-Client':'1','Content-Type':'application/json'})
            r=conn.getresponse();self.assertEqual(r.status,200);self.assertEqual(json.loads(r.read())['parameters']['hue_gamma'],1.7)
            status,body,_=get('/api/lab/defaults');self.assertEqual(json.loads(body)['presentation']['size_percent'],140)

            prefix='/api/lab/runs/'+self.run_id
            status,body,headers=get(prefix+'/files/listen.wav',{'Range':'bytes=0-43'})
            self.assertEqual(status,206);self.assertEqual(len(body),44);self.assertTrue(body.startswith(b'RIFF'));self.assertIn('Content-Range',headers)
            status,_,_=get(prefix+'/files/../../README.md');self.assertEqual(status,404)
            status,_,_=get(prefix+'/files/%2e%2e/%2e%2e/manifest.json');self.assertEqual(status,404)
            conn.request('POST',prefix+'/action',json.dumps({'stage':'meter'}),{'X-Spectra-Client':'1','Content-Type':'application/json'})
            response=conn.getresponse();self.assertEqual(response.status,202);job_id=json.loads(response.read())['job_id']
            jobs.executor.submit(lambda:None).result(timeout=10)
            status,body,_=get('/api/jobs/'+job_id);job=json.loads(body)
            self.assertEqual(job['status'],'done');self.assertEqual(job['result']['stages']['meter']['bars'],3)
            status,body,_=get(prefix+'/inspect?stem=bass');self.assertEqual(len(json.loads(body)['meter']['segments']),3)
            payload=self.source.read_bytes()
            conn.request('POST','/api/lab/upload',payload,{'X-Spectra-Client':'1','X-Audio-Name':'new.wav','Content-Type':'application/octet-stream'})
            response=conn.getresponse();self.assertEqual(response.status,202);job_id=json.loads(response.read())['job_id']
            jobs.executor.submit(lambda:None).result(timeout=10)
            status,body,_=get('/api/jobs/'+job_id);job=json.loads(body)
            self.assertEqual(job['status'],'done');self.assertEqual(job['result']['name'],'new.wav')
            self.assertTrue(all(s['status']=='pending' for s in job['result']['stages'].values()))
            self.mocks[2].assert_called_once();self.mocks[3].assert_not_called();self.mocks[4].assert_not_called()
        finally:
            conn.close();server.shutdown();server.server_close();jobs.executor.shutdown();thread.join(2)

    def test_user_defaults_persist_across_restart_apply_to_new_songs_and_preserve_existing_results(self):
        self.action('all');calls=len(self.calls)
        before_manifest=(self.folder/'manifest.json').read_bytes();before_mapped=(self.folder/'mapped.json').read_bytes()
        self.assertFalse(self.lab.defaults()['custom'])
        profile=self.lab.save_defaults({'parameters':{'target_seconds':9.,'hue_gamma':1.3,'texture_pigment_strength':.7},
            'presentation':{'size_percent':180,'pitch_mode':'continuous','video_resolution':720,'video_fps':60,'guides':False}})
        restored=lp.Lab(self.lab.root).defaults()
        self.assertEqual(restored['parameters'],profile['parameters']);self.assertEqual(restored['presentation'],profile['presentation'])
        self.assertEqual(before_manifest,(self.folder/'manifest.json').read_bytes());self.assertEqual(before_mapped,(self.folder/'mapped.json').read_bytes())
        fresh=self.lab.upload(self.source,'另一首.wav','b'*64,self.progress)
        self.assertEqual(fresh['parameters']['target_seconds'],9.);self.assertEqual(fresh['parameters']['hue_gamma'],1.3)
        self.assertEqual(fresh['presentation']['size_percent'],180);self.assertEqual(fresh['presentation']['video_fps'],60)
        self.assertTrue(all(s['status']=='pending' for s in fresh['stages'].values()))
        again=self.lab.upload(self.source,'同曲改名.wav','a'*64,self.progress)
        self.assertEqual(again['parameters']['target_seconds'],6.);self.assertEqual(len(self.calls),calls)
        self.mocks[2].assert_called_once();self.mocks[3].assert_called_once()

    def test_invalid_default_profiles_never_replace_valid_profile_and_presentation_only_saves_do_not_invalidate(self):
        self.action('all');calls=len(self.calls)
        self.lab.save_defaults({'parameters':{'hue_gamma':1.4}})
        path=self.lab.root/'defaults.json';before=path.read_bytes()
        for options in ({'parameters':{'target_seconds':2}}, {'presentation':{'size_percent':0}}, {'presentation':{'video_fps':0}}, {'parameters':{'unknown':1}}):
            with self.assertRaises(ValueError):self.lab.save_defaults(options)
            self.assertEqual(path.read_bytes(),before)
        result=self.action('configure',presentation={'size_percent':170,'pitch_mode':'continuous','video_fps':60})
        self.assertEqual(result['presentation']['size_percent'],170)
        self.assertTrue(all(s['status']=='ready' for s in result['stages'].values()))
        self.assertEqual(len(self.calls),calls)

    def test_all_executes_all_six_stems_all_bars_then_reuses_completed_stages(self):
        self.action('all',stems=['bass'],bar_start=1,bar_end=1)
        m=self.lab.manifest(self.run_id)
        self.assertTrue(all(v['status']=='ready' for v in m['stages'].values()))
        self.assertEqual(m['stages']['emotion']['counts'],{'ok':15,'silent':3,'error':0,'pending':0})
        self.assertEqual(m['stages']['emotion']['song_status'],'ok')
        self.mocks[2].assert_called_once();self.mocks[3].assert_called_once()
        calls=len(self.calls)
        self.action('all')
        self.assertEqual(len(self.calls),calls)
        self.mocks[2].assert_called_once();self.mocks[3].assert_called_once()
        self.action('all',parameters={'hue_gamma':1.})
        self.assertEqual(len(self.calls),calls)
        self.assertEqual(lp.read_json(self.folder/'mapped.json')['defaults']['hue_gamma'],1.)

    def test_background_is_independent_full_mix_prediction_and_remaps_without_model(self):
        self.features();self.action('emotion',stems=['bass'],bar_start=1,bar_end=1);self.action('mapping')
        song=lp.read_json(self.folder/'song_prediction.json')
        self.assertEqual(song['prediction_input'],'original_full_mix_mono')
        self.assertEqual(song['start_sample'],0);self.assertEqual(song['end_sample'],len(self.audio))
        self.assertAlmostEqual(song['arousal'],3+float(np.std(self.audio.mean(axis=1)))*20,places=5)
        self.assertTrue(any(n==len(self.audio) for _,n,_ in self.calls))
        bundle=lp.read_json(self.folder/'mapped.json')
        self.assertEqual(bundle['whole_song_color']['analysis_scope'],'whole_track')
        self.assertEqual(bundle['whole_song_mapping']['statistics_scope'],'whole_song_prediction_only')
        self.assertEqual(bundle['whole_song_color']['arousal'],song['arousal'])
        self.assertNotIn('funny',bundle['whole_song_color']['tag_scores'])
        calls=len(self.calls)
        self.action('emotion',stems=['drums'],bar_start=1,bar_end=1)
        self.assertEqual(sum(n==len(self.audio) for _,n,_ in self.calls),1)
        self.action('mapping')
        self.assertEqual(lp.read_json(self.folder/'mapped.json')['whole_song_color'],bundle['whole_song_color'])
        self.action('configure',parameters={'hue_gamma':1.});self.action('mapping')
        self.assertNotEqual(lp.read_json(self.folder/'mapped.json')['whole_song_color']['hue_degrees'],bundle['whole_song_color']['hue_degrees'])
        self.assertEqual(len(self.calls),calls+1)

    def test_all_resumes_after_stage_failure_and_keeps_completed_meter(self):
        with patch.object(lp,'separate_source',side_effect=RuntimeError('no VRAM')):
            with self.assertRaisesRegex(RuntimeError,'no VRAM'):self.action('all')
        m=self.lab.manifest(self.run_id)
        self.assertEqual(m['stages']['meter']['status'],'ready')
        self.assertEqual(m['stages']['separation']['status'],'error')
        self.assertEqual(m['stages']['features']['status'],'pending')
        self.action('all')
        self.mocks[2].assert_called_once()
        self.assertEqual(self.lab.manifest(self.run_id)['stages']['mapping']['status'],'ready')

    def test_upgrade_reuses_r34_stem_predictions_and_only_adds_full_song(self):
        self.action('all')
        m=lp.read_json(self.folder/'manifest.json')
        m.pop('lab_revision');m['stages']['emotion'].pop('song_status')
        lp.write_json(self.folder/'manifest.json',m)
        (self.folder/'song_prediction.json').unlink()
        self.assertEqual(self.lab.snapshot(self.run_id)['stages']['mapping']['status'],'stale')
        calls=len(self.calls)
        self.action('all')
        self.assertEqual(len(self.calls),calls+1)
        self.assertEqual(self.calls[-1][1],len(self.audio))
        self.mocks[2].assert_called_once();self.mocks[3].assert_called_once()
        self.assertEqual(self.lab.manifest(self.run_id)['lab_revision'],37)

    def test_dynamic_background_and_beat_motion_export_from_original_mix(self):
        self.action('all')
        bundle=lp.read_json(self.folder/'mapped.json')
        raw=lp.read_json(self.folder/'background_prediction.json')
        self.assertEqual(raw['prediction_input'],'original_mix_bar_context')
        self.assertEqual(len(raw['segments']),len(bundle['bars']))
        self.assertEqual(bundle['background']['source'],'original_mix_bar_context')
        self.assertGreater(len({r['hex'] for r in bundle['background']['segments']}),1)
        for track in bundle['stems']:
            self.assertEqual(track['beat_motion']['rows'][0]['start_seconds'],0.)
            self.assertEqual(track['beat_motion']['rows'][-1]['end_seconds'],12.)
            self.assertEqual(len(track['beat_motion']['rows']),24)
            self.assertEqual(track['normalization']['centroid_scope'],'this_stem_valid_beat_means')
            self.assertTrue((self.folder/'beat_motion'/(track['id']+'.csv')).is_file())
        calls=len(self.calls)
        self.action('configure',parameters={'hue_gamma':1.5});self.action('mapping')
        self.assertEqual(len(self.calls),calls)
        # Real Python export is consumed by the JS clock/position/color checks.
        fixture=json.loads(json.dumps(bundle))
        for track in fixture['stems']:
            motion=track['motion'];indices=list(range(0,len(motion['times']),5))
            if indices[-1]!=len(motion['times'])-1:indices.append(len(motion['times'])-1)
            for key in ('times','rms','raw_rms','centroid_hz','centroid_normalized'):
                motion[key]=[motion[key][i] for i in indices]
        lp.write_json(Path(__file__).parent/'spectra_tests/fixtures/lab-r37.json',fixture)

    def test_r36_upgrade_only_adds_original_background_not_stem_inference(self):
        self.action('all')
        m=lp.read_json(self.folder/'manifest.json');m['lab_revision']=35
        m['stages']['emotion'].pop('background_status')
        lp.write_json(self.folder/'manifest.json',m)
        (self.folder/'background_prediction.json').unlink()
        before=[lp.read_json(self.folder/'emotions'/(s+'.json')) for s in lp.STEMS]
        self.assertEqual(self.lab.snapshot(self.run_id)['stages']['mapping']['status'],'stale')
        calls=len(self.calls)
        self.action('all')
        self.assertGreater(len(self.calls),calls)
        self.mocks[2].assert_called_once();self.mocks[3].assert_called_once()
        self.assertEqual(before,[lp.read_json(self.folder/'emotions'/(s+'.json')) for s in lp.STEMS])
        self.assertEqual(self.lab.manifest(self.run_id)['stages']['emotion']['background_status'],'ok')

    def test_geometry_parameters_save_without_invalidating_or_rerunning_models(self):
        self.action('all');calls=len(self.calls)
        multipliers={s:(i+1)/4 for i,s in enumerate(lp.STEMS)}
        material={'texture_enabled':False,'texture_paper_strength':.45,'texture_pigment_strength':.6,'texture_edge_strength':.1,'drums_outline_gap':9.,'drums_inner_ratio':.25}
        m=self.action('configure',parameters={**material,'outline_arousal_scale':2.,'outline_enabled':False,'rotation_enabled':False,
            **{'outline_'+s+'_enabled':s in ('vocals','bass','other') for s in lp.STEMS},
            **{'outline_'+s+'_multiplier':v for s,v in multipliers.items()}})
        self.assertTrue(all(s['status']=='ready' for s in m['stages'].values()))
        bundle=lp.read_json(self.folder/'mapped.json')
        self.assertEqual(bundle['geometry']['parameters']['outline_arousal_scale'],2.)
        self.assertFalse(bundle['geometry']['outline']);self.assertFalse(bundle['geometry']['rotation']['enabled'])
        self.assertEqual(bundle['geometry']['outline_multipliers'],multipliers)
        for key,value in material.items():
            self.assertEqual(bundle['geometry']['parameters'][key],value)
            self.assertEqual(bundle['defaults'][key],value)
            self.assertEqual(m['parameters'][key],value)
        self.assertEqual(bundle['geometry']['material']['revision'],1)
        self.assertEqual(bundle['geometry']['drums_outline']['inner_ratio'],.25)
        self.assertEqual(bundle['geometry']['drums_outline']['gap_540p'],9.)
        for s in lp.STEMS:
            self.assertEqual(bundle['geometry']['outline_instruments'][s],s in ('vocals','bass','other'))
            self.assertEqual(bundle['defaults']['outline_'+s+'_multiplier'],multipliers[s])
            self.assertEqual(m['parameters']['outline_'+s+'_multiplier'],multipliers[s])
            self.assertEqual(bundle['defaults']['outline_'+s+'_enabled'],s in ('vocals','bass','other'))
            self.assertEqual(m['parameters']['outline_'+s+'_enabled'],s in ('vocals','bass','other'))
        self.assertEqual(bundle['geometry']['type'],'instrument_identity')
        self.assertEqual(bundle['geometry']['outline_color'],'#000000')
        self.assertEqual(bundle['geometry']['input_range'],[1,9])
        self.assertEqual(bundle['defaults']['outline_arousal_scale'],2.)
        self.action('configure',parameters={'outline_enabled':True,'rotation_enabled':True})
        enabled=lp.read_json(self.folder/'mapped.json')['geometry']
        self.assertTrue(enabled['outline']);self.assertTrue(enabled['rotation']['enabled'])
        self.action('all');self.assertEqual(len(self.calls),calls)
        self.mocks[2].assert_called_once();self.mocks[3].assert_called_once()


    def test_stable_instrument_shapes_and_diagnostic_means_are_exported(self):
        self.action('all')
        bundle=lp.read_json(self.folder/'mapped.json')
        for track in bundle['stems']:
            reference=track['shape_reference'];valid=[r for r in track['segments'] if r['status']=='ok']
            self.assertTrue(reference['complete']);self.assertEqual(reference['valid_segments'],len(valid))
            self.assertEqual(reference['total_segments'],len(track['segments']))
            if not valid:
                self.assertIsNone(reference['valence_mean']);continue
            self.assertAlmostEqual(reference['valence_mean'],sum(r['valence'] for r in valid)/len(valid))
            self.assertAlmostEqual(reference['arousal_mean'],sum(r['arousal'] for r in valid)/len(valid))
            self.assertEqual(track['shape_identity'],lp.INSTRUMENT_SHAPES[track['id']])
            self.assertTrue(all(r['geometry_kind']==lp.INSTRUMENT_SHAPES[track['id']]['kind'] for r in valid))
        self.assertEqual(bundle['geometry']['default_size_percent'],100)
        self.assertEqual(bundle['geometry']['instrument_shapes'],lp.INSTRUMENT_SHAPES)
        rows=[dict(status='ok',valence=v,arousal=a) for v,a in [(7,7),(7,3),(3,3),(3,7)]]
        rows += [dict(status='silent',valence=100,arousal=100),dict(status='pending')]
        track={'id':'guitar','segments':rows};reference=lp.attach_geometry_reference(track)
        self.assertEqual((reference['valence_mean'],reference['arousal_mean']),(5,5))
        self.assertFalse(reference['complete'])
        self.assertEqual([r['geometry_kind'] for r in rows],['triangle_up']*4+[None,None])


    def test_occlusion_and_rotation_references_export_per_stem_percentiles(self):
        self.action('all');bundle=lp.read_json(self.folder/'mapped.json')
        self.assertEqual(bundle['geometry']['draw_order_back_to_front'],['bass','guitar','piano','other','drums','vocals'])
        self.assertEqual(bundle['geometry']['layer_order_front_to_back'],['vocals','drums','other','piano','guitar','bass'])
        self.assertTrue(bundle['geometry']['rotation']['enabled'])
        for track in bundle['stems']:
            r=track['rotation_reference'];valid=[row['valence'] for row in track['segments'] if row['status']=='ok']
            self.assertEqual(r['valid_segments'],len(valid));self.assertTrue(r['complete'])
            if valid:self.assertAlmostEqual(r['valence_low'],float(np.percentile(valid,10)));self.assertAlmostEqual(r['valence_high'],float(np.percentile(valid,90)))
            else:self.assertIsNone(r['valence_low']);self.assertTrue(r['constant'])
        rows=[dict(status='ok',valence=v,arousal=5) for v in [1,3,5,7,9]]
        rows += [dict(status='silent',valence=100,arousal=5),dict(status='pending')]
        track={'id':'guitar','segments':rows};lp.attach_geometry_reference(track);r=track['rotation_reference']
        self.assertAlmostEqual(r['valence_low'],1.8);self.assertAlmostEqual(r['valence_high'],8.2)
        self.assertFalse(r['complete']);self.assertFalse(r['constant'])


    def test_geometry_upgrade_uses_only_mapping_and_keeps_audio_and_emotion_cache(self):
        self.action('all');calls=len(self.calls)
        m=lp.read_json(self.folder/'manifest.json');m['geometry_revision']=40
        lp.write_json(self.folder/'manifest.json',m)
        self.assertEqual(self.lab.manifest(self.run_id)['stages']['mapping']['status'],'stale')
        self.action('all');self.assertEqual(len(self.calls),calls)
        self.mocks[2].assert_called_once();self.mocks[3].assert_called_once()
        self.assertEqual(self.lab.manifest(self.run_id)['geometry_revision'],47)


    def test_beat_volume_export_inspection_and_upgrade_reuse_model_cache(self):
        self.action('all');calls=len(self.calls)
        bundle=lp.read_json(self.folder/'mapped.json')
        for track in bundle['stems']:
            mode='realtime' if track['id']=='drums' else 'beat_average'
            self.assertEqual(bundle['volume']['instrument_modes'][track['id']],mode)
            if track['id']=='drums':
                self.assertNotIn('beat_volume',track)
                self.assertIsNone(self.lab.inspect(self.run_id,'drums')['beat_volume'])
                continue
            volume=track['beat_volume']
            self.assertEqual(len(volume['rows']),24)
            self.assertEqual(volume['rows'][0]['start_seconds'],0.)
            self.assertEqual(volume['rows'][-1]['end_seconds'],12.)
            self.assertTrue(volume['include_silence'])
            self.assertTrue((self.folder/'beat_volume'/(track['id']+'.csv')).is_file())
            self.assertEqual(self.lab.inspect(self.run_id,track['id'])['beat_volume'],volume)
        m=lp.read_json(self.folder/'manifest.json');m.pop('volume_revision');lp.write_json(self.folder/'manifest.json',m)
        self.assertEqual(self.lab.manifest(self.run_id)['stages']['mapping']['status'],'stale')
        artifacts=[a for a in self.lab.snapshot(self.run_id)['artifacts'] if a['path'].startswith('beat_volume/')]
        self.assertTrue(artifacts);self.assertTrue(all(a['stage']=='mapping' and not a['current'] for a in artifacts))
        self.action('all');self.assertEqual(len(self.calls),calls)
        self.mocks[2].assert_called_once();self.mocks[3].assert_called_once()
        self.assertEqual(self.lab.manifest(self.run_id)['volume_revision'],41)


class ParameterChecks(unittest.TestCase):
    def test_validation_and_dependency_groups(self):
        for patch in ({'pitch_method':'unknown'},{'melodia_voicing_tolerance':2},{'melodia_high_pitch_bias':7},{'melodia_high_pitch_bias':True},{'melodia_confidence_threshold':-1},{'melodia_high_pitch_bias':float('nan')},{'pitch_confidence_threshold':1.1},{'pitch_confidence_threshold':float('nan')},{'hue_gamma':float('nan')},{'amp':'yes'},{'saturation_range':[.9,.1]},{'minimum_seconds':1},{'chunk_seconds':3},
                      {'outline_enabled':1},{'foote_motion_enabled':1},{'rotation_enabled':'true'},*({'outline_'+s+'_enabled':1} for s in lp.STEMS),*({'outline_'+s+'_multiplier':v} for s in lp.STEMS for v in (-1,11,True,float('nan'))),{'rectangle_aspect':0},{'outline_arousal_scale':0},{'outline_arousal_scale':float('nan')},{'shape_p':-1},{'shape_r_low':3,'shape_r_high':2},{'orientation_v_low':7,'orientation_v_high':3}):
            with self.assertRaises(ValueError):lp.validate_parameters(patch)
        self.assertEqual(lp.affected_stages(['hue_gamma']),{'mapping'})
        self.assertEqual(lp.affected_stages(['pitch_confidence_threshold','pitch_method','melodia_high_pitch_bias','melodia_voicing_tolerance','melodia_confidence_threshold']),{'mapping'})
        self.assertEqual(lp.affected_stages(['target_seconds']),{'features','emotion','mapping'})
        self.assertNotIn('separation',lp.affected_stages(['beat_model']))
        self.assertEqual(lp.affected_stages(list(lp.GEOMETRY_DEFAULTS)),set())


if __name__=='__main__':unittest.main()
