"""Acceptance checks for the two-stage zones + points labelling (no CLIP weights needed).

    python -m unittest worker/tests/test_zones.py

A synthetic scene with a building, a road, a path, grass and a tree is given
coarse, blurred class probabilities (like CLIP's window scores) and turned
into zones and points by clip_zones.build_zones.
"""
import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'adapters'))
import clip_zones as cz  # noqa: E402

W, H = 1024, 768          # analysis size
SIZE = (2048, 1536)        # original photo size (scale 0.5)
COLOURS = {'grass': (60, 150, 70), 'road': (70, 70, 70), 'path': (200, 200, 195), 'building': (60, 60, 170), 'tree': (30, 80, 30)}


def scene():
    label = np.full((H, W), cz.CLASSES.index('grass'), np.int32)
    label[600:680, :] = cz.CLASSES.index('road')                 # road crosses the whole frame
    label[0:600, 300:340] = cz.CLASSES.index('path')             # path from the top edge down to the road
    label[400:430, 340:500] = cz.CLASSES.index('path')           # a branch that ends inside the frame
    label[100:300, 600:800] = cz.CLASSES.index('building')       # building on the right-hand lawn
    cv2.circle(label, (150, 300), 40, cz.CLASSES.index('tree'), -1)   # tree on the left-hand lawn
    image = np.zeros((H, W, 3), np.uint8)
    for name, colour in COLOURS.items():
        image[label == cz.CLASSES.index(name)] = colour
    rng = np.random.default_rng(1)
    image = np.clip(image.astype(int) + rng.integers(-12, 13, image.shape), 0, 255).astype(np.uint8)
    probs = np.full((H, W, len(cz.CLASSES)), 0.06, np.float32)
    for k in range(len(cz.CLASSES)):
        probs[:, :, k][label == k] = 0.76
    probs = cv2.GaussianBlur(probs, (0, 0), 12)                  # coarse, like overlapping CLIP windows
    return image, probs


def raster(poly, s=0.25, trim=False):
    """Filled polygon mask; trim=True drops the 1-pixel outline, where neighbouring zones share an edge."""
    mask = np.zeros((int(SIZE[1] * s) + 1, int(SIZE[0] * s) + 1), np.uint8)
    cv2.fillPoly(mask, [np.round(np.array(poly) * s).astype(np.int32)], 1)
    if trim:
        mask = cv2.erode(mask, np.ones((3, 3), np.uint8))
    return mask.astype(bool)


def inside(poly, x, y):
    return cv2.pointPolygonTest(np.array(poly, np.float32).reshape(-1, 1, 2), (float(x), float(y)), False) >= 0


class ZonesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        image, probs = scene()
        cls.regions = cz.build_zones(image, probs, SIZE)
        cls.zones = [r for r in cls.regions if r['role'] == 'zone']
        cls.points = [r for r in cls.regions if r['role'] == 'point']

    def of(self, model_label):
        return [r for r in self.zones if r['model_label'] == model_label]

    def test_polygons_and_points(self):
        for kind in ('building', 'path', 'road', 'grass'):
            self.assertTrue(self.of(kind), kind)
        self.assertEqual(self.of('path')[0]['label'], 'pavement')     # full width kept as an area
        self.assertEqual([p['label'] for p in self.points], ['tree'])

    def test_zones_do_not_overlap(self):
        masks = [(r['model_label'], raster(r['polygon'], trim=True)) for r in self.zones]
        for i, (a, ma) in enumerate(masks):
            for b, mb in masks[i + 1:]:
                overlap = (ma & mb).sum()
                self.assertLess(overlap, 0.01 * min(ma.sum(), mb.sum()), '%s overlaps %s' % (a, b))

    def test_building_footprint(self):
        b = self.of('building')
        self.assertEqual(len(b), 1)
        area = raster(b[0]['polygon']).sum() / 0.25 ** 2
        self.assertAlmostEqual(area / (400 * 400), 1, delta=0.15)

    def test_road_reaches_both_edges(self):
        xs = [x for r in self.of('road') for x, _ in r['polygon']]
        self.assertEqual(min(xs), 0)
        self.assertEqual(max(xs), SIZE[0])

    def test_path_reaches_top_edge_and_branch_stops_inside(self):
        pts = [q for r in self.of('path') for q in r['polygon']]
        self.assertEqual(min(y for _, y in pts), 0)
        self.assertLess(max(x for x, _ in pts), 0.6 * SIZE[0])      # branch ends near x=1000 of 2048
        self.assertGreater(max(x for x, _ in pts), 0.4 * SIZE[0])
        self.assertTrue(any(inside(r['polygon'], 900, 830) for r in self.of('path')))

    def test_path_divides_lawn(self):
        grass = self.of('grass')
        left = [i for i, r in enumerate(grass) if inside(r['polygon'], 300, 300)]
        right = [i for i, r in enumerate(grass) if inside(r['polygon'], 1000, 300)]
        self.assertEqual(len(left), 1)
        self.assertEqual(len(right), 1)
        self.assertNotEqual(left, right)
        self.assertTrue(any(inside(r['polygon'], 1000, 1450) for r in grass))   # lawn below the road too

    def test_grass_keeps_hole_around_building(self):
        lawn = next(r for r in self.of('grass') if inside(r['polygon'], 1000, 300))
        self.assertFalse(inside(lawn['polygon'], 1400, 400))           # building centre
        self.assertTrue(inside(self.of('building')[0]['polygon'], 1400, 400))
        self.assertLess((raster(lawn['polygon'], trim=True) & raster(self.of('building')[0]['polygon'], trim=True)).sum(), 50)

    def test_point_on_grass_leaves_zone_intact(self):
        tree = self.points[0]
        self.assertLess(np.hypot(tree['point'][0] - 300, tree['point'][1] - 600), 40)
        lawn = [r for r in self.of('grass') if inside(r['polygon'], *tree['point'])]
        self.assertEqual(len(lawn), 1)                                 # the grass still covers the tree

    def test_point_on_another_zone(self):
        r = cz.point_region(800, 1280, 'bench', 0.7, 20)                # a bench placed on the road
        self.assertEqual(r['role'], 'point')
        self.assertTrue(any(inside(z['polygon'], *r['point']) for z in self.of('road')))


if __name__ == '__main__':
    unittest.main()
