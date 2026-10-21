"""Pitch statistics, missing-data holds and real CPU pYIN on known signals."""
import importlib.util
import unittest
import numpy as np
from pitch_features import estimate_pitch,pitch_features
from stem_features import normalize_arousal
from beat_centroid import beat_centroid_features


def raw(times,midi,prob=None,voiced=None):
    return {'times':list(times),'f0_hz':[440*2**((m-69)/12) if m is not None else None for m in midi],
        'voiced_flag':voiced or [m is not None for m in midi],
        'voiced_probability':prob or [.95]*len(times),'rms':[.1]*len(times)}


class PitchChecks(unittest.TestCase):
    def test_beat_medians_use_log_pitch_and_reject_low_confidence_without_bridging_gaps(self):
        r=raw(np.arange(0,3,.25),[57,81,100,None,None,None,None,None,57,57,57,57],
            prob=[.95,.95,.1,0.,0.,0.,0.,0.,.95,.95,.95,.95])
        p=pitch_features(r,[0,1,2],3.,.6)
        self.assertEqual(p['rows'][0]['midi'],69.)  # median MIDI = A4, not mean Hz
        self.assertEqual(p['rows'][1]['status'],'unvoiced')
        self.assertEqual(p['rows'][1]['from_midi'],69.)
        self.assertEqual(p['rows'][1]['target_midi'],69.)
        self.assertEqual(p['rows'][2]['midi'],57.)
        c=p['continuous'];gap=[x for x in c if .5<=x['start_seconds']<2]
        self.assertTrue(all(x['from_midi']==x['target_midi'] for x in gap))
        self.assertTrue(all(x['from_midi']==gap[0]['from_midi'] for x in gap))
        self.assertEqual(p['valid_frames'],6)

    def test_coordinate_percentiles_clip_outliers_and_center_constant_or_missing_tracks(self):
        values=[12]+list(np.linspace(60,72,98))+[120]
        p=pitch_features(raw(range(100),values),range(100),100.)
        self.assertAlmostEqual(p['midi_p5'],float(np.percentile(values,5)))
        self.assertAlmostEqual(p['midi_p95'],float(np.percentile(values,95)))
        self.assertEqual(p['rows'][0]['target_normalized'],0.)
        self.assertEqual(p['rows'][-1]['target_normalized'],1.)
        rows=[{'status':'ok','arousal':v} for v in [1]+[4]*50+[6]*50+[9]]
        norm=normalize_arousal(rows,percentiles=[5,95])
        self.assertEqual((norm['arousal_min'],norm['arousal_max']),(4.,6.))
        self.assertEqual(rows[0]['x_normalized'],0.);self.assertEqual(rows[-1]['x_normalized'],1.)
        empty=pitch_features(raw([0.,.5,1.],[None]*3),[0.,1.],2.)
        self.assertEqual(empty['coverage'],0.);self.assertIsNone(empty['midi_p5'])
        self.assertTrue(all(r['from_normalized']==r['target_normalized']==.5 for r in empty['rows']+empty['continuous']))
        constant=pitch_features(raw([0.,1.,2.],[69.]*3),[0.,1.,2.],3.)
        self.assertTrue(all(r['target_normalized']==.5 for r in constant['rows']))

    def test_drum_centroid_uses_beat_mean_percentiles_and_holds_silence(self):
        values=[1]+[100]*10+[200]*10+[10000]
        motion={'times':list(range(23)),'centroid_hz':[0]+values,'raw_rms':[0]+[.1]*22,'rms':[0]+[.1]*22}
        p=beat_centroid_features(motion,list(range(22)),22.,percentiles=[5,95])
        self.assertEqual((p['centroid_min_hz'],p['centroid_max_hz']),(100.,200.))
        self.assertEqual(p['rows'][0]['target_normalized'],0.)
        self.assertEqual(p['rows'][-1]['target_normalized'],1.)

    @unittest.skipUnless(importlib.util.find_spec('librosa'),'librosa is required for real CPU pYIN checks')
    def test_real_pyin_low_bass_and_antiphase_vocal_are_on_the_original_clock(self):
        sr=11025;t=np.arange(sr*2)/sr
        for stem,hz in [('bass',55.),('vocals',440.)]:
            mono=(.2*np.sin(2*np.pi*hz*t)).astype(np.float32)
            r=estimate_pitch(np.column_stack([mono,-mono]),sr,stem)
            p=pitch_features(r,[0.,.5,1.,1.5],2.)
            self.assertGreater(p['coverage'],.7)
            self.assertLess(abs(np.median([m['midi'] for m in p['rows']])- (69+12*np.log2(hz/440))),.3)
            self.assertEqual(r['times'][0],0.)
            self.assertLessEqual(r['times'][-1],2.)

    @unittest.skipUnless(importlib.util.find_spec('librosa'),'librosa is required for real CPU pYIN checks')
    def test_real_pyin_chunk_seam_preserves_frame_grid_and_octave_change(self):
        sr=11025;duration=13.2;t=np.arange(round(sr*duration))/sr
        freq=np.where(t<6.,220.,440.);phase=2*np.pi*np.cumsum(freq)/sr
        r=estimate_pitch((.2*np.sin(phase)).astype(np.float32),sr,'vocals')
        self.assertTrue(np.allclose(np.diff(r['times']),220/11025))
        p=pitch_features(r,np.arange(0,duration,.5).tolist(),duration)
        first=[x['midi'] for x in p['rows'] if 1<=x['start_seconds']<5 and x['status']=='ok']
        last=[x['midi'] for x in p['rows'] if 11<=x['start_seconds']<13 and x['status']=='ok']
        self.assertAlmostEqual(float(np.median(first)),57.,delta=.3)
        self.assertAlmostEqual(float(np.median(last)),69.,delta=.3)
        self.assertEqual(p['continuous'][-1]['end_seconds'],duration)

if __name__=='__main__':unittest.main()
