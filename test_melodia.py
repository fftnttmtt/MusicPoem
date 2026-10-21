"""Real official WASM on known polyphonic / harmonic signals and chunk seams."""
import importlib.util
import unittest
from unittest.mock import patch
import numpy as np
from melodia_pitch import estimate_melodia,pitch_engine,MELODIA_SETTINGS
from pitch_features import pitch_features


class MethodChecks(unittest.TestCase):
    def test_method_selection_respects_explicit_choices_and_preserves_single_voice_defaults(self):
        for stem in ('bass','vocals','piano','guitar','other'):
            self.assertEqual(pitch_engine({'pitch_method':'pyin'},stem),'pyin')
            self.assertEqual(pitch_engine({'pitch_method':'melodia'},stem),'melodia')
            self.assertEqual(pitch_engine({},stem),'pyin' if stem in ('bass','vocals') else 'melodia')
        for bias in (-1,7,True,float('nan')):
            with self.assertRaises(ValueError):estimate_melodia(np.ones(1000),1000,'other',high_pitch_bias=bias)

    def test_silence_stays_unvoiced_without_initializing_the_runtime(self):
        with patch('melodia_pitch.new_runtime',side_effect=AssertionError('silent track must not initialize WASM')):
            raw=estimate_melodia(np.zeros((22050,2)),22050,'piano')
        self.assertTrue(all(v is None for v in raw['f0_hz']))
        mapped=pitch_features(raw,[0,.5],1.,0.)
        self.assertEqual(mapped['coverage'],0.);self.assertEqual(mapped['method'],'melodia')
        self.assertTrue(all(row['target_normalized']==.5 for row in mapped['rows']))


@unittest.skipUnless(importlib.util.find_spec('py_mini_racer'),'install requirements_melodia.txt for real WASM checks')
class RealMelodiaChecks(unittest.TestCase):
    def test_upper_voice_prior_selects_weaker_high_note_in_a_chord_without_transposition(self):
        sr=22050;t=np.arange(sr*2)/sr
        y=(.18*np.sin(2*np.pi*220*t)+.13*np.sin(2*np.pi*659.255*t)).astype(np.float32)
        medians=[]
        for bias in (0.,4.):
            raw=estimate_melodia(y,sr,'other',high_pitch_bias=bias)
            mapped=pitch_features(raw,[0,.5,1.,1.5],2.,0.)
            values=[f for t,f in zip(raw['times'],raw['f0_hz']) if .4<t<1.6 and f]
            medians.append(float(np.median(values)))
            self.assertGreater(mapped['coverage'],.7)
            self.assertEqual(raw['times'][0],0.)
            self.assertTrue(np.allclose(np.diff(raw['times']),128*7/44100))
        self.assertAlmostEqual(medians[0],220.,delta=3.)
        self.assertAlmostEqual(medians[1],659.255,delta=5.)

    def test_high_prior_does_not_turn_a_harmonic_tone_into_its_highest_harmonic(self):
        sr=22050;t=np.arange(sr*2)/sr
        y=sum(a*np.sin(2*np.pi*440*h*t) for h,a in ((1,.15),(2,.1),(3,.05),(4,.025)))
        raw=estimate_melodia(np.column_stack([y,-y]),sr,'other')
        values=[f for t,f in zip(raw['times'],raw['f0_hz']) if .4<t<1.6 and f]
        self.assertAlmostEqual(float(np.median(values)),440.,delta=4.)
        self.assertEqual(raw['selected_channel'],0)

    def test_chunk_seams_keep_global_clock_and_silence_does_not_anticipate_an_onset(self):
        sr=22050;duration=2.4;t=np.arange(round(sr*duration))/sr
        freq=np.where(t<1.2,330.,660.);phase=2*np.pi*np.cumsum(freq)/sr
        y=(.2*np.sin(phase)*(t>=.2)).astype(np.float32)
        with patch.dict(MELODIA_SETTINGS,{'chunk_seconds':.8,'context_seconds':.3}):
            raw=estimate_melodia(y,sr,'other')
        p=pitch_features(raw,np.arange(0,duration,.4).tolist(),duration,0.)
        self.assertTrue(np.allclose(np.diff(raw['times']),128*7/44100))
        self.assertLessEqual(raw['times'][-1],duration)
        self.assertEqual(p['continuous'][-1]['end_seconds'],duration)
        self.assertTrue(all(r['status']=='unvoiced' for r in p['continuous'] if r['start_seconds']<.19))
        for a,b,hz in ((.4,1.,330.),(1.5,2.2,660.)):
            values=[f for t,f in zip(raw['times'],raw['f0_hz']) if a<t<b and f]
            self.assertAlmostEqual(float(np.median(values)),hz,delta=5.)

    def test_full_default_core_keeps_long_lower_melody_and_short_upper_melody(self):
        sr=11025;duration=25.4;t=np.arange(round(sr*duration))/sr
        freq=np.where(t<24.,440.,660.);phase=2*np.pi*np.cumsum(freq)/sr
        y=(.15*np.sin(phase)+.06*np.sin(2*phase)).astype(np.float32)
        raw=estimate_melodia(y,sr,'other')
        for a,b,hz in ((1.,23.,440.),(24.5,25.1,660.)):
            values=[f for t,f in zip(raw['times'],raw['f0_hz']) if a<t<b and f]
            self.assertGreater(len(values),10)
            self.assertAlmostEqual(float(np.median(values)),hz,delta=5.)
        self.assertTrue(np.allclose(np.diff(raw['times']),128*7/44100))
        mapped=pitch_features(raw,np.arange(0,duration,.5).tolist(),duration,0.)
        self.assertEqual(mapped['continuous'][-1]['end_seconds'],duration)


if __name__=='__main__':unittest.main()
