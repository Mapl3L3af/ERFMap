import json
import sys
import tempfile
import unittest
from pathlib import Path
import cv2
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from capture_checks import analyze, components, coverage, DEFAULTS, quality


class CaptureChecksTests(unittest.TestCase):
    def test_blur_and_low_texture_are_distinct(self):
        rng = np.random.default_rng(7)
        image = rng.integers(0, 256, (400, 400, 3), dtype=np.uint8)
        _, good = quality(image, DEFAULTS)
        self.assertNotIn('blurry', good)
        smooth = cv2.GaussianBlur(image, (11, 11), 2)
        _, flags = quality(smooth, DEFAULTS)
        self.assertTrue('blurry' in flags or 'blur uncertain (low texture)' in flags)
        _, blank = quality(np.full((400, 400, 3), 128, np.uint8), DEFAULTS)
        self.assertIn('low texture', blank)
        self.assertNotIn('blurry', blank)

    def test_real_matches_overlap_and_disconnected_images(self):
        with tempfile.TemporaryDirectory() as folder:
            job = Path(folder)
            out = job / 'stages/capture'
            out.mkdir(parents=True)
            rng = np.random.default_rng(12)
            world = rng.integers(0, 256, (500, 900, 3), dtype=np.uint8)
            # Moderate texture, plus large distinctive landmarks spread across the overlap.
            for _ in range(120):
                x, y = rng.integers([20, 20], [880, 480])
                cv2.circle(world, (int(x), int(y)), int(rng.integers(3, 15)), (255, 255, 255), 2)
            images = [world[:, :600], world[:, 120:720], rng.integers(0, 256, (500, 600, 3), dtype=np.uint8)]
            frames = []
            for i, image in enumerate(images):
                name = 'image%d.png' % i
                cv2.imwrite(str(job / name), image)
                frames.append({'id': str(i), 'source': name, 'image': name, 'time_s': None, 'usable': True, 'flags': []})
            report = analyze(job, frames, out)
            self.assertEqual(report['readiness'], 'blocked')
            self.assertEqual(report['groups'], [['0', '1'], ['2']])
            link = next(l for l in report['links'] if l['ok'])
            self.assertGreater(link['inliers'], DEFAULTS['min_inliers'])
            self.assertAlmostEqual(link['overlap'], .8, delta=.06)
            self.assertIsNone(report['images'][2]['best_overlap'])
            self.assertTrue((job / report['coverage'][0]['image']).exists())
            connected = analyze(job, frames[:2], out)
            self.assertEqual(connected['readiness'], 'ready')
            json.dumps(connected)  # The worker persists the complete report as JSON.
            weak_frames = [frames[0], {**frames[1], 'image': 'weak.png'}]
            cv2.imwrite(str(job / 'weak.png'), world[:, 280:880])
            weak = analyze(job, weak_frames, out)
            self.assertEqual(weak['readiness'], 'needs_review')
            self.assertIn('insufficient overlap', weak['images'][0]['flags'])

    def test_enclosed_gap_is_detected_but_outer_space_is_unknown(self):
        def box(x, y, w, h):
            return np.float32([[x,y],[x+w,y],[x+w,y+h],[x,y+h]])
        ring = [box(0,0,100,20), box(0,80,100,20), box(0,10,20,80), box(80,10,20,80)]
        report, preview = coverage(ring, DEFAULTS)
        self.assertEqual(report['status'], 'suspected gaps')
        self.assertEqual(len(report['gaps']), 1)
        full, _ = coverage(ring + [box(10,10,80,80)], DEFAULTS)
        self.assertEqual(full['gaps'], [])
        self.assertIn('unknown', full['scope'])
        self.assertEqual(preview.dtype, np.uint8)

    def test_exclusions_and_no_usable_views_are_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            job = Path(folder)
            out = job / 'stages/capture'
            out.mkdir(parents=True)
            cv2.imwrite(str(job/'blank.png'), np.full((100,100,3),128,np.uint8))
            frame = {'id':'blank','image':'blank.png','usable':False,'flags':['low texture']}
            report = analyze(job, [frame], out)
            self.assertEqual(report['readiness'], 'blocked')
            self.assertTrue(report['images'][0]['excluded'])
            self.assertEqual(report['images'][0]['exclusion_reasons'], ['low texture'])
            self.assertEqual(report['groups'], [])
            self.assertEqual(report['compared_pairs'], 0)

    def test_connected_components_do_not_invent_adjacency(self):
        self.assertEqual(components(['a','b','c'], [{'from':'a','to':'b','ok':True}, {'from':'b','to':'c','ok':False}]), [['a','b'],['c']])


if __name__ == '__main__':
    unittest.main()
