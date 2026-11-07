"""End-to-end worker test on a synthetic flyover with known scale.

    python -m unittest worker/tests/test_pipeline.py

Needs FFmpeg on PATH and the packages in worker/requirements.txt.
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKER = HERE.parent / 'erfmap_worker.py'
sys.path.insert(0, str(HERE))
import make_synthetic_video as synthetic  # noqa: E402


class PipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.job = Path(tempfile.mkdtemp())
        (cls.job / 'original').mkdir()
        synthetic.main(str(cls.job / 'original' / 'flyover.mp4'))
        (cls.job / 'job.json').write_text(json.dumps({'original': {'path': 'original/flyover.mp4'}}))
        labels = [{'kind': 'grass', 'geometry': 'area'}, {'kind': 'water', 'geometry': 'area'}, {'kind': 'unknown', 'geometry': 'area'}]
        (cls.job / 'labels.json').write_text(json.dumps({'labels': labels, 'map': {}}))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.job, ignore_errors=True)

    def run_stage(self, stage):
        out = subprocess.run([sys.executable, str(WORKER), 'run', stage, str(self.job)], capture_output=True, text=True, check=True)
        return json.loads(out.stdout.strip().splitlines()[-1])

    def test_pipeline(self):
        self.assertEqual(self.run_stage('probe')['status'], 'complete')
        frames = json.loads((self.job / 'stages/frames/result.json').read_text()) if self.run_stage('frames') else None
        flagged = [f for f in frames['frames'] if not f['usable']]
        self.assertTrue(flagged, 'the blurred and dark frames should be flagged')
        self.run_stage('correction')
        self.assertEqual(self.run_stage('markers')['status'], 'needs_review')
        markers = json.loads((self.job / 'stages/markers/result.json').read_text())['markers']
        self.assertGreaterEqual(len(markers), 2)
        self.run_stage('regions')
        self.assertEqual(self.run_stage('classification')['status'], 'unavailable')
        self.run_stage('merging')
        self.assertEqual(self.run_stage('geometry')['status'], 'needs_review')   # no confirmed marker yet
        (self.job / 'calibration.json').write_text(json.dumps({'markers': [{**m, 'confirmed': True} for m in markers]}))
        self.run_stage('geometry')
        geometry = json.loads((self.job / 'stages/geometry/result.json').read_text())
        mosaic = json.loads((self.job / 'stages/correction/result.json').read_text())['mosaic']
        # Ground truth: the board is 37 px on a 120 px/m ground, frames are scaled 0.8, then the mosaic scale.
        truth = 0.3048 / (37 * 0.8 * mosaic['scale'])
        self.assertLess(abs(geometry['scale']['m_per_px'] / truth - 1), 0.05)
        self.assertTrue(geometry['features'])


class PhotoPipelineTest(unittest.TestCase):
    """A handful of stills in shuffled order, scaled by one measured distance."""
    @classmethod
    def setUpClass(cls):
        cls.job = Path(tempfile.mkdtemp())
        (cls.job / 'original').mkdir()
        video = cls.job / 'flyover.mp4'
        synthetic.main(str(video))
        originals = []
        for t in (4.5, 1, 2.9, 3.5, 2.2):          # out of order, ~75% overlap; t=2.9 falls in the blurred stretch
            name = 'IMG_%s.jpg' % str(t).replace('.', '_')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(t), '-i', str(video), '-frames:v', '1', '-q:v', '2',
                            str(cls.job / 'original' / name)], check=True)
            originals.append({'name': name, 'path': 'original/' + name})
        (cls.job / 'job.json').write_text(json.dumps({'media': 'photos', 'original': originals[0], 'originals': originals}))
        labels = [{'kind': 'grass', 'geometry': 'area'}, {'kind': 'unknown', 'geometry': 'area'}]
        (cls.job / 'labels.json').write_text(json.dumps({'labels': labels, 'map': {}}))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.job, ignore_errors=True)

    run_stage = PipelineTest.run_stage

    def test_photos(self):
        self.assertEqual(self.run_stage('probe')['status'], 'complete')
        self.run_stage('frames')
        frames = json.loads((self.job / 'stages/frames/result.json').read_text())['frames']
        self.assertEqual(len(frames), 5)
        self.assertEqual(sum(f['usable'] for f in frames), 4, 'only the blurred still should be dropped')
        self.assertEqual(self.run_stage('correction')['status'], 'complete')
        correction = json.loads((self.job / 'stages/correction/result.json').read_text())
        self.assertIn('4 of them aligned', correction['summary'])
        for stage in ('markers', 'regions', 'classification', 'merging'):
            self.run_stage(stage)
        # A 10 m tape along the preview's x axis. Ground truth is 120 px/m, frames are scaled 0.8, then the mosaic scale.
        px_per_m = 120 * 0.8 * correction['mosaic']['scale']
        ref = {'id': 'D1', 'a': [100, 200], 'b': [100 + 10 * px_per_m, 200], 'metres': 10, 'confirmed': True}
        (self.job / 'calibration.json').write_text(json.dumps({'markers': [], 'references': [ref], 'markerSideM': 0.3048}))
        self.run_stage('geometry')
        geometry = json.loads((self.job / 'stages/geometry/result.json').read_text())
        self.assertAlmostEqual(geometry['scale']['m_per_px'] * px_per_m, 1, places=6)
        self.assertEqual(geometry['scale']['references'], 1)
        self.assertTrue(geometry['features'])


if __name__ == '__main__':
    unittest.main()
