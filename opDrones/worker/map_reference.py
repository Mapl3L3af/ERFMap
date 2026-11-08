"""Optional map geometry priors and explicit ground-height checks, with provenance."""
import json
from pathlib import Path


def job_reference(job):
    path = Path(job) / 'reference.json'
    return json.loads(path.read_text()) if path.exists() else None


def masks(reference, shape, factor):
    import cv2
    import numpy as np
    result = {kind: np.zeros(shape, np.uint8) for kind in ('building', 'path')}
    for feature in (reference or {}).get('features', []):
        kind = feature['kind']
        if kind not in result:
            continue
        points = np.round(np.asarray(feature['points']) * factor).astype(np.int32)
        if kind == 'building':
            cv2.fillPoly(result[kind], [points], 1)
        else:
            cv2.polylines(result[kind], [points], False, 1, max(1, min(4*max(shape), round(feature['width_px']*factor))))
    result['path'][result['building'] > 0] = 0
    return result


def guide(pixel, reference, factor, classes):
    if not reference or not reference.get('transform'):
        return pixel
    import cv2
    import numpy as np
    output = pixel.copy()
    for kind, mask in masks(reference, pixel.shape[:2], factor).items():
        influence = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 1) * 0.8
        output *= 1-influence[:, :, None]
        output[:, :, classes.index(kind)] += influence
    return output / np.maximum(output.sum(axis=2, keepdims=True), 1e-6)


def agreement(regions, reference, size):
    if not reference or not reference.get('transform'):
        return None
    import cv2
    import numpy as np
    factor = min(1, 1024/max(size))
    shape = (max(1, round(size[1]*factor)), max(1, round(size[0]*factor)))
    priors = masks(reference, shape, factor)
    predicted = {k: np.zeros(shape, np.uint8) for k in priors}
    for region in regions:
        kind = region.get('model_label', region.get('label'))
        if kind in predicted and region.get('polygon'):
            cv2.fillPoly(predicted[kind], [np.round(np.asarray(region['polygon'])*factor).astype(np.int32)], 1)
    scores = {}
    for kind, mask in priors.items():
        if not mask.any():
            continue
        other = predicted[kind]
        scores[kind] = {'reference_coverage': float(((mask > 0) & (other > 0)).sum()/mask.sum()),
                        'iou': float(((mask > 0) & (other > 0)).sum()/max(1, ((mask > 0) | (other > 0)).sum()))}
    return {'source':reference['source'], 'alignment_rms_m':reference['transform']['rms_m'], 'agreement':scores,
            'note':'Reference-assisted agreement, not independent accuracy. Verify image evidence and alignment; source maps may be out of date.'}


def terrain_check(reference, geometry):
    import numpy as np
    points = [f for f in (reference or {}).get('features', []) if f['kind'] == 'ground']
    if not points:
        return None
    terrain = geometry.get('terrain') or {}
    grid = terrain.get('groundGrid')
    if not grid:
        return {'status':'unavailable', 'reason':'No reconstructed ground grid to compare with reference elevations.'}
    scale = geometry['scale']
    sampled = []
    for feature in points:
        px, py = feature['points'][0]
        q = [(v-scale['origin_px'][i])*scale['m_per_px'] for i,v in enumerate((px,py))]
        x,y = [(q[i]-grid['origin'][i])/grid['step'][i] for i in (0,1)]
        rows = grid['heights']
        if not 0 <= x <= len(rows[0])-1 or not 0 <= y <= len(rows)-1:
            continue
        ix,iy = min(int(x),len(rows[0])-2),min(int(y),len(rows)-2)
        heights = [rows[iy][ix],rows[iy][ix+1],rows[iy+1][ix],rows[iy+1][ix+1]]
        if any(v is None for v in heights):
            continue
        u,v = x-ix,y-iy
        z = heights[0]*(1-u)*(1-v)+heights[1]*u*(1-v)+heights[2]*(1-u)*v+heights[3]*u*v
        sampled.append((feature['id'],float(z-feature['elevation_m'])))
    if len(sampled)<2:
        return {'status':'insufficient', 'matched':len(sampled), 'reason':'At least two elevation references must fall in fully observed ground cells.'}
    errors = np.asarray([p[1] for p in sampled])
    offset = float(np.median(errors))
    return {'status':'compared', 'matched':len(sampled), 'relative_rmse_m':float(np.sqrt(np.mean((errors-offset)**2))),
            'removed_vertical_offset_m':offset, 'reference_datum':reference['verticalDatum'],
            'note':'Relative ground-height agreement after removing datum offset; not surveyed contour accuracy. No interpolation across missing cells.'}
