import unittest
from beat_volume import beat_volume_features


class BeatVolumeChecks(unittest.TestCase):
    def test_means_are_duration_weighted_and_cover_leading_and_tail(self):
        motion={'times':[0,.1,.3,.6,1.],'rms':[0,.1,.3,.9,.6]}
        result=beat_volume_features(motion,[.2,.8],1.)
        self.assertEqual(result['rows'][0]['kind'],'leading')
        self.assertEqual(result['rows'][-1]['end_seconds'],1.)
        for row,mean in zip(result['rows'],[.2,.7,.6]):
            self.assertAlmostEqual(row['mean_rms'],mean)
        for row,previous in zip(result['rows'],[.2,.2,.7]):
            self.assertAlmostEqual(row['from_rms'],previous)
        self.assertTrue(result['include_silence'])
        self.assertFalse(result['anticipation'])

    def test_silence_is_included_and_targets_zero_instead_of_holding(self):
        motion={'times':[0,.25,1.,2.],'rms':[0,1,0,0]}
        rows=beat_volume_features(motion,[0,1],2.)['rows']
        self.assertAlmostEqual(rows[0]['mean_rms'],.25)
        self.assertEqual(rows[1]['target_rms'],0)
        self.assertAlmostEqual(rows[1]['from_rms'],.25)
        self.assertEqual(rows[1]['status'],'silent')
        motion['rms']=[0]*4
        self.assertTrue(all(r['target_rms']==0 for r in beat_volume_features(motion,[],2.)['rows']))

    def test_invalid_cached_frames_are_rejected(self):
        for times,rms in [([0,1],[0,float('nan')]),([0,1],[0,-1]),([0,0],[0,1]),([0,.5],[0,1]),([0,1],[1])]:
            with self.assertRaises(ValueError):beat_volume_features({'times':times,'rms':rms},[],1.)


if __name__=='__main__':unittest.main()
