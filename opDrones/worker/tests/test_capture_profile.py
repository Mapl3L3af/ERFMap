import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from capture_profile import DEFAULT_PROFILE, capture_profile, job_capture, prompt_templates


class CaptureProfileTests(unittest.TestCase):
    def test_unknown_height_is_not_relabelled_as_25(self):
        profile = capture_profile(None)
        self.assertIsNone(profile['height_agl_m'])
        self.assertEqual(profile['height_source'], 'unknown')
        self.assertFalse(any('25' in p for p in prompt_templates(profile)))

    def test_templates_follow_supplied_height(self):
        self.assertIsNone(DEFAULT_PROFILE['height_agl_m'], 'no fixed capture height')
        self.assertFalse(any('metres' in p for p in prompt_templates(DEFAULT_PROFILE)))
        profile = capture_profile({'height_agl_m': 24, 'height_source': 'user-supplied'})
        self.assertTrue(any('24 metres' in p for p in prompt_templates(profile)))
        for bad in (0, -1, float('nan'), float('inf'), True, '30'):
            with self.assertRaises(ValueError):
                capture_profile({'height_agl_m': bad, 'height_source':'assumed'})

    def test_prompts_adapt_to_each_flyovers_measured_detail(self):
        with tempfile.TemporaryDirectory() as folder:
            job = Path(folder)
            def detail(metres, px):
                (job/'job.json').write_text(json.dumps({'captureProfile': {'height_agl_m': 25, 'height_source': 'assumed'},
                    'calibration': {'references': [{'a': [0, 0], 'b': [px, 0], 'metres': metres, 'confirmed': True}]}}))
                return job_capture(job)
            close, far = detail(1, 100), detail(10, 100)
            self.assertIsNone(close['height_agl_m'], 'the retired 25 m assumption is dropped')
            self.assertAlmostEqual(close['gsd_m'], .01)
            self.assertIn('low-altitude', prompt_templates(close)[0])
            self.assertIn('high-altitude', prompt_templates(capture_profile(far))[0], 'gsd survives the adapter round-trip')

    def test_job_context_reaches_initial_and_classification_adapters(self):
        import erfmap_worker as worker
        with tempfile.TemporaryDirectory() as folder:
            job = Path(folder)
            (job/'job.json').write_text(json.dumps({'captureProfile':DEFAULT_PROFILE}))
            (job/'labels.json').write_text(json.dumps({'labels':[]}))
            self.assertEqual(job_capture(job), DEFAULT_PROFILE)
            with patch.object(worker, 'keyframes', return_value=[]), patch.object(worker, 'zones_command', return_value='fake'), patch.object(worker, 'external', return_value={'regions':[]}) as adapter:
                worker.stage_regions(job)
                self.assertEqual(adapter.call_args.args[1]['captureProfile'], DEFAULT_PROFILE)
            with patch.object(worker, 'stage_result', return_value={'regions':[], 'keyframes':[]}), patch.object(worker, 'classifier_command', return_value='fake'), patch.object(worker, 'external', return_value={'predictions':[]}) as adapter:
                worker.stage_classification(job)
                self.assertEqual(adapter.call_args.args[1]['captureProfile'], DEFAULT_PROFILE)

    def test_training_rejects_invalid_capture_metadata(self):
        from train_semantic import validate
        dataset = {'format':'erfmap-semantic-annotations','version':1,
                   'categories':[{'id':1,'name':'path'}],
                   'images':[{'id':'a','width':100,'height':100,'captureProfile':{'height_agl_m':-30,'height_source':'assumed'}}],
                   'annotations':[{'image_id':'a','category_id':1,'type':'point','points':[[50,50]]}]}
        with self.assertRaises(ValueError):
            validate(dataset)
        dataset['images'][0].pop('captureProfile')
        validate(dataset)


if __name__ == '__main__':
    unittest.main()
