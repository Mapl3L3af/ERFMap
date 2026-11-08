"""Geometry-aware relabelling: 3D cues fix imagery confusions and fall back cleanly.

    python -m unittest worker/tests/test_geometry_fusion.py
"""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import geometry_fusion as gf  # noqa: E402

H, W, M = 200, 300, 0.1          # mosaic pixels, metres per pixel


def surface():
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    dsm = 0.004 * xx                                   # gently sloping ground (about 2°)
    dsm[40:100, 40:120] += 6.0                         # flat roof, 6 m
    cy, cx, r = 140, 220, 30                           # tree crown: a bumpy dome
    d = np.hypot(yy - cy, xx - cx)
    crown = np.clip(1 - (d / r) ** 2, 0, None) * 5 + (np.sin(xx * 1.7) * np.cos(yy * 1.3)) * .6 * (d < r)
    dsm = np.where(d < r, dsm + crown + 1.0, dsm)
    return dsm.astype(np.float32)


def box(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def features():
    return [
        {'id': 'roof', 'kind': 'pavement', 'geometry': 'area', 'pixel_polygon': box(50, 50, 110, 90), 'p': []},
        {'id': 'crown', 'kind': 'grass', 'geometry': 'area', 'pixel_polygon': box(205, 125, 235, 155), 'p': []},
        {'id': 'lawn', 'kind': 'grass', 'geometry': 'area', 'pixel_polygon': box(150, 20, 280, 80), 'p': []},
        {'id': 'fake', 'kind': 'building', 'geometry': 'area', 'pixel_polygon': box(10, 130, 80, 190), 'p': []},
    ]


class Fusion(unittest.TestCase):
    def setUp(self):
        self.job = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.job)

    def write(self, dsm, meta=None):
        (self.job / 'reconstruction').mkdir(exist_ok=True)
        np.save(self.job / 'reconstruction' / 'height.npy', dsm)
        if meta is not None:
            (self.job / 'reconstruction' / 'meta.json').write_text(json.dumps(meta))

    def test_no_reconstruction_keeps_imagery_labels(self):
        fs = features()
        report = gf.apply(self.job, fs, (H, W), M)
        self.assertFalse(report['used'])
        self.assertIn('imagery only', report['reason'])
        self.assertEqual([f['kind'] for f in fs], ['pavement', 'grass', 'grass', 'building'])

    def test_height_slope_and_shape_fix_confusions(self):
        self.write(surface())
        fs = features()
        report = gf.apply(self.job, fs, (H, W), M)
        self.assertTrue(report['used'])
        kinds = {f['id']: f['kind'] for f in fs}
        self.assertEqual(kinds['roof'], 'building')      # flat and raised: a roof, not paving
        self.assertEqual(kinds['crown'], 'tree')         # raised and bumpy: a crown, not lawn
        self.assertEqual(kinds['lawn'], 'grass')         # ground stays ground
        self.assertIn(kinds['fake'], ('pavement', 'grass'))   # "building" at ground level
        self.assertEqual(fs[0]['image_kind'], 'pavement')
        self.assertGreater(fs[0]['geometry_evidence']['hag_median_m'], 4)
        self.assertEqual(len(report['changed']), 3)
        samples = report['ground_samples']
        self.assertTrue(samples)
        self.assertEqual(min(z for _, _, z in samples), 0)          # relative to a local zero
        east = [z for x, _, z in samples if x > 25]
        self.assertTrue(all(z < 2 for z in east))                     # roofs and crowns are not ground

    def test_sparse_or_noisy_geometry_falls_back(self):
        dsm = surface()
        dsm[:, :] = np.nan
        dsm[:, :40] = 0                                   # only a strip was reconstructed
        self.write(dsm)
        fs = features()
        report = gf.apply(self.job, fs, (H, W), M)
        self.assertFalse(report['used'])
        self.assertEqual(fs[0]['kind'], 'pavement')
        self.write(surface(), {'vertical_error_m': 1.0})
        fs = features()
        report = gf.apply(self.job, fs, (H, W), M)
        self.assertEqual(report['fallback'], 4)
        self.assertEqual(fs[1]['kind'], 'grass')
        self.assertIn('geometry unavailable', fs[1]['flags'])

    def test_resamples_and_survives_holes_inside_a_feature(self):
        dsm = surface()[::2, ::2].copy()                  # half-resolution raster
        dsm[20:50, 20:60] = np.nan                        # roof not reconstructed
        self.write(dsm)
        fs = features()
        gf.apply(self.job, fs, (H, W), M)
        self.assertEqual(fs[0]['kind'], 'pavement')       # unknown roof: keep imagery
        self.assertIn('too little', fs[0]['geometry_evidence']['decision'])
        self.assertEqual(fs[1]['kind'], 'tree')

    def test_compare_against_image_only_baseline(self):
        classes = ['building', 'road', 'path', 'grass', 'tree', 'pavement']
        dsm = surface()
        truth = np.full((H, W), classes.index('grass'))
        truth[40:100, 40:120] = classes.index('building')
        yy, xx = np.mgrid[0:H, 0:W]
        truth[np.hypot(yy - 140, xx - 220) < 28] = classes.index('tree')
        truth[:5] = -1                                     # unlabelled pixels are ignored
        image = truth.copy()
        image[40:100, 40:120] = classes.index('pavement')  # imagery confuses roof with paving
        image[np.hypot(yy - 140, xx - 220) < 28] = classes.index('grass')
        image[:5] = classes.index('grass')
        hag, slope, rough = gf.surface_cues(dsm, gf.estimate_ground(dsm, M), M)
        result = gf.compare(image, gf.fuse_raster(image, classes, hag, rough, slope), truth, classes)
        self.assertGreater(result['mean_iou']['fused'], result['mean_iou']['image_only'])
        self.assertGreater(result['fused']['building'], .9)
        self.assertEqual(result['image_only'].get('building', 0), 0)

    def test_evaluation_reports_missing_labels(self):
        self.write(surface())
        self.assertEqual(gf.evaluate(self.job)['status'], 'blocked')


if __name__ == '__main__':
    unittest.main()
