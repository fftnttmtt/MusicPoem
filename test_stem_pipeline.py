import json
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
import numpy as np
import soundfile as sf

from beat_core import build_analysis
from stem_features import realtime_features, normalize_arousal
import stem_pipeline as pipeline


class StemFeatureChecks(unittest.TestCase):
    def test_uploaded_sw_config_fingerprint_and_six_stem_order_are_preserved(self):
        import yaml
        path=Path(pipeline.sw.__file__).parent/'model_config.yaml'
        self.assertEqual(pipeline.sw.file_sha256(path),pipeline.sw.CONFIG_SHA256)
        config=yaml.load(path.read_text(),Loader=yaml.BaseLoader)
        self.assertEqual(int(config['model']['num_stems']),6)
        self.assertEqual(tuple(config['training']['instruments']),pipeline.STEMS)
        self.assertEqual(int(config['audio']['sample_rate']),44100)

    def test_stereo_phase_and_independent_centroid_ranges(self):
        sr=8000;t=np.arange(2*sr)/sr
        low=np.sin(2*np.pi*np.where(t<1,200*t,400*t))*.1
        high=np.sin(2*np.pi*np.where(t<1,1200*t,2400*t))*.2
        a=realtime_features(np.column_stack([low,-low]),sr)
        b=realtime_features(np.column_stack([high,-high]),sr)
        self.assertGreater(a['rms_peak'],.06)
        self.assertAlmostEqual(b['rms_peak']/a['rms_peak'],2,delta=.03)
        self.assertGreater(b['centroid_min_hz'],a['centroid_min_hz'])
        for motion in [a,b]:
            active=np.asarray(motion['raw_rms'])>=10**(-55/20)
            normalized=np.asarray(motion['centroid_normalized'])[active]
            self.assertAlmostEqual(normalized.min(),0)
            self.assertAlmostEqual(normalized.max(),1)

    def test_constant_arousal_centers_and_silence_is_excluded(self):
        rows=[dict(status='ok',arousal=5),dict(status='silent',arousal=None),dict(status='ok',arousal=5)]
        stats=normalize_arousal(rows)
        self.assertEqual(stats['arousal_min'],5)
        self.assertEqual([r['x_normalized'] for r in rows],[.5,None,.5])
        motion=realtime_features(np.zeros((8000,2),dtype=np.float32),8000)
        self.assertEqual(motion['active_frame_count'],0)
        self.assertEqual(motion['rms_peak'],0)
        self.assertTrue(all(v==.5 for v in motion['centroid_normalized']))

    def test_realtime_envelopes_do_not_borrow_a_future_attack(self):
        sr=8000;audio=np.zeros((sr*2,2),dtype=np.float32)
        t=np.arange(sr)/sr;audio[sr:]=(.2*np.sin(2*np.pi*440*t))[:,None]
        motion=realtime_features(audio,sr)
        for time,rms in zip(motion['times'],motion['rms']):
            if time<=1:self.assertEqual(rms,0)


class StemPipelineChecks(unittest.TestCase):
    def test_whole_pipeline_preserves_bars_same_stem_context_and_reuses_cache(self):
        sr=44100;t=np.arange(sr*12)/sr
        wave=(.15*np.sin(2*np.pi*220*t)*(1+.3*np.sin(t))).astype(np.float32)
        mix=np.column_stack([wave,wave]);observed=[]
        analysis=build_analysis(mix,sr,np.arange(0,12,.5),[0,2,9,12],model='final0',device='cuda')
        class FakeTester:
            def predict(self,path,threshold):
                y,rate=sf.read(path);observed.append((rate,len(y),float(np.sqrt(np.mean(y*y)))))
                return dict(arousal=3+min(4,float(np.std(y))*20),valence=6.,
                    scores=[{'tag':'happy','score':.7},{'tag':'sad','score':.2},{'tag':'funny','score':1.}])
        def separated(audio,folder,**kwargs):
            sf.write(folder/'mixture.wav',audio,sr,subtype='FLOAT')
            (folder/'preview').mkdir(exist_ok=True)
            sf.write(folder/'preview/mixture.wav',audio,sr,subtype='PCM_16')
            for i,name in enumerate(pipeline.STEMS):
                signal=audio*(i+1)/6 if name!='piano' else np.zeros_like(audio)
                sf.write(folder/(name+'.wav'),signal,sr,subtype='FLOAT')
        with tempfile.TemporaryDirectory() as tmp:
            source=Path(tmp)/'source.wav';sf.write(source,mix,sr)
            root=Path(tmp)/'runs'
            with patch.object(pipeline,'decode_audio',return_value=mix),patch.object(pipeline,'detect_meter',return_value=analysis) as meter,\
                 patch.object(pipeline,'separate_source',side_effect=separated) as separator,patch.object(pipeline,'create_tester',return_value=FakeTester()) as tester:
                result=pipeline.predict_stems_file(source,cache_root=root)
                self.assertEqual(result['schema'],'spectra-stems-v1')
                self.assertEqual(len(result['bars']),3)
                self.assertEqual(result['bars'][1]['end_seconds']-result['bars'][1]['start_seconds'],7)
                self.assertEqual(len(result['stems']),6)
                for track in result['stems']:
                    self.assertEqual(len(track['segments']),3)
                    for row,bar in zip(track['segments'],result['bars']):
                        self.assertEqual(row['start_seconds'],bar['start_seconds'])
                        self.assertEqual(row['end_seconds'],bar['end_seconds'])
                        self.assertNotIn('funny',row['tag_scores'])
                        self.assertGreaterEqual(row['prediction_end_seconds']-row['prediction_start_seconds'],3)
                        self.assertEqual(row['status']=='ok',track['id']!='piano')
                self.assertTrue(all(rate==sr and length>=3*sr for rate,length,_ in observed))
                self.assertEqual(result['volume']['reference_rms'],max(t['motion']['rms_peak'] for t in result['stems']))
                self.assertTrue((root/result['run_id']/'stems.spectra.json').exists())
                again=pipeline.predict_stems_file(source,cache_root=root)
                self.assertTrue(again['cache_hit']);meter.assert_called_once();separator.assert_called_once();tester.assert_called_once()
                fixture=Path(__file__).parent/'spectra_tests/fixtures/stems-prediction.json'
                # Keep only a few real feature samples for the cross-language contract fixture.
                exported=json.loads(json.dumps(result))
                for track in exported['stems']:
                    motion=track['motion'];indices=list(range(0,len(motion['times']),10))
                    if indices[-1]!=len(motion['times'])-1:indices.append(len(motion['times'])-1)
                    for key in ['times','rms','raw_rms','centroid_hz','centroid_normalized']:
                        motion[key]=[motion[key][i] for i in indices]
                fixture.write_text(json.dumps(exported,ensure_ascii=False),encoding='utf-8')

    def test_short_leading_inherits_first_bar_context_and_long_bar_stays_whole(self):
        sr=8000;y=np.ones((12*sr,2),dtype=np.float32)*.1
        analysis=build_analysis(y,sr,np.arange(0,12,.5),[.4,4,11],model='final0',device='cpu')
        plan=pipeline.make_stem_plan(y,sr,analysis)
        leading,first,long=plan['segment_rows'][:3]
        self.assertTrue(leading['independent_prediction_skipped'])
        self.assertEqual(leading['prediction_start_sample'],first['prediction_start_sample'])
        self.assertEqual(leading['prediction_end_sample'],first['prediction_end_sample'])
        self.assertEqual(long['end_sample']-long['start_sample'],7*sr)
        self.assertFalse(long['forced_split'])


if __name__=='__main__':unittest.main()
