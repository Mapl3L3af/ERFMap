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
        self.assertEqual(self.of('path')[0]['label'], 'path')         # erfMap's line kind, with a width
        self.assertEqual([p['label'] for p in self.points], ['tree'])

    def test_paths_become_straight_centre_lines_with_width(self):
        paths = self.of('path')
        self.assertTrue(all('line' in r for r in paths))
        lines = [np.array(r['line']) for r in paths]
        main = max(lines, key=lambda l: np.ptp(l[:, 1]))              # the path running down from the top edge
        self.assertEqual(main[:, 1].min(), 0, 'carried to the photo edge')
        self.assertTrue(np.all(np.abs(main[:, 0] - 640) < 10), 'on the centre of the path, x = 640')
        self.assertLessEqual(len(main), 3, 'a straight path is one or two straight segments')
        branch = [l for l in lines if np.ptp(l[:, 0]) > 200]
        self.assertTrue(branch, 'the branch has its own line')
        self.assertTrue(950 < branch[0][:, 0].max() < 1020, 'the branch line stops at its visible end, x = 1000')
        self.assertTrue(np.all(np.abs(branch[0][:, 1] - 830) < 12))
        self.assertAlmostEqual(paths[0]['width'], 80, delta=12)

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


    def test_trees_along_the_edge_are_placed_on_the_crowns(self):
        image, probs = scene()
        probs[:120, :, :] = 0.06
        probs[:120, :, cz.CLASSES.index('tree')] = 0.76                # a row of trees along the top edge
        trees = [r['point'] for r in cz.build_zones(image, probs, SIZE) if r['label'] == 'tree']
        edge = [p for p in trees if p[1] < 400]
        self.assertTrue(edge)
        for x, y in edge:
            self.assertGreater(y, 40, 'crown centres sit inside the trees, not on the photo border')



def curved_scene():
    """A curved path and a rotated building on textured grass, scored like CLIP: one score per 73 px window."""
    label = np.full((H, W), cz.CLASSES.index('grass'), np.int32)
    arc = np.zeros((H, W), np.uint8)
    cv2.ellipse(arc, (200, 900), (700, 650), 0, 270, 360, 1, 40)
    label[arc > 0] = cz.CLASSES.index('path')
    roof = np.zeros((H, W), np.uint8)
    cv2.fillPoly(roof, [np.array([[650, 80], [900, 140], [860, 330], [610, 270]])], 1)
    label[roof > 0] = cz.CLASSES.index('building')
    image = np.zeros((H, W, 3), np.uint8)
    for name, colour in COLOURS.items():
        image[label == cz.CLASSES.index(name)] = colour
    rng = np.random.default_rng(2)
    texture = cv2.GaussianBlur(rng.normal(0, 25, (H, W)).astype(np.float32), (0, 0), 3)
    image = np.clip(image + texture[..., None] + rng.normal(0, 10, image.shape), 0, 255).astype(np.uint8)
    onehot = np.eye(len(cz.CLASSES), dtype=np.float32)[label]
    P, S = 73, 36
    acc, hits = np.zeros((H, W, len(cz.CLASSES)), np.float32), np.zeros((H, W, 1), np.float32)
    for y in list(range(0, H - P + 1, S)) + [H - P]:
        for x in list(range(0, W - P + 1, S)) + [W - P]:
            p = 0.15 + 0.7 * onehot[y:y + P, x:x + P].mean(axis=(0, 1))
            acc[y:y + P, x:x + P] += p / p.sum()
            hits[y:y + P, x:x + P] += 1
    return image, acc / hits, label


class OutlineTest(unittest.TestCase):
    def test_outlines_follow_curves_not_the_score_grid(self):
        image, probs, label = curved_scene()
        regions = cz.build_zones(image, probs, (W, H))
        for kind, least in (('building', 0.97), ('path', 0.92)):        # the old grid gave the path 0.83
            mask = np.zeros((H, W), np.uint8)
            for r in regions:
                if r.get('model_label') == kind:
                    cv2.fillPoly(mask, [np.round(np.array(r['polygon'])).astype(np.int32)], 1)
            truth = label == cz.CLASSES.index(kind)
            iou = (truth & (mask > 0)).sum() / (truth | (mask > 0)).sum()
            self.assertGreater(iou, least, kind)


    def test_paving_never_takes_green_ground_even_when_scores_are_too_wide(self):
        image, probs = scene()
        wide = np.zeros((H, W), np.uint8)
        wide[0:600, 220:420] = 1                                       # scores say "path" 80 px either side of it
        probs = probs.copy()
        probs[wide > 0] = 0.1
        probs[wide > 0, cz.CLASSES.index('path')] = 0.6
        regions = cz.build_zones(image, probs, SIZE)
        path = np.zeros((SIZE[1], SIZE[0]), np.uint8)
        for r in regions:
            if r.get('model_label') == 'path':
                cv2.fillPoly(path, [np.round(np.array(r['polygon'])).astype(np.int32)], 1)
        lawn = np.zeros_like(path)
        lawn[0:1200, 440:580] = 1                                      # grass either side of the path (photo pixels),
        lawn[0:760, 700:840] = 1                                       # leaving out the branch at y 800-860
        lawn[900:1200, 700:840] = 1
        self.assertLess((path & lawn).sum(), 0.02 * lawn.sum(), 'the path spreads onto the lawn')
        self.assertGreater(path[0:1100, 610:670].mean(), 0.9, 'the path itself is kept')


class BuildingTest(unittest.TestCase):
    @staticmethod
    def angles(poly):
        p = np.asarray(poly, float)
        out = []
        for i in range(len(p)):
            a, b = p[i - 1] - p[i], p[(i + 1) % len(p)] - p[i]
            out.append(np.degrees(np.arccos(np.dot(a, b) / np.linalg.norm(a) / np.linalg.norm(b))))
        return out

    def check(self, shape, corners_expected):
        rng = np.random.default_rng(3)
        mask = np.zeros((600, 800), np.uint8)
        cv2.fillPoly(mask, [shape.astype(np.int32)], 1)
        truth = mask > 0
        wobbly = cv2.GaussianBlur(mask.astype(np.float32) + rng.normal(0, 0.25, mask.shape).astype(np.float32), (0, 0), 6) > 0.5   # rounded, ragged trace
        corners = cz.square_up(wobbly)
        self.assertIsNotNone(corners)
        self.assertEqual(len(corners), corners_expected)
        for a in self.angles(corners):
            self.assertAlmostEqual(a, 90, delta=1)
        fitted = np.zeros_like(mask)
        cv2.fillPoly(fitted, [np.round(corners).astype(np.int32)], 1)
        self.assertGreater((truth & (fitted > 0)).sum() / (truth | (fitted > 0)).sum(), 0.95)

    def test_tilted_rectangle_gets_square_corners(self):
        self.check(cv2.boxPoints(((400, 300), (360, 200), 17)), 4)

    def test_tilted_l_shape_keeps_its_six_square_corners(self):
        L = np.array([[0, 0], [300, 0], [300, 120], [130, 120], [130, 260], [0, 260]], float) - [150, 130]
        t = np.radians(-25)
        R = np.array([[np.cos(t), -np.sin(t)], [np.sin(t), np.cos(t)]])
        self.check(L @ R.T + [400, 300], 6)

    def test_scene_building_comes_out_square(self):
        image, probs, label = curved_scene()                            # its building is tilted about 13 degrees
        building = [r for r in cz.build_zones(image, probs, (W, H)) if r.get('model_label') == 'building']
        self.assertEqual(len(building), 1)
        self.assertEqual(len(building[0]['polygon']), 4)
        for a in self.angles(building[0]['polygon']):
            self.assertAlmostEqual(a, 90, delta=1.5)


class PathJoinTest(unittest.TestCase):
    def build(self, edit):
        image, probs = scene()
        probs = probs.copy()
        edit(image, probs)
        return cz.build_zones(image, probs, SIZE)

    def test_a_path_broken_by_shade_is_joined(self):
        def shade(image, probs):
            image[200:300, 280:360] = (35, 45, 40)                    # a dark shadow across the path
            probs[200:300, 280:360] = 0.06
            probs[200:300, 280:360, cz.CLASSES.index('grass')] = 0.76  # and the model calls it grass
        regions = self.build(shade)
        lines = [np.array(r['line']) for r in regions if r.get('model_label') == 'path']
        spanning = [l for l in lines if l[:, 1].min() < 300 and l[:, 1].max() > 700 and np.all(np.abs(l[:, 0] - 640) < 15)]
        self.assertTrue(spanning, 'one line runs through the shade: %s' % [l.tolist() for l in lines])
        grass_there = [r for r in regions if r.get('model_label') == 'grass' and inside(r['polygon'], 640, 500)]
        self.assertFalse(grass_there, 'the gap is path, not grass')
        left = [r for r in regions if r.get('model_label') == 'grass' and inside(r['polygon'], 300, 300)]
        right = [r for r in regions if r.get('model_label') == 'grass' and inside(r['polygon'], 1000, 300)]
        self.assertNotEqual(left[0]['polygon'], right[0]['polygon'], 'the joined path still divides the lawn')

    def test_paths_that_do_not_point_at_each_other_stay_apart(self):
        lines = [np.array([[100.0, 100.0], [300.0, 100.0]]), np.array([[340.0, 300.0], [340.0, 500.0]])]
        out, _, bridges = cz.connect_paths(lines, [20, 20], np.zeros((600, 800), bool), (600, 800))
        self.assertEqual(len(out), 2)
        self.assertEqual(bridges, [])

    def test_an_end_is_carried_to_the_side_of_the_path_it_points_at(self):
        lines = [np.array([[400.0, 50.0], [400.0, 550.0]]), np.array([[100.0, 300.0], [350.0, 300.0]])]
        out, _, bridges = cz.connect_paths(lines, [20, 20], np.zeros((600, 800), bool), (600, 800))
        self.assertEqual(out[1][-1].tolist(), [400.0, 300.0])
        self.assertEqual(len(bridges), 1)

    def test_a_gap_is_never_bridged_across_a_building(self):
        lines = [np.array([[100.0, 300.0], [300.0, 300.0]]), np.array([[420.0, 300.0], [700.0, 300.0]])]
        roof = np.zeros((600, 800), bool)
        roof[250:350, 320:400] = True
        out, _, bridges = cz.connect_paths(lines, [20, 20], roof, (600, 800))
        self.assertEqual(len(out), 2)
        out, _, _ = cz.connect_paths(lines, [20, 20], np.zeros((600, 800), bool), (600, 800))
        self.assertEqual(len(out), 1)


class CouncilTest(unittest.TestCase):
    def test_label_names_map_onto_our_classes(self):
        ids = cz.map_labels({0: 'wall', 1: 'building, edifice', 2: 'sidewalk, pavement', 3: 'grass', 4: 'tree', 5: 'sky', 6: 'road, route', 7: 'impervious surfaces'}, cz.SYNONYMS)
        self.assertEqual(ids, {'building': [1], 'road': [6, 7], 'path': [2], 'grass': [3], 'tree': [4]})
        self.assertEqual(cz.map_labels({9: 'bench', 10: 'streetlight, street lamp'}, cz.POINT_SYNONYMS), {'light': [10], 'bench': [9]})

    def test_votes_are_weighted_and_silent_members_do_not_count(self):
        a = np.zeros((1, 2, 5), np.float32); a[..., cz.CLASSES.index('grass')] = 1
        b = np.zeros((1, 2, 5), np.float32); b[..., cz.CLASSES.index('road')] = 1
        out = cz.combine({'clip': (a, np.ones((1, 2))), 'segformer': (b, np.array([[1.0, 0.0]]))}, (1, 2))
        self.assertAlmostEqual(out[0, 0, cz.CLASSES.index('grass')], 0.5)        # both voted: an even split
        self.assertAlmostEqual(out[0, 1, cz.CLASSES.index('grass')], 1.0)        # SegFormer saw sky here: CLIP decides

    def test_detected_crowns_become_tree_points_and_pull_towards_tree(self):
        image, probs = scene()
        crowns = [(500.0, 200.0, 0.9, 30.0), (150.0, 300.0, 0.7, 40.0)]
        pulled = cz.add_tree_crowns(probs, crowns)
        self.assertGreater(pulled[200, 500, cz.CLASSES.index('tree')], probs[200, 500, cz.CLASSES.index('tree')] + 0.4)
        trees = [r for r in cz.build_zones(image, pulled, SIZE, trees=crowns) if r['label'] == 'tree']
        self.assertEqual([t['point'] for t in trees], [[1000.0, 400.0], [300.0, 600.0]])
        self.assertEqual([t['confidence'] for t in trees], [0.9, 0.7])

    def test_points_need_one_sure_member_and_report_every_vote(self):
        from PIL import Image

        class Fake:
            def __init__(self, name, spots):
                self.name, self.spots = name, spots

            def points(self, image):
                maps = {k: np.zeros((100, 200), np.float32) for k in cz.POINTS}
                for kind, x, y, p in self.spots:
                    maps[kind][y - 2:y + 3, x - 2:x + 3] = p
                return maps

        members = [Fake('clip', [('bench', 50, 50, 0.8), ('light', 150, 50, 0.4)]), Fake('segformer', [('bench', 51, 50, 0.6), ('light', 150, 50, 0.3)])]
        found = cz.council_points(Image.new('RGB', (200, 100)), members, 1.0)
        self.assertEqual([(k, round(c, 2)) for c, k, *_ in found], [('bench', 0.7)])    # the lamp post was nobody's confident call
        self.assertEqual(found[0][4], {'clip': 0.8, 'segformer': 0.6})


if __name__ == '__main__':
    unittest.main()
