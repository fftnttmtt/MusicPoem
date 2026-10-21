import unittest
from beat_centroid import beat_centroid_features


class BeatCentroidChecks(unittest.TestCase):
    def motion(self):
        return dict(times=[0,.1,.3,.6,1.],centroid_hz=[0,100,300,900,600],
            rms=[0,.1,.1,.1,.1],raw_rms=[0,.1,.1,.1,.1],gate_dbfs=-55.)

    def test_time_weighted_means_and_own_beat_mean_normalization(self):
        result=beat_centroid_features(self.motion(),[0,.2,.8],1.)
        means=[r['centroid_hz'] for r in result['rows']]
        for actual,expected in zip(means,[200,700,600]):self.assertAlmostEqual(actual,expected)
        for actual,expected in zip([r['normalized'] for r in result['rows']],[0,1,.8]):self.assertAlmostEqual(actual,expected)
        self.assertEqual(result['centroid_min_hz'],min(means));self.assertEqual(result['centroid_max_hz'],max(means))
        louder=self.motion();louder['centroid_hz']=[v*10 for v in louder['centroid_hz']]
        other=beat_centroid_features(louder,[0,.2,.8],1.)
        for a,b in zip(result['rows'],other['rows']):self.assertAlmostEqual(a['normalized'],b['normalized'])

    def test_silence_is_excluded_and_holds_previous_target(self):
        motion=self.motion();motion['raw_rms']=[0,.1,.1,0,0]
        result=beat_centroid_features(motion,[0,.3,.6],1.)
        self.assertAlmostEqual(result['rows'][0]['centroid_hz'],700/3)
        self.assertEqual([r['status'] for r in result['rows']],['ok','silent','silent'])
        for r in result['rows'][1:]:
            self.assertIsNone(r['centroid_hz']);self.assertEqual(r['target_normalized'],.5)
            self.assertAlmostEqual(r['target_centroid_hz'],result['rows'][0]['centroid_hz'])

    def test_leading_tail_and_constant_empty_songs_have_no_artificial_extrema(self):
        result=beat_centroid_features(self.motion(),[.2,.8],1.)
        self.assertEqual(result['rows'][0]['kind'],'leading')
        self.assertEqual(result['rows'][-1]['end_seconds'],1.)
        motion=self.motion();motion['raw_rms']=[0]*5
        silent=beat_centroid_features(motion,[],1.)
        self.assertEqual(silent['valid_beats'],0)
        self.assertEqual(len(silent['rows']),1)
        self.assertEqual(silent['rows'][0]['target_normalized'],.5)
        self.assertIsNone(silent['rows'][0]['target_centroid_hz'])


if __name__=='__main__':unittest.main()
