import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from terrain import build_terrain


class TerrainTests(unittest.TestCase):
    def model(self, **changes):
        return dict(units='metres', coordinates='mosaic-pixels', scaled=True,
                    gravity_aligned=True, ground_filtered=True, source='synthetic plane',
                    origin_px=[0, 0], step_px=[10, 10], grid=[[100, 101], [100, 101]], **changes)

    def build(self, data):
        return build_terrain(data, {'m_per_px': .2, 'origin_px': [-5, -5]}, {'width': 30, 'height': 30})

    def test_relative_plane(self):
        result = self.build(self.model())
        self.assertEqual(result['samples'][0], [1, 1, 0])
        self.assertEqual(result['sourceDatumOffset_m'], 100)
        self.assertEqual(result['groundGrid'], {'origin': [1, 1], 'step': [2, 2], 'heights': [[0, 1], [0, 1]]})
        mid = [c for c in result['contours'] if c['height'] == .5]
        self.assertEqual(len(mid), 2)
        self.assertTrue(all(p[0] == 2 for c in mid for p in c['points']))

    def test_holes_do_not_bridge(self):
        data = self.model()
        data['grid'] = [[100, 101, None], [100, 101, 102]]
        result = self.build(data)
        self.assertEqual(result['observedCells'], 1)
        self.assertIsNone(result['groundGrid']['heights'][0][2])
        self.assertTrue(all(p[0] <= 3 for c in result['contours'] for p in c['points']))

    def test_reject_unqualified_or_invalid(self):
        for key, value in [('scaled', False), ('gravity_aligned', False),
                           ('ground_filtered', False), ('units', 'feet'),
                           ('step_px', [0, 1]), ('grid', [[float('nan'), 1], [2, 3]])]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                data = self.model()
                data[key] = value
                self.build(data)
