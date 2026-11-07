#!/usr/bin/env python3
"""Two-stage zero-shot labelling with CLIP: zone polygons, then point features.

Stage 1, zones. A grid of overlapping windows is scored by CLIP as building,
path, road, grass or tree. The scores are spread over colour segments so zone
edges follow visible edges, then zones are assigned in priority order:

  1. buildings are reserved first;
  2. paths and roads next (kept as separate classes), closed along their
     length so they stay continuous past small occlusions, and carried to the
     photo edge wherever they leave the frame;
  3. grass is the fallback for everything left, split wherever a path or road
     divides it, with holes kept around buildings and other zones.

Zones never overlap. Paths become erfMap "pavement" areas so their full width
is kept (erfMap's "path" kind is a line).

Stage 2, points. Trees, lamp posts and benches become single points at their
visible location. Points sit on top of the zones and never change them.

It is a general-purpose image model compared with text prompts, not a model
trained on drone surveys: every zone and point is a proposal for review.

    pip install open_clip_torch pillow
    # Used automatically by the worker when open_clip is installed.

Contract (same as ERFMAP_SEGMENTER, plus labels):
stdin  {"frames": [{"id": "f0001", "image": "/abs/path.jpg"}]}
stdout {"model": {...}, "regions": [{"frame", "polygon", "label", "confidence", "role": "zone"|"point"}]}
"""
import json
import os
import sys

import cv2
import numpy as np

CLASSES = ['building', 'path', 'road', 'grass', 'tree']
PROMPTS = {
    'building': ['a building roof', 'a rooftop', 'a house roof'],
    'path': ['a concrete sidewalk', 'a paved footpath', 'a walkway'],
    'road': ['an asphalt road', 'a parking lot', 'asphalt pavement'],
    'grass': ['grass', 'a lawn', 'mowed grass'],
    'tree': ['a tree canopy', 'tree branches', 'a tree'],
}
POINTS = {
    'light': ['a lamp post', 'a street lamp'],
    'bench': ['a park bench', 'a wooden bench'],
}
TEMPLATES = ['an aerial photo of {}.', 'a top-down drone photo of {}.']
ZONE_KIND = {'building': 'building', 'path': 'pavement', 'road': 'road', 'grass': 'grass'}
WORK_SIDE = 1024          # photos are analysed at this longest side
CELLS = 14                # CLIP windows across the longest side
PRIORITY = 0.8            # a higher-priority class wins when within this ratio of the best score
MIN_ZONE = 0.002          # building, path and road pieces smaller than this share of the photo go to grass
POINT_MIN = 0.6           # a lamp post or bench needs at least this probability ...
POINT_MARGIN = 2.0        # ... and this many times the best surface score


# ---------------------------------------------------------------- geometry (no CLIP needed)
def segments(image, block):
    """Colour segments, cut into blocks so each stays local: zone edges then follow visible edges."""
    h, w = image.shape[:2]
    lab = cv2.cvtColor(cv2.GaussianBlur(image, (5, 5), 0), cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float32)
    _, labels, _ = cv2.kmeans(lab, 8, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 15, 1.0), 2, cv2.KMEANS_PP_CENTERS)
    labels = labels.reshape(h, w).astype(np.int32)
    by, bx = np.mgrid[0:h, 0:w]
    key = labels * 10000 + (by // block) * 100 + (bx // block)
    _, seg = np.unique(key, return_inverse=True)
    return seg.reshape(h, w)


def keyhole(outer, holes):
    """One simple polygon for an area with holes: each hole is joined to the outline by a zero-width cut."""
    ring = [tuple(p) for p in outer]
    for hole in holes:
        hole = [tuple(p) for p in hole]
        best = None
        for i, a in enumerate(ring):
            for j, b in enumerate(hole):
                d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
                if best is None or d < best[0]:
                    best = (d, i, j)
        _, i, j = best
        ring = ring[:i + 1] + hole[j:] + hole[:j + 1] + ring[i:]
    return ring


def polygons(mask, scale, size, tol):
    """Polygons (with holes cut in) for each connected piece of a mask, in original-photo pixels."""
    w0, h0 = size
    contours, hierarchy = cv2.findContours(mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    if hierarchy is None:
        return out
    hierarchy = hierarchy[0]

    def simplify(c):
        a = cv2.approxPolyDP(c, tol, True).reshape(-1, 2).astype(np.float64)
        return a if len(a) >= 3 else None

    def to_photo(points):
        pts = []
        for x, y in points:
            x, y = x / scale, y / scale
            # carry zones that touch the frame all the way to the photo edge
            x = 0.0 if x <= 1.5 / scale else w0 if x >= w0 - 1.5 / scale - 1 / scale else x
            y = 0.0 if y <= 1.5 / scale else h0 if y >= h0 - 1.5 / scale - 1 / scale else y
            pts.append([round(x, 1), round(y, 1)])
        return pts

    for i, (nxt, prev, child, parent) in enumerate(hierarchy):
        if parent != -1:
            continue
        outer = simplify(contours[i])
        if outer is None:
            continue
        holes, c = [], child
        while c != -1:
            h = simplify(contours[c])
            if h is not None and cv2.contourArea(h.astype(np.float32)) > 4 * tol * tol:
                holes.append(h)
            c = hierarchy[c][0]
        area = cv2.contourArea(outer.astype(np.float32)) - sum(cv2.contourArea(h.astype(np.float32)) for h in holes)
        out.append({'polygon': to_photo(keyhole(outer, holes)), 'area': float(area), 'mask_index': i})
    return out


def build_zones(image, probs, size):
    """Zones and tree points from per-pixel class probabilities.

    image: work-size BGR image. probs: HxWxC in CLASSES order. size: (w, h) of the original photo.
    Returns regions in original-photo pixels."""
    h, w = image.shape[:2]
    scale = w / size[0]
    block = max(16, max(h, w) // 10)
    seg = segments(image, block)
    n = seg.max() + 1
    counts = np.bincount(seg.ravel(), minlength=n).astype(np.float64)
    mean = np.stack([np.bincount(seg.ravel(), weights=probs[:, :, k].ravel(), minlength=n) for k in range(len(CLASSES))], axis=1) / np.maximum(counts, 1)[:, None]
    b, pth, rd, gr, tr = (mean[:, CLASSES.index(c)] for c in CLASSES)
    best = mean.max(axis=1)
    is_building = b >= PRIORITY * best
    is_line = ~is_building & (np.maximum(pth, rd) >= PRIORITY * best)
    is_path = is_line & (pth >= rd)
    is_road = is_line & (rd > pth)
    building, path, road = is_building[seg], is_path[seg], is_road[seg]

    k = max(3, block // 4) | 1
    small = np.ones((k, k), np.uint8)
    building = cv2.morphologyEx(building.astype(np.uint8), cv2.MORPH_OPEN, small) > 0
    building = cv2.morphologyEx(building.astype(np.uint8), cv2.MORPH_CLOSE, small) > 0
    # Paths and roads are long and continuous: close small gaps along them, but never over a building.
    reach = np.ones((2 * k + 1, 2 * k + 1), np.uint8)
    path = (cv2.morphologyEx(path.astype(np.uint8), cv2.MORPH_CLOSE, reach) > 0) & ~building
    road = (cv2.morphologyEx(road.astype(np.uint8), cv2.MORPH_CLOSE, reach) > 0) & ~building
    both = path & road
    path &= ~(both & (probs[:, :, 2] > probs[:, :, 1]))
    road &= ~path

    def drop_small(mask):
        count, comp, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8))
        keep = np.zeros(count, bool)
        keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= MIN_ZONE * h * w
        return keep[comp]

    building, path, road = drop_small(building), drop_small(path), drop_small(road)
    grass = ~(building | path | road)
    tol = max(1.0, 0.002 * max(h, w))
    regions = []
    for label, mask in (('building', building), ('path', path), ('road', road), ('grass', grass)):
        count, comp = cv2.connectedComponents(mask.astype(np.uint8))
        for c in range(1, count):
            piece = comp == c
            if label == 'grass' and piece.sum() < 0.0005 * h * w:
                continue
            conf = float(probs[:, :, CLASSES.index(label)][piece].mean())
            for p in polygons(piece, scale, size, tol):
                regions.append({'polygon': p['polygon'], 'label': ZONE_KIND[label], 'model_label': label, 'role': 'zone', 'confidence': round(conf, 3)})

    # Trees: one point per crown, wherever trees dominate (usually over grass).
    tree = (tr >= best)[seg] & ~building
    tree = cv2.morphologyEx(tree.astype(np.uint8), cv2.MORPH_OPEN, small)
    crown = max(8, block // 2)
    dist = cv2.distanceTransform(tree, cv2.DIST_L2, 5)
    peaks = (dist >= cv2.dilate(dist, np.ones((crown, crown), np.uint8))) & (dist >= crown / 4)
    ys, xs = np.nonzero(peaks)
    taken = []
    for y, x in sorted(zip(ys, xs), key=lambda q: -dist[q[0], q[1]]):
        if all((x - tx) ** 2 + (y - ty) ** 2 >= crown * crown for tx, ty in taken):
            taken.append((x, y))
    for x, y in taken:
        regions.append(point_region(x / scale, y / scale, 'tree', float(probs[y, x, CLASSES.index('tree')]), crown / scale))
    return regions


def point_region(x, y, label, confidence, size):
    r = max(2.0, size / 4)
    return {'polygon': [[round(x - r, 1), round(y - r, 1)], [round(x + r, 1), round(y - r, 1)], [round(x + r, 1), round(y + r, 1)], [round(x - r, 1), round(y + r, 1)]],
            'label': label, 'role': 'point', 'confidence': round(confidence, 3), 'point': [round(x, 1), round(y, 1)]}


# ---------------------------------------------------------------- CLIP
def main():
    request = json.load(sys.stdin)
    import open_clip
    import torch
    from PIL import Image

    name = os.environ.get('ERFMAP_CLIP_MODEL', 'ViT-B-32')
    weights = os.environ.get('ERFMAP_CLIP_PRETRAINED', 'laion2b_s34b_b79k')
    try:
        model, _, preprocess = open_clip.create_model_and_transforms(name, pretrained=weights or None)
    except Exception as e:
        sys.exit('Could not load CLIP %s (%s). The first run needs internet to download the weights from Hugging Face. %s' % (name, weights, str(e)[-300:]))
    tokenizer = open_clip.get_tokenizer(name)
    model.eval()
    torch.set_grad_enabled(False)

    def embed_text(groups):
        out = []
        for phrases in groups:
            e = model.encode_text(tokenizer([t.format(p) for p in phrases for t in TEMPLATES]))
            e = (e / e.norm(dim=-1, keepdim=True)).mean(dim=0)
            out.append(e / e.norm())
        return torch.stack(out)

    zone_text = embed_text([PROMPTS[c] for c in CLASSES])
    point_kinds = list(POINTS)
    point_text = torch.cat([embed_text([POINTS[k] for k in point_kinds]), zone_text])

    def score(crops, text):
        rows = []
        for i in range(0, len(crops), 64):
            e = model.encode_image(torch.stack([preprocess(c) for c in crops[i:i + 64]]))
            e = e / e.norm(dim=-1, keepdim=True)
            rows.append((100.0 * e @ text.T).softmax(dim=-1))
        return torch.cat(rows).numpy() if rows else np.zeros((0, text.shape[0]))

    regions = []
    for frame in request['frames']:
        original = Image.open(frame['image']).convert('RGB')
        W0, H0 = original.size
        f = WORK_SIDE / max(W0, H0)
        image = original.resize((max(1, round(W0 * f)), max(1, round(H0 * f))))
        W, H = image.size

        # Stage 1: score a grid of overlapping windows, spread the scores per pixel, build zones.
        P = max(32, max(W, H) // CELLS)
        S = P // 2
        xs = list(range(0, max(1, W - P) + 1, S))
        ys = list(range(0, max(1, H - P) + 1, S))
        if xs[-1] + P < W:
            xs.append(W - P)
        if ys[-1] + P < H:
            ys.append(H - P)
        boxes = [(x, y) for y in ys for x in xs]
        pad = P // 4
        probs = score([image.crop((max(0, x - pad), max(0, y - pad), min(W, x + P + pad), min(H, y + P + pad))) for x, y in boxes], zone_text)
        acc = np.zeros((H, W, len(CLASSES)), np.float32)
        hits = np.zeros((H, W, 1), np.float32)
        for (x, y), p in zip(boxes, probs):
            acc[y:y + P, x:x + P] += p
            hits[y:y + P, x:x + P] += 1
        pixel = acc / np.maximum(hits, 1)
        work = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
        for r in build_zones(work, pixel, (W0, H0)):
            regions.append({'frame': frame['id'], **r})

        # Stage 2: lamp posts and benches as points, anywhere in the photo.
        Q = max(24, P // 2)
        boxes = [(x, y) for y in range(0, H - Q + 1, Q) for x in range(0, W - Q + 1, Q)]
        probs = score([image.crop((x, y, x + Q, y + Q)) for x, y in boxes], point_text)
        found = []
        for (x, y), p in zip(boxes, probs):
            o = int(p[:len(point_kinds)].argmax())
            if p[o] >= POINT_MIN and p[o] >= POINT_MARGIN * float(p[len(point_kinds):].max()):
                found.append((float(p[o]), point_kinds[o], x + Q / 2, y + Q / 2))
        kept = []
        for prob, kind, x, y in sorted(found, reverse=True):          # one point per neighbourhood
            if all(abs(x - kx) >= Q or abs(y - ky) >= Q for _, _, kx, ky in kept):
                kept.append((prob, kind, x, y))
        for prob, kind, x, y in kept:
            regions.append({'frame': frame['id'], **point_region(x / f, y / f, kind, prob, Q / f)})
        print('Labelled %s: %d zones and points so far' % (frame['id'], len(regions)), file=sys.stderr)

    json.dump({'model': {'name': 'CLIP zones + points ' + name, 'version': weights or 'untrained',
                         'note': 'Zero-shot: a general-purpose image model compared with text prompts on a grid of windows; not trained on drone surveys.'},
               'regions': regions}, sys.stdout)


if __name__ == '__main__':
    main()
