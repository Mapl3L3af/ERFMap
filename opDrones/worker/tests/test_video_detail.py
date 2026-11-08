"""Video coverage stays dense as duration grows, without model-frame caps."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('video_worker', Path(__file__).parents[1] / 'erfmap_worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class VideoDetailTest(unittest.TestCase):
    def test_long_video_extraction_covers_every_section(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            commands = []

            def extract(cmd, **kwargs):
                commands.append(cmd)
                start = int(cmd[cmd.index('-start_number') + 1])
                count = round(float(cmd[cmd.index('-t') + 1]) * 2)
                for index in range(start, start + count):
                    (out / ('f%08d.jpg' % index)).touch()
                return SimpleNamespace(returncode=0)

            with patch.object(worker, 'need_cv'), patch.object(worker, 'tool', return_value='ffmpeg'), \
                    patch.object(worker, 'read_json', return_value={'original': {'path': 'video.mp4'}}), \
                    patch.object(worker, 'stage_result', return_value={'metadata': {'duration_s': 65, 'fps': 30}}), \
                    patch.object(worker, 'stage_dir', return_value=out), patch.object(worker, 'progress'), \
                    patch.object(worker.subprocess, 'run', side_effect=extract), \
                    patch.object(worker, 'imread', return_value=SimpleNamespace(shape=(1080, 1920, 3))), \
                    patch.object(worker, 'frame_metrics', return_value={}), \
                    patch.object(worker, 'score_frames', side_effect=lambda frames, fps: frames):
                frames = worker.stage_frames(directory)
            self.assertEqual([cmd[cmd.index('-ss') + 1] for cmd in commands], ['0', '30', '60'])
            self.assertEqual(len(frames), 130)
            self.assertEqual(frames[-1]['time_s'], 64.5)
            self.assertEqual(len({f['id'] for f in frames}), 130)

    def test_all_aligned_frames_reach_analysis(self):
        frames = [{'id': str(i), 'to_mosaic': []} for i in range(130)]
        with patch.object(worker, 'stage_result', return_value={'frames': frames}), \
                patch.object(worker, 'read_json', return_value={}):
            self.assertEqual(worker.keyframes('/unused'), frames)


if __name__ == '__main__':
    unittest.main()
