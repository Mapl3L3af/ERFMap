"""Path detail, tile blending, boundary evidence and local width regressions."""
import sys
import unittest
from pathlib import Path
import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'adapters'))
import clip_zones as zones


class PathDetailTest(unittest.TestCase):
    def test_overlapping_tiles_preserve_coordinates_and_cover_image_edges(self):
        yy, xx = np.mgrid[:71, :103]
        pixels = np.stack([xx, yy, np.zeros_like(xx)], axis=2).astype(np.uint8)
        seen = []
        def predict(crop):
            seen.append(crop.size)
            return np.asarray(crop).astype(np.float32) / 255
        out = zones.tiled_probabilities(Image.fromarray(pixels), predict, tile=32, overlap=8)
        np.testing.assert_allclose(out, pixels/255, atol=1e-6)
        self.assertGreater(len(seen), 9)
        tiny = zones.tiled_probabilities(Image.new('RGB', (1, 7)), lambda crop:np.ones((crop.height,crop.width,2),np.float32), tile=32, overlap=8)
        np.testing.assert_allclose(tiny, 1)

    def test_tile_edge_artifacts_are_blended_instead_of_becoming_hard_seams(self):
        def predict(crop):
            p = np.ones((crop.height,crop.width,1),np.float32)
            p[:, :2] = 0
            p[:, -2:] = 0
            return p
        out = zones.tiled_probabilities(Image.new('RGB',(88,32)),predict,tile=32,overlap=16)
        self.assertGreater(out[16,16:-16,0].min(), .9)

    def test_narrow_path_is_not_erased_by_boundary_smoothing(self):
        image = np.full((180,240,3),(60,150,70),np.uint8)
        image[:,117:123] = (190,190,190)
        probs = np.zeros((180,240,len(zones.CLASSES)),np.float32)
        probs[:,:,zones.CLASSES.index('grass')] = .95
        probs[:,117:123] = .01
        probs[:,117:123,zones.CLASSES.index('path')] = .96
        result = zones.build_zones(image,probs,(240,180))
        paths = [r for r in result if r['label']=='path']
        self.assertTrue(paths)
        self.assertTrue(any(max(p[1] for p in r['line'])-min(p[1] for p in r['line']) > 160 for r in paths))
        self.assertTrue(all(r['width'] < 12 for r in paths))

    def test_curve_fitting_stays_inside_the_observed_corridor(self):
        mask = np.zeros((240,240),np.uint8)
        cv2.ellipse(mask,(120,120),(80,80),0,180,270,1,18)
        t = np.linspace(np.pi,1.5*np.pi,150)
        chain = np.stack([120+80*np.cos(t),120+80*np.sin(t)],axis=1)
        line = zones.fit_path_line(chain,mask.astype(bool),18)
        self.assertGreater(len(line), 4)
        for a,b in zip(line[:-1],line[1:]):
            samples = np.round(np.linspace(a,b,100)).astype(int)
            self.assertTrue(mask[samples[:,1],samples[:,0]].all())
        np.testing.assert_allclose(line[[0,-1]],chain[[0,-1]])

    def test_local_widths_preserve_narrow_and_wide_sections(self):
        mask = np.zeros((140,300),np.uint8)
        mask[60:80,10:150] = 1
        mask[40:100,150:290] = 1
        line,widths = zones.width_profile(np.array([[15.,70.],[285.,70.]]),mask.astype(bool),40)
        self.assertEqual(len(widths),len(line)-1)
        self.assertAlmostEqual(min(widths),20,delta=2)
        self.assertAlmostEqual(max(widths),60,delta=2)
        self.assertLessEqual(len(line),5)

    def test_strong_dry_grass_evidence_is_not_a_path_bridge(self):
        image = np.full((240,400,3),(60,145,70),np.uint8)
        image[105:135,20:380] = (185,185,185)
        image[105:135,170:230] = (80,120,150)  # brown lawn, not excess-green foliage
        probs = np.full((240,400,len(zones.CLASSES)),.01,np.float32)
        probs[:,:,zones.CLASSES.index('grass')] = .96
        probs[105:135,20:380] = .01
        probs[105:135,20:380,zones.CLASSES.index('path')] = .96
        probs[105:135,170:230] = .01
        probs[105:135,170:230,zones.CLASSES.index('grass')] = .96
        result = zones.build_zones(image,probs,(400,240))
        for r in result:
            if r['label']=='path':
                self.assertFalse(min(q[0] for q in r['line']) < 165 and max(q[0] for q in r['line']) > 235)


if __name__ == '__main__':
    unittest.main()
