"""Pre-reconstruction capture checks. Planar estimates, never survey completeness."""
from pathlib import Path
import cv2
import numpy as np

DEFAULTS = {'analysis_side': 1024, 'sharpness_min': 25.0, 'texture_min': .008,
            'min_inliers': 24, 'min_inlier_ratio': .35, 'min_match_support': .03,
            'overlap_target': .60, 'coverage_side': 640, 'min_gap_cells': 16}


def quality(image, settings):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    texture = float((cv2.Canny(gray, 60, 160) > 0).mean())
    flags = []
    if texture < settings['texture_min']:
        flags.append('low texture')
        if sharp < settings['sharpness_min']:
            flags.append('blur uncertain (low texture)')
    elif sharp < settings['sharpness_min']:
        flags.append('blurry')
    return {'sharpness': round(sharp, 2), 'texture': round(texture, 4)}, flags


def corners(size):
    w, h = size
    return np.float32([[0, 0], [w, 0], [w, h], [0, h]])


def transform(matrix, points):
    return cv2.perspectiveTransform(np.float32(points).reshape(-1, 1, 2), matrix).reshape(-1, 2)


def verified_pair(a, b, settings):
    """Return a homography a→b only with well spread geometric support."""
    empty = {'ok': False, 'inliers': 0, 'overlap': None, 'reason': 'Not enough distinctive image features.'}
    if a['descriptors'] is None or b['descriptors'] is None:
        return empty, None
    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(a['descriptors'], b['descriptors'], k=2)
    matches = [pair[0] for pair in pairs if len(pair) == 2 and pair[0].distance < .75 * pair[1].distance]
    if len(matches) < settings['min_inliers']:
        return empty, None
    src = np.float32([a['keys'][m.queryIdx].pt for m in matches])
    dst = np.float32([b['keys'][m.trainIdx].pt for m in matches])
    matrix, mask = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
    count = int(mask.sum()) if mask is not None else 0
    evidence = {**empty, 'inliers': count, 'reason': 'Weak or spatially concentrated geometric matches.'}
    if matrix is None or not np.isfinite(matrix).all() or count < settings['min_inliers'] or count / len(matches) < settings['min_inlier_ratio']:
        return evidence, None
    if abs(np.linalg.det(matrix)) < 1e-10:
        return evidence, None
    keep = mask.ravel().astype(bool)
    for points, size in ((src[keep], a['size']), (dst[keep], b['size'])):
        support = cv2.contourArea(cv2.convexHull(points)) / (size[0] * size[1])
        if support < settings['min_match_support'] or np.any(np.ptp(points, axis=0) / size < .2):
            return evidence, None
    box = corners(a['size'])
    homogeneous = np.column_stack([box, np.ones(4)]) @ matrix.T
    # A horizon crossing or extreme extrapolation makes a footprint meaningless.
    z = homogeneous[:, 2]
    if np.any(abs(z) < 1e-6) or not (np.all(z > 0) or np.all(z < 0)):
        return evidence, None
    warped = transform(matrix, box)
    area = abs(cv2.contourArea(warped))
    barea = float(np.prod(b['size']))
    if not np.isfinite(warped).all() or not cv2.isContourConvex(warped) or not .15 < area / barea < 6:
        return evidence, None
    intersection, _ = cv2.intersectConvexConvex(warped, corners(b['size']))
    overlap = max(0., min(1., intersection / max(area, barea)))
    if overlap <= .01:
        return evidence, None
    return {'ok': True, 'inliers': count, 'inlier_ratio': round(count / len(matches), 3),
            'overlap': round(overlap, 3), 'confidence': 'planar estimate',
            'reason': 'Verified matches distributed across both images.'}, matrix


def components(ids, links):
    adjacency = {key: set() for key in ids}
    for link in links:
        if link['ok']:
            adjacency[link['from']].add(link['to'])
            adjacency[link['to']].add(link['from'])
    groups, unseen = [], set(ids)
    for root in ids:
        if root not in unseen:
            continue
        unseen.remove(root)
        stack, group = [root], []
        while stack:
            node = stack.pop()
            group.append(node)
            for other in sorted(adjacency[node]):
                if other in unseen:
                    unseen.remove(other)
                    stack.append(other)
        groups.append(sorted(group))
    return groups


def coverage(footprints, settings):
    """Rasterize aligned footprints; only enclosed holes are suspected gaps."""
    points = np.concatenate(footprints)
    if not np.isfinite(points).all():
        raise ValueError('Invalid planar footprints.')
    lo, hi = points.min(axis=0), points.max(axis=0)
    span = hi - lo
    scale = (settings['coverage_side'] - 4) / max(float(span.max()), 1.)
    width, height = np.maximum(5, np.ceil(span * scale).astype(int) + 5)
    count = np.zeros((height, width), np.uint16)
    for polygon in footprints:
        mask = np.zeros(count.shape, np.uint8)
        pts = np.round((polygon - lo) * scale + 2).astype(np.int32)
        cv2.fillConvexPoly(mask, pts, 1)
        count += mask
    total = int((count > 0).sum())
    number, labels, stats, centroids = cv2.connectedComponentsWithStats((count == 0).astype(np.uint8), 8)
    gaps = []
    gap_mask = np.zeros(count.shape, bool)
    for label in range(1, number):
        x, y, w, h, area = map(int, stats[label])
        if x == 0 or y == 0 or x + w >= width or y + h >= height or area < settings['min_gap_cells']:
            continue
        gaps.append({'bounds_preview_px': [x, y, w, h], 'area_cells': area})
        gap_mask |= labels == label
    preview = np.full((*count.shape, 3), (40, 40, 40), np.uint8)
    preview[count == 1] = (60, 160, 220)  # amber in BGR
    preview[count >= 2] = (110, 165, 65)
    preview[gap_mask] = (70, 65, 230)
    return {'status': 'suspected gaps' if gaps else 'no enclosed gaps detected',
            'gaps': gaps, 'single_view_fraction': round(int((count == 1).sum()) / max(1, total), 3),
            'width': int(width), 'height': int(height),
            'scope': 'Planar footprints within this connected group only. Outer missing strips, hidden ground and absolute survey completeness are unknown.'}, preview


def analyze(job, frames, out, progress=lambda value, message: None):
    settings = dict(DEFAULTS)
    # All scores are measured at a consistent maximum side, not upload resolution.
    orb = cv2.ORB_create(2000)
    records, features = [], {}
    for i, frame in enumerate(frames):
        image = cv2.imread(str(Path(job) / frame['image']))
        if image is None:
            raise ValueError('Could not read capture ' + frame['id'])
        scale = min(1., settings['analysis_side'] / max(image.shape[:2]))
        if scale < 1:
            image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        metrics, flags = quality(image, settings)
        excluded = not frame.get('usable', True)
        records.append({'id': frame['id'], 'source': frame.get('source') or frame['id'], 'image': frame['image'],
                        'analysis_size': [image.shape[1], image.shape[0]], 'metrics': metrics,
                        'flags': list(dict.fromkeys(flags + frame.get('flags', []))),
                        'excluded': excluded, 'exclusion_reasons': frame.get('flags', []) if excluded else []})
        if not excluded:
            keys, descriptors = orb.detectAndCompute(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), None)
            features[frame['id']] = {'keys': keys, 'descriptors': descriptors, 'size': np.array([image.shape[1], image.shape[0]])}
        progress(.2 * (i + 1) / max(1, len(frames)), 'Checking capture quality %d/%d' % (i + 1, len(frames)))
    ids = list(features)
    photos = all(f.get('time_s') is None for f in frames)
    # Photo order is not trusted. Video uses a bounded temporal neighbourhood.
    pair_count = len(ids) * (len(ids) - 1) // 2 if photos else sum(min(3, i) for i in range(len(ids)))
    links, transforms, compared = [], {}, 0
    for i, left in enumerate(ids):
        targets = range(i + 1, len(ids)) if photos else range(i + 1, min(i + 4, len(ids)))
        for j in targets:
            right = ids[j]
            evidence, matrix = verified_pair(features[left], features[right], settings)
            links.append({'from': left, 'to': right, **evidence})
            if matrix is not None:
                transforms[(left, right)] = matrix
            compared += 1
            if compared % 20 == 0 or compared == pair_count:
                progress(.2 + .65 * compared / max(1, pair_count), 'Checking image connections %d/%d' % (compared, pair_count))
    groups = components(ids, links)
    weak = []
    for record in records:
        matches = [link for link in links if link['ok'] and record['id'] in (link['from'], link['to'])]
        record['connections'] = len(matches)
        record['best_overlap'] = max((link['overlap'] for link in matches), default=None)
        if not record['excluded'] and len(ids) > 1:
            if not matches:
                record['flags'].append('no verified connection')
            elif record['best_overlap'] < settings['overlap_target']:
                record['flags'].append('insufficient overlap')
                weak.append(record['id'])
    coverage_groups = []
    for index, group in enumerate(groups):
        if len(group) < 2:
            coverage_groups.append({'images': group, 'status': 'unknown', 'reason': 'One image: no cross-view coverage evidence.'})
            continue
        aligned = {group[0]: np.eye(3)}
        pending = set(group[1:])
        # Prefer strong matches when selecting a spanning tree.
        edges = sorted((l for l in links if l['ok'] and l['from'] in group), key=lambda l: l['inliers'], reverse=True)
        while pending:
            attached = False
            for link in edges:
                a, b = link['from'], link['to']
                if a in aligned and b in pending:
                    aligned[b] = aligned[a] @ np.linalg.inv(transforms[(a, b)])
                    pending.remove(b)
                    attached = True
                    break
                if b in aligned and a in pending:
                    aligned[a] = aligned[b] @ transforms[(a, b)]
                    pending.remove(a)
                    attached = True
                    break
            if not attached:
                break
        try:
            footprints = []
            for key in group:
                matrix, box = aligned[key], corners(features[key]['size'])
                z = np.column_stack([box, np.ones(4)]) @ matrix.T
                if np.any(abs(z[:, 2]) < 1e-6) or not (np.all(z[:, 2] > 0) or np.all(z[:, 2] < 0)):
                    raise ValueError('Unstable chained alignment.')
                polygon = transform(matrix, box)
                if not cv2.isContourConvex(polygon):
                    raise ValueError('Unstable footprint.')
                footprints.append(polygon)
            item, preview = coverage(footprints, settings)
            filename = 'coverage-%d.png' % (index + 1)
            if not cv2.imwrite(str(out / filename), preview):
                raise RuntimeError('Could not save coverage preview.')
            item.update({'images': group, 'image': (out / filename).relative_to(job).as_posix()})
        except (ValueError, KeyError, np.linalg.LinAlgError, cv2.error):
            item = {'images': group, 'status': 'unknown', 'reason': 'Planar alignment is unstable; coverage cannot be estimated reliably.'}
        coverage_groups.append(item)
    reasons = []
    if len(ids) < 2:
        reasons.append('Fewer than two usable views: multi-view reconstruction is blocked.')
    if len(groups) > 1:
        reasons.append('Images form %d disconnected match groups. Capture connecting photos or process groups separately.' % len(groups))
    if any(r['flags'] for r in records):
        reasons.append('Review flagged image quality and connection evidence.')
    if weak:
        reasons.append('Some images have no verified pair meeting the %.0f%% overlap target.' % (settings['overlap_target'] * 100))
    if any(g['status'] == 'suspected gaps' for g in coverage_groups):
        reasons.append('Suspected enclosed coverage gaps need additional photos.')
    if any(g['status'] == 'unknown' for g in coverage_groups):
        reasons.append('Coverage could not be estimated for every group.')
    readiness = 'blocked' if len(ids) < 2 or len(groups) > 1 else 'needs_review' if reasons else 'ready'
    return {'status': 'complete' if readiness == 'ready' else 'needs_review', 'readiness': readiness,
            'summary': '%d usable / %d captures · %d connection groups · %s' % (len(ids), len(frames), len(groups), readiness.replace('_', ' ')),
            'settings': settings, 'images': records, 'links': links, 'groups': groups, 'coverage': coverage_groups,
            'reasons': reasons, 'warnings': ['Capture checks estimate suitability, not reconstruction success. Coverage outside the captured scene and hidden ground remain unknown.',
                'Quality uses frame-selection imagery at a maximum side of 1024 px; originals are unchanged. Existing frame exclusions are retained and listed.',
                'Photo pairs are checked exhaustively.' if photos else 'Video matching checks the next three usable frames only; disconnected groups mean no connection was verified in this search.'],
            'pair_search': 'all photo pairs' if photos else 'next three usable video frames', 'compared_pairs': compared}
