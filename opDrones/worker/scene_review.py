"""Image-guided review refinement. Called by the intake server, never a web import."""
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

import erfmap_worker as worker
from adapters import clip_zones as zones


def colour_region(image, point):
    """A click selects connected similar colour, bounded to a local part of the scene."""
    h, w = image.shape[:2]
    x, y = np.round(point).astype(int)
    x, y = int(np.clip(x, 0, w - 1)), int(np.clip(y, 0, h - 1))
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    mask = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(lab, mask, (x, y), (0, 0, 0), (40, 14, 14), (40, 14, 14),
                  cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | (1 << 8) | 4)
    yy, xx = np.ogrid[:h, :w]
    selected = (mask[1:-1, 1:-1] > 0) & ((xx - x) ** 2 + (yy - y) ** 2 <= (max(h, w) * .25) ** 2)
    cv2.circle(selected := selected.astype(np.uint8), (x, y), 2, 1, -1)
    return selected.astype(bool)


def refine(job, request):
    geometry = worker.read_json(job / 'stages/geometry/result.json')
    if geometry['scale'].get('mode') == 'per-image':
        raise ValueError('Start a new intake to use scene review; this older job uses separate photo scales.')
    sc = geometry['scale']
    scale, origin = sc['m_per_px'], np.array(sc['origin_px'])
    to_px = lambda p: np.asarray(p, float) / scale + origin
    to_m = lambda p: ((np.asarray(p, float) - origin) * scale).round(3).tolist()
    image = worker.imread(job / geometry['mosaic']['image'])
    h0, w0 = image.shape[:2]
    f = min(1, 900 / max(h0, w0))
    work = cv2.resize(image, (max(1, round(w0 * f)), max(1, round(h0 * f))))
    h, w = work.shape[:2]
    features = request['features']
    mode = request.get('mode', 'zones')
    stamp = str(time.time_ns())

    used_ids = {g['id'] for g in geometry['features']}
    next_id = 1

    def proposal(kind, p, region=None, **extra):
        nonlocal next_id
        while 'R' + str(next_id) in used_ids:
            next_id += 1
        feature_id = 'R' + str(next_id)
        used_ids.add(feature_id)
        return {'id': feature_id, 'kind': kind, 'predicted_kind': None,
                'geometry': 'point' if kind in ('tree', 'bush', 'bench', 'light') else 'line' if kind == 'path' else 'area',
                'p': p, 'region': region or p, 'confidence': None, 'frames': ['scene'],
                'flags': ['review refinement; confirm geometry'], **extra}

    guided = [m for m in request.get('marks', []) if m.get('guide') or m.get('outline')]
    if guided and mode in ('zones', 'dots'):
        command = worker.zones_command()
        if not command or 'clip_zones.py' not in command:
            raise ValueError('Sketch guidance requires the bundled model pipeline. Install a zone model before reevaluating.')
        guidance = []
        for mark in request.get('marks', []):
            item = {**mark, 'p': to_px([mark['p']])[0].tolist()}
            for key in ('stroke', 'outline'):
                if mark.get(key):
                    item[key] = to_px(mark[key]).tolist()
            if mark.get('radius'):
                item['radius'] = mark['radius'] / scale
            guidance.append(item)
        phase = 'zones' if mode == 'zones' else 'points'
        reply = worker.external(command, {'mapReference': worker.job_reference(job), 'captureProfile': worker.job_capture(job), 'phase': phase, 'guidance': guidance, 'locked_buildings': [to_px(g['p']).tolist() for g in features if g['kind'] == 'building' and g['status'] == 'accepted'], 'frames': [{'id': 'scene', 'image': str((job / geometry['mosaic']['image']).resolve())}]}, 'Sketch-guided detection')
        replaced = ('building', 'path', 'road', 'grass', 'tree', 'unknown') if mode == 'zones' else ('bench', 'light', 'tree', 'bush')
        # Explicitly accepted geometry stays fixed; sketches are only model prompts.
        accepted = {g['id']: g for g in features if g['status'] == 'accepted'}
        output = [{**g, **accepted.get(g['id'], {})} for g in geometry['features'] if g['kind'] not in replaced or g['id'] in accepted]
        for r in reply.get('regions', []):
            kind = r.get('label')
            if kind not in replaced:
                continue
            poly = r['polygon']
            point = r.get('point')
            centre = to_m([point] if point else [np.mean(poly, axis=0)])[0]
            if any(g['kind'] == kind and (np.linalg.norm(np.asarray(g['p'][0]) - centre) < max(.5, scale * 10) if g['geometry'] == 'point' else cv2.pointPolygonTest(np.asarray(g['region'] if g['geometry'] == 'line' and g.get('region') else g['p'], np.float32), tuple(centre), False) >= 0) for g in output):
                continue
            p = [point] if point else r.get('line') or poly
            output.append(proposal(kind, to_m(p), to_m(poly), confidence=r.get('confidence'), predicted_kind=kind, width_m=r.get('width', 0) * scale or None, widths_m=[v*scale for v in r.get('widths', [])]))
        for mark in request.get('marks', []):
            if mark['kind'] == 'remove':
                output = [g for g in output if g['kind'] not in ('tree', 'bush', 'bench', 'light') or np.linalg.norm(np.asarray(g['p'][0]) - mark['p']) > max(1, scale * 25)]
        geometry['guidanceModel'] = reply.get('model', {}).get('name', 'Bundled model council')
        if mode == 'dots':
            geometry['pointDetection'] = ('SAM 3 used your example outlines to search for similar objects. Review every proposal.' if 'sam3' in reply.get('model', {}).get('members', []) else 'SAM 3 is unavailable or disabled: example appearance was not used. The council searched by category only. Enable SAM 3 for example-guided detection.')
    elif mode == 'ground':
        # One default grass layer underlies every reviewed feature.
        output = [g for g in geometry['features'] if g['kind'] != 'grass']
        background = to_m([[0, 0], [w0, 0], [w0, h0], [0, h0]])
        output.insert(0, proposal('grass', background, flags=['Default grass background']))
    elif mode == 'points':
        output = list(geometry['features'])
        command = worker.zones_command()
        if command and 'clip_zones.py' in command:
            reply = worker.external(command, {'mapReference': worker.job_reference(job), 'captureProfile': worker.job_capture(job), 'phase': 'points', 'frames': [{'id': 'scene', 'image': str((job / geometry['mosaic']['image']).resolve())}]}, 'Point detection')
            for r in reply.get('regions', []):
                kind = r.get('label')
                if kind not in ('bench', 'light', 'tree', 'bush') or not r.get('point'):
                    continue
                p = to_m([r['point']])
                if any(g['kind'] == kind and np.linalg.norm(np.array(g['p'][0]) - p[0]) < max(.5, scale * 10) for g in output):
                    continue
                output.append(proposal(kind, p, to_m(r['polygon']), confidence=r.get('confidence'), predicted_kind=kind))
        geometry['pointDetection'] = 'Model proposals ready for review.' if command and 'clip_zones.py' in command else 'No bundled point model is installed. Mark benches and lights on the scene to add them.'
    elif mode == 'dots':
        output = list(geometry['features'])
        for mark in request.get('marks', []):
            p = mark['p']
            if mark['kind'] == 'remove':
                candidates = [g for g in output if g['kind'] in ('tree', 'bush', 'bench', 'light')]
                nearest = min(candidates, key=lambda g: np.linalg.norm(np.array(g['p'][0]) - p), default=None)
                if nearest and np.linalg.norm(np.array(nearest['p'][0]) - p) <= max(1, scale * 25):
                    output.remove(nearest)
            else:
                output.append(proposal(mark['kind'], [p]))
    else:
        probs = np.full((h, w, len(zones.CLASSES)), .02, np.float32)
        probs[:, :, zones.CLASSES.index('grass')] = .3
        locked = np.zeros((h, w), np.uint8)
        locked_features = []
        for g in features:
            if g['status'] == 'rejected' or g['kind'] not in zones.CLASSES:
                continue
            mask = np.zeros((h, w), np.uint8)
            p = np.round(to_px(g.get('region') or g['p']) * f).astype(np.int32)
            if len(p) >= 3:
                cv2.fillPoly(mask, [p], 1)
            else:
                cv2.circle(mask, tuple(p[0]), max(3, round(w * .015)), 1, -1)
            if g['kind'] == 'building' and g['status'] == 'accepted':
                cv2.fillPoly(locked, [np.round(to_px(g['p']) * f).astype(np.int32)], 1)
                original = next(x for x in geometry['features'] if x['id'] == g['id'])
                locked_features.append({**original, 'p': g['p'], 'region': g['p'], 'kind': 'building'})
            probs[mask > 0] = .01
            probs[:, :, zones.CLASSES.index(g['kind'])][mask > 0] = .95
        forced, shadows = [], zones.shadow_mask(work)
        for mark in request.get('marks', []):
            if mark.get('stroke'):
                mask = np.zeros((h, w), np.uint8)
                points = np.round(to_px(mark['stroke']) * f).astype(np.int32)
                radius = max(1, round(mark['radius'] / scale * f))
                cv2.polylines(mask, [points], False, 1, radius * 2)
                for point in (points[0], points[-1]):
                    cv2.circle(mask, tuple(point), radius, 1, -1)
                mask = mask.astype(bool)
            else:
                mask = colour_region(work, to_px([mark['p']])[0] * f)
            if mark['kind'] == 'shadow':
                shadows |= mask
                continue
            mask &= locked == 0
            kind = mark['kind']
            probs[mask] = .001
            probs[:, :, zones.CLASSES.index(kind)][mask] = .999
            forced.append((kind, mask))
        # Locked building footprints are exact constraints on every subsequent path fit.
        generated = zones.build_zones(work, probs, (w0, h0), locked_buildings=locked, forced_masks=forced, occlusion_mask=shadows)
        output = locked_features + [g for g in geometry['features'] if g['kind'] not in ('building', 'grass', 'path', 'road', 'unknown', 'tree')]
        for r in generated:
            kind = r['label']
            poly = r['polygon']
            mask = np.zeros((h, w), np.uint8)
            cv2.fillPoly(mask, [np.round(np.array(poly) * f).astype(np.int32)], 1)
            if kind == 'building' and locked_features and (locked[mask > 0] > 0).mean() > .5:
                continue
            p = [r['point']] if r.get('point') else r.get('line') or poly
            output.append(proposal(kind, to_m(p), to_m(poly), width_m=r.get('width', 0) * scale or None, widths_m=[v*scale for v in r.get('widths', [])]))
        overlay = np.zeros((h, w, 4), np.uint8)
        overlay[shadows] = (220, 90, 180, 150)
        target = job / 'stages/regions/review-shadows.png'
        cv2.imwrite(str(target), cv2.resize(overlay, (w0, h0), interpolation=cv2.INTER_NEAREST))
        geometry['evidence'] = {'shadows': worker.rel(job, target), 'note': 'Candidate shade plus your shadow corrections. Shade is evidence of occlusion, not a ground class.'}
    geometry['features'] = output
    geometry['revision'] = stamp
    geometry['summary'] = '%d features after review refinement' % len(output)
    return geometry


if __name__ == '__main__':
    job = Path(sys.argv[1])
    result = refine(job, json.load(sys.stdin))
    worker.write_json(job / 'stages/geometry/result.json', result)
    print(json.dumps({'features': len(result['features']), 'pointDetection': result.get('pointDetection')}))
