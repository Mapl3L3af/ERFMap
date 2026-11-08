"""Capture context shared by intake, adapters and training; never a scale estimate."""
import json
import math
from pathlib import Path

DEFAULT_PROFILE = json.loads((Path(__file__).resolve().parents[1] / 'capture-profile.json').read_text())


def capture_profile(value):
    # Missing profiles belong to older jobs/datasets: their altitude is unknown.
    if value is None:
        return {**DEFAULT_PROFILE, 'height_agl_m': None, 'height_source': 'unknown'}
    if not isinstance(value, dict):
        raise ValueError('Capture profile must be an object.')
    height = value.get('height_agl_m')
    source = value.get('height_source')
    if height is None and source == 'unknown':
        return {**DEFAULT_PROFILE, 'height_agl_m': None, 'height_source': 'unknown'}
    if isinstance(height, bool) or not isinstance(height, (int, float)) or not math.isfinite(height) or not 0 < height <= 10000:
        raise ValueError('Capture height must be a positive number in metres above ground (up to 10000).')
    if source not in ('assumed', 'user-supplied'):
        raise ValueError('Capture height source must be assumed or user-supplied.')
    return {**DEFAULT_PROFILE, 'height_agl_m': height, 'height_source': source}


def job_capture(job):
    file = Path(job) / 'job.json'
    return capture_profile(json.loads(file.read_text()).get('captureProfile') if file.exists() else None)


def prompt_templates(profile):
    height = profile['height_agl_m']
    if height is None:
        return ['an aerial photo of {}.', 'a top-down drone photo of {}.']
    return ['an aerial photo of {}.',
            'a top-down drone photo of {} taken from about %g metres above ground.' % height]
