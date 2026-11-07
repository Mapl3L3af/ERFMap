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


if __name__ == '__main__':
    unittest.main()
