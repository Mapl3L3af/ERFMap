import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import erfmap_worker as worker
from scene_review import refine
from adapters import clip_zones as zones


class SceneReviewTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.job = Path(self.temp.name)
        (self.job / 'stages/regions').mkdir(parents=True)
        image = np.full((200, 240, 3), (70, 140, 75), np.uint8)
        image[60:100, 130:190] = (160, 170, 185)
        image[:, 50:64] = (190, 195, 200)
        cv2.imwrite(str(self.job / 'scene.png'), image)
        self.geometry = {'scale': {'m_per_px': .1, 'origin_px': [0, 0]},
                         'mosaic': {'image': 'scene.png', 'width': 240, 'height': 200},
                         'features': [
                             {'id': 'roof', 'kind': 'building', 'geometry': 'area', 'p': [[13, 6], [19, 6], [19, 10], [13, 10]], 'region': [[13, 6], [19, 6], [19, 10], [13, 10]]},
                             {'id': 'lawn', 'kind': 'grass', 'geometry': 'area', 'p': [[0, 0], [24, 0], [24, 20], [0, 20]], 'region': [[0, 0], [24, 0], [24, 20], [0, 20]]}]}
        worker.write_json(self.job / 'stages/geometry/result.json', self.geometry)

    def test_guidance_is_soft_and_does_not_invent_model_evidence(self):
        probs = np.zeros((60, 80, len(zones.CLASSES)), np.float32)
        probs[:, :, zones.CLASSES.index('grass')] = .9
        probs[:, :, zones.CLASSES.index('path')] = .1
        marks = [{'kind': 'path', 'p': [5, 30], 'stroke': [[5, 30], [75, 30]], 'radius': 5}]
        guided = zones.apply_guidance(probs, marks, 1)
        self.assertGreater(guided[30, 40, 1], probs[30, 40, 1])
        self.assertEqual(guided[30, 40].argmax(), zones.CLASSES.index('grass'))
        self.assertTrue(np.allclose(guided.sum(axis=2), 1))

    def test_uniform_lawn_is_not_a_tree_even_with_high_scores(self):
        image = np.full((80, 100, 3), (40, 140, 40), np.uint8)
        self.assertEqual(zones.visible_crowns(image, [(50, 40, .95, 20)]), [])
        probs = np.full((80, 100, len(zones.CLASSES)), .02, np.float32)
        probs[:, :, zones.CLASSES.index('tree')] = .92
        self.assertFalse(any(r['label'] == 'tree' for r in zones.build_zones(image, probs, (100, 80))))

    def test_outline_is_sent_to_model_and_result_replaces_sketch(self):
        request = {'features': [], 'mode': 'zones', 'marks': [{'kind': 'building', 'p': [12, 5], 'outline': [[12, 5], [20, 5], [20, 11], [12, 11]], 'guide': True}]}
        reply = {'regions': [{'label': 'building', 'polygon': [[130, 60], [190, 60], [190, 100], [130, 100]], 'confidence': .8}]}
        with patch.object(worker, 'zones_command', return_value='python clip_zones.py'), patch.object(worker, 'external', return_value=reply) as model:
            result = refine(self.job, request)
        self.assertEqual(model.call_args.args[1]['guidance'][0]['outline'][0], [120, 50])
        roof = next(g for g in result['features'] if g['kind'] == 'building')
        self.assertEqual(roof['p'], [[13, 6], [19, 6], [19, 10], [13, 10]])

    def test_ground_is_rebuilt_from_reviewed_buildings_and_paths(self):
        features = [{**g, 'status': 'accepted' if g['id'] == 'roof' else 'proposed'} for g in self.geometry['features']]
        features.append({'id': 'walk', 'kind': 'path', 'geometry': 'line',
                         'p': [[5.7, 0], [5.7, 20]], 'width': 1.4, 'status': 'accepted'})
        result = refine(self.job, {'features': features, 'mode': 'ground'})
        lawns = [g for g in result['features'] if g['kind'] == 'grass']
        self.assertTrue(lawns)
        self.assertFalse(any(g['id'] == 'lawn' for g in lawns))
        def covered(point):
            return any(cv2.pointPolygonTest(np.array(g['p'], np.float32), point, False) > 0 for g in lawns)
        self.assertTrue(covered((2, 8)))
        self.assertTrue(covered((22, 8)))
        self.assertTrue(covered((16, 8)))
        self.assertTrue(covered((5.7, 8)))
        self.assertEqual(len(lawns), 1)

    def test_click_reclassifies_path_and_preserves_accepted_building_exactly(self):
        features = [{**g, 'status': 'accepted' if g['id'] == 'roof' else 'proposed'} for g in self.geometry['features']]
        result = refine(self.job, {'features': features, 'mode': 'zones', 'marks': [{'kind': 'path', 'p': [5.7, 8]}, {'kind': 'grass', 'p': [16, 8]}]})
        roof = next(f for f in result['features'] if f['id'] == 'roof')
        self.assertEqual(roof['p'], self.geometry['features'][0]['p'])
        paths = [g for g in result['features'] if g['kind'] == 'path']
        self.assertTrue(paths, 'A path correction should create a path from the similar-coloured strip')
        self.assertTrue(all(g['geometry'] == 'line' for g in paths))
        self.assertTrue((self.job / result['evidence']['shadows']).exists())

    def test_brush_uses_painted_area_and_preserves_locked_building(self):
        features = [{**g, 'status': 'accepted' if g['id'] == 'roof' else 'proposed'} for g in self.geometry['features']]
        captured = {}
        def build(*args, **kwargs):
            captured.update(kwargs)
            return []
        with patch.object(zones, 'build_zones', side_effect=build):
            refine(self.job, {'features': features, 'mode': 'zones', 'marks': [
                {'kind': 'path', 'p': [2, 8], 'stroke': [[2, 8], [22, 8]], 'radius': .5}]})
        mask = captured['forced_masks'][0][1]
        self.assertTrue(mask[80, 30])
        self.assertFalse(mask[110, 30])
        self.assertFalse(mask[80, 160], 'Accepted buildings must remain locked')

    def test_refinement_ids_are_short_and_unique_across_runs(self):
        request = {'features': [], 'mode': 'dots', 'marks': [{'kind': 'bench', 'p': [8, 8]}]}
        first = refine(self.job, request)
        worker.write_json(self.job / 'stages/geometry/result.json', first)
        second = refine(self.job, request)
        ids = [g['id'] for g in second['features']]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual([g['id'] for g in second['features'] if g['kind'] == 'bench'], ['R1', 'R2'])

    def test_dot_correction_can_add_and_remove_an_accepted_wrong_dot(self):
        result = refine(self.job, {'features': [], 'mode': 'dots', 'marks': [{'kind': 'bench', 'p': [8, 8]}]})
        worker.write_json(self.job / 'stages/geometry/result.json', result)
        self.assertEqual(sum(f['kind'] == 'bench' for f in result['features']), 1)
        result = refine(self.job, {'features': [], 'mode': 'dots', 'marks': [{'kind': 'remove', 'p': [8.1, 8]}]})
        self.assertFalse(any(f['kind'] == 'bench' for f in result['features']))
        self.assertEqual(len(result['features']), 2)

    def test_occlusion_allows_a_longer_gap_but_never_crosses_a_building(self):
        lines = [np.array([[10., 50.], [60., 50.]]), np.array([[110., 50.], [190., 50.]])]
        blocked = np.zeros((100, 200), bool)
        occluded = np.zeros_like(blocked)
        occluded[44:57, 59:112] = True
        normal, _, _ = zones.connect_paths(lines, [8, 8], blocked, blocked.shape)
        joined, _, _ = zones.connect_paths(lines, [8, 8], blocked, blocked.shape, occluded)
        self.assertEqual(len(normal), 2)
        self.assertEqual(len(joined), 1)
        blocked[40:60, 80:90] = True
        separate, _, _ = zones.connect_paths(lines, [8, 8], blocked, blocked.shape, occluded)
        self.assertEqual(len(separate), 2)

    def test_shadow_candidates_do_not_cover_uniform_dark_ground(self):
        image = np.full((100, 200, 3), 60, np.uint8)
        self.assertFalse(zones.shadow_mask(image).any())
        image[30:50, 40:160] = 10
        self.assertTrue(zones.shadow_mask(image)[30:50, 40:160].any())

    def test_fragments_with_different_surface_colours_are_not_joined(self):
        lines = [np.array([[10., 50.], [70., 50.]]), np.array([[90., 50.], [190., 50.]])]
        blocked = np.zeros((100, 200), bool)
        found, _, _ = zones.connect_paths(lines, [8, 8], blocked, blocked.shape, colours=[[180, 120, 130], [180, 180, 80]])
        self.assertEqual(len(found), 2)

    def test_overlapping_photos_are_stitched_before_region_detection(self):
        rng = np.random.default_rng(20)
        texture = rng.integers(30, 230, (300, 500, 3), dtype=np.uint8)
        texture[150:] = (70, 145, 75)
        texture[:, 250:300] = (190, 195, 200)
        frames = []
        for i, x in enumerate([0, 100]):
            name = 'photo%d.png' % i
            cv2.imwrite(str(self.job / name), texture[:, x:x + 400])
            frames.append({'id': 'f%d' % i, 'image': name, 'usable': True})
        worker.write_json(self.job / 'job.json', {'media': 'photos', 'sceneMode': 'stitched'})
        worker.write_json(self.job / 'stages/frames/result.json', {'status': 'complete', 'frames': frames})
        correction = worker.stage_correction(self.job)
        worker.write_json(self.job / 'stages/correction/result.json', correction)
        self.assertNotEqual(correction.get('layout'), 'sheet')
        self.assertTrue(all('to_mosaic' in f for f in correction['frames']))
        self.assertEqual([f['id'] for f in worker.keyframes(self.job)], ['scene'])
        self.assertGreater(correction['mosaic']['width'], 450)
        worker.write_json(self.job / 'labels.json', {'labels': [{'kind': 'unknown', 'geometry': 'area'}], 'map': {}})
        worker.write_json(self.job / 'calibration.json', {'markers': [], 'references': [{'a': [20, 20], 'b': [120, 20], 'metres': 10, 'confirmed': True}]})
        with patch.dict('os.environ', {'ERFMAP_CLASSIFIER': 'off', 'ERFMAP_ZONES': 'off'}):
            for stage in ('regions', 'classification', 'merging', 'geometry'):
                result = worker.RUNNERS[stage](self.job)
                worker.write_json(self.job / ('stages/%s/result.json' % stage), result)
        self.assertTrue(result['features'])
        self.assertAlmostEqual(result['scale']['m_per_px'], .1)
        self.assertTrue(all(f['frames'] == ['scene'] for f in result['features']))

    def test_unrelated_photos_do_not_get_false_adjacency(self):
        frames = []
        for i, colour in enumerate([80, 180]):
            name = 'flat%d.png' % i
            cv2.imwrite(str(self.job / name), np.full((100, 100, 3), colour, np.uint8))
            frames.append({'id': 'f%d' % i, 'image': name, 'usable': True})
        worker.write_json(self.job / 'job.json', {'media': 'photos', 'sceneMode': 'stitched'})
        worker.write_json(self.job / 'stages/frames/result.json', {'status': 'complete', 'frames': frames})
        with self.assertRaises(worker.Unavailable):
            worker.stage_correction(self.job)
