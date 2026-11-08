"""Capture context shared by intake, adapters and training.

There is no fixed capture height: each flyover is described by the ground detail
measured from its own photos or frames (metres per pixel after calibration), plus
a height only when the person supplied one for that flyover."""
import json
import math
from pathlib import Path

DEFAULT_PROFILE = json.loads((Path(__file__).resolve().parents[1] / 'capture-profile.json').read_text())


def capture_profile(value):
    profile = _capture_profile(value)
    gsd = value.get('gsd_m') if isinstance(value, dict) else None
    if isinstance(gsd, (int, float)) and not isinstance(gsd, bool) and math.isfinite(gsd) and gsd > 0:
        profile['gsd_m'] = gsd
    return profile


def _capture_profile(value):
    # Missing profiles: the height is unknown, and nothing is assumed in its place.
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
    if source not in ('assumed', 'user-supplied'):  # 'assumed' only appears in older jobs
        raise ValueError('Capture height source must be assumed or user-supplied.')
    return {**DEFAULT_PROFILE, 'height_agl_m': height, 'height_source': source}


def measured_gsd(calibration):
    """Metres per mosaic pixel from this job's own markers or reference lines."""
    calibration = calibration or {}
    values = []
    side = calibration.get('markerSideM') or 0
    for m in calibration.get('markers') or []:
        c = m.get('corners') or []
        if side > 0 and len(c) == 4 and m.get('confirmed', True):
            px = sum(math.dist(c[i], c[(i + 1) % 4]) for i in range(4)) / 4
            if px > 0:
                values.append(side / px)
    for r in calibration.get('references') or []:
        if r.get('confirmed', True) and (r.get('metres') or 0) > 0 and r.get('a') and r.get('b'):
            px = math.dist(r['a'], r['b'])
            if px > 0:
                values.append(r['metres'] / px)
    if not values:
        return None
    values.sort()
    return values[len(values) // 2]


def job_capture(job):
    file = Path(job) / 'job.json'
    meta = json.loads(file.read_text()) if file.exists() else {}
    stored = meta.get('captureProfile')
    if stored and stored.get('height_source') == 'assumed':
        stored = None            # older jobs carried the retired fixed 25 m default
    profile = capture_profile(stored)
    gsd = measured_gsd(meta.get('calibration'))
    if gsd:
        profile['gsd_m'] = round(gsd, 5)
    return profile


def prompt_templates(profile):
    height = profile.get('height_agl_m')
    gsd = profile.get('gsd_m')
    if height is None:
        # Describe the detail this flyover actually has rather than assuming a height.
        if gsd and gsd < 0.015:
            return ['a close, low-altitude top-down drone photo of {}.', 'a detailed overhead photo of {}.']
        if gsd and gsd > 0.06:
            return ['a high-altitude aerial photo of {}.', 'a satellite-style overhead image of {}.']
        return ['an aerial photo of {}.', 'a top-down drone photo of {}.']
    return ['an aerial photo of {}.',
            'a top-down drone photo of {} taken from about %g metres above ground.' % height]
