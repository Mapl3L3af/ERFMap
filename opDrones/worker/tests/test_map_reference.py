import sys
import unittest
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from map_reference import guide, agreement, terrain_check

class MapReferenceTests(unittest.TestCase):
    def test_geometry_prior_changes_votes_and_keeps_provenance(self):
        classes=['building','path','road','grass','tree']
        p=np.full((100,100,5),.2,np.float32)
        reference={'source':'User map export','transform':{'rms_m':.4},'features':[{'kind':'path','points':[[10,50],[90,50]],'width_px':20}]}
        guided=guide(p,reference,1,classes)
        self.assertGreater(guided[50,50,1],.8)
        np.testing.assert_allclose(guided[0,0],p[0,0])
        np.testing.assert_allclose(guided.sum(axis=2),1,atol=1e-6)
        check=agreement([{'label':'path','polygon':[[0,40],[99,40],[99,60],[0,60]]}],reference,(100,100))
        self.assertEqual(check['source'],'User map export')
        self.assertIn('not independent',check['note'])
        self.assertGreater(check['agreement']['path']['reference_coverage'],.9)

    def test_relative_elevation_check_removes_only_datum_offset(self):
        reference={'verticalDatum':'test datum','features':[{'id':str(i),'kind':'ground','points':[[i,0]],'elevation_m':100+i} for i in range(3)]}
        geometry={'scale':{'m_per_px':1,'origin_px':[0,0]},'terrain':{'groundGrid':{'origin':[0,0],'step':[1,1],'heights':[[0,1,2],[0,1,2]]}}}
        check=terrain_check(reference,geometry)
        self.assertEqual(check['matched'],3)
        self.assertEqual(check['relative_rmse_m'],0)
        self.assertEqual(check['removed_vertical_offset_m'],-100)
        geometry['terrain']['groundGrid']['heights'][1][1]=None
        self.assertEqual(terrain_check(reference,geometry)['status'],'insufficient')
        self.assertEqual(terrain_check(reference,{})['status'],'unavailable')

    def test_unreferenced_images_receive_no_reference_prior_or_height_claim(self):
        p=np.ones((4,4,5),np.float32)/5
        self.assertIs(guide(p,None,1,['building','path','road','grass','tree']),p)
        self.assertIsNone(terrain_check(None,{}))
