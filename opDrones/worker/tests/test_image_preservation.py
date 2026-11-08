"""Detection imagery must retain natural lawn texture and canopy boundaries."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import erfmap_worker as worker


class ImagePreservationTest(unittest.TestCase):
    def test_correction_preserves_lawn_and_canopy_pixels_in_both_layouts(self):
        rng = np.random.default_rng(12)
        image = np.full((160, 240, 3), (65, 145, 70), np.int16)
        image += rng.integers(-5, 6, image.shape, dtype=np.int16)
        image[40:110, 120:190] = (30, 80, 35)
        image[40:110, 120:190] += rng.integers(-12, 13, (70, 70, 3), dtype=np.int16)
        image = image.astype(np.uint8)
        for mode in ('stitched', 'per-image'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                job = Path(directory)
                frames = worker.stage_dir(job, 'frames')
                # Start with a JPEG, as drone photos commonly do. Processing
                # must not add another generation of compression artifacts.
                cv2.imwrite(str(frames / 'source.jpg'), image)
                decoded = worker.imread(frames / 'source.jpg')
                worker.write_json(job / 'job.json', {'media': 'photos', 'sceneMode': mode})
                worker.write_json(frames / 'result.json', {'status': 'complete', 'frames': [
                    {'id': 'f0001', 'image': 'stages/frames/source.jpg', 'usable': True}]})
                with patch.dict(os.environ, {'ERFMAP_NODEODM_URL': ''}):
                    result = worker.stage_correction(job)
                prepared = job / result['frames'][0]['after']
                mosaic = job / result['mosaic']['image']
                self.assertEqual(prepared.suffix, '.png')
                self.assertEqual(mosaic.suffix, '.png')
                np.testing.assert_array_equal(worker.imread(prepared), decoded)
                np.testing.assert_array_equal(worker.imread(mosaic)[:160, :240], decoded)


if __name__ == '__main__':
    unittest.main()
