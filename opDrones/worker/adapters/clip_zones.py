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


def build_zones(image, probs, size, trees=None, votes=None):
    """Zones and tree points from per-pixel class probabilities.

    image: work-size BGR image. probs: HxWxC in CLASSES order (the council's combined vote).
    size: (w, h) of the original photo. trees: optional [(x, y, confidence, radius)] in work pixels
    from a tree detector, used instead of finding crowns in probs. votes: optional
    {member: HxWxC probs}, reported per zone so a reviewer can see who agreed.
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
    # Where a tree crown is the best match, the ground under it is left to grass (the tree becomes a point),
    # so tree shadows and canopies are not mistaken for road.
    is_line = ~is_building & (np.maximum(pth, rd) >= PRIORITY * best) & (tr < best)
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
            k_label = CLASSES.index(label)
            conf = float(probs[:, :, k_label][piece].mean())
            said = {m: round(float(v[:, :, k_label][piece].mean()), 3) for m, v in (votes or {}).items()}
            for p in polygons(piece, scale, size, tol):
                region = {'polygon': p['polygon'], 'label': ZONE_KIND[label], 'model_label': label, 'role': 'zone', 'confidence': round(conf, 3)}
                if said:
                    region['votes'] = said
                regions.append(region)

    if trees is not None:                 # a tree detector found the crowns
        for x, y, conf, r in trees:
            regions.append(point_region(x / scale, y / scale, 'tree', conf, 2 * r / scale))
        return regions
    # Trees: one point per crown, wherever trees dominate (usually over grass).
    tree = (tr >= PRIORITY * best)[seg] & ~building & ~path & ~road
    tree = cv2.morphologyEx(tree.astype(np.uint8), cv2.MORPH_OPEN, small)
    crown = max(8, block // 2)
    # Pad with background first: otherwise OpenCV treats the photo edge as far from any edge,
    # and the deepest "crown centres" all land on the border.
    dist = cv2.distanceTransform(cv2.copyMakeBorder(tree, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0), cv2.DIST_L2, 5)[1:-1, 1:-1]
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


# ---------------------------------------------------------------- the council
# Each member scores the same photo; members that are not installed sit out.
#   clip       zone classes from a grid of windows, plus lamp posts and benches   (open_clip_torch)
#   segformer  a per-pixel scene model; its label names are mapped onto ours    (transformers)
#   deepforest tree crowns, trained on aerial and drone imagery                 (deepforest)
# Zone scores are a weighted average per pixel. A member only counts where its
# own labels are ones we map (SegFormer saying "sky" or "water" does not vote).
WEIGHTS = {'clip': 1.0, 'segformer': 1.0}
TREE_WEIGHT = 0.6         # how strongly a DeepForest crown pulls its pixels towards "tree"
TREE_MIN = 0.3            # DeepForest boxes below this score are ignored
SYNONYMS = {              # label names of scene models (ADE20K, aerial datasets) -> our classes
    'building': {'building', 'edifice', 'house', 'skyscraper', 'roof', 'hut', 'hovel', 'shack', 'tower', 'garage'},
    'road': {'road', 'route', 'car', 'auto', 'automobile', 'runway', 'parking', 'parking lot', 'impervious surfaces', 'impervious surface'},
    'path': {'sidewalk', 'pavement walkway', 'path', 'footpath', 'stairs', 'steps', 'stairway', 'staircase'},
    'grass': {'grass', 'field', 'earth', 'ground', 'land', 'soil', 'low vegetation', 'rangeland', 'plant', 'flora', 'plant life', 'flower', 'dirt track'},
    'tree': {'tree', 'palm', 'palm tree', 'forest', 'trees'},
}
POINT_SYNONYMS = {'light': {'streetlight', 'street lamp', 'lamp post', 'lamppost', 'light'}, 'bench': {'bench'}}


def map_labels(id2label, groups):
    """Indices of a model's labels that belong to each of our classes, matched on whole synonyms."""
    out = {k: [] for k in groups}
    for i, name in id2label.items():
        names = {n.strip().lower() for n in str(name).replace(';', ',').split(',')}
        for k, syn in groups.items():
            if names & syn:
                out[k].append(int(i))
                break
    return out


def combine(members, shape):
    """Weighted per-pixel average of members' class probabilities.

    members: {name: (probs HxWxC, weight HxW)}. Returns HxWxC summing to 1 where anyone voted."""
    total = np.zeros(shape + (len(CLASSES),), np.float32)
    weight = np.zeros(shape + (1,), np.float32)
    for probs, w in members.values():
        total += probs * w[:, :, None]
        weight += w[:, :, None]
    return np.where(weight > 0, total / np.maximum(weight, 1e-6), 1.0 / len(CLASSES))


def add_tree_crowns(probs, crowns):
    """Pull pixels inside detected tree crowns towards "tree" by the detector's confidence."""
    out = probs.copy()
    onehot = np.zeros(len(CLASSES), np.float32)
    onehot[CLASSES.index('tree')] = 1
    h, w = probs.shape[:2]
    for x, y, conf, r in crowns:
        mask = np.zeros((h, w), np.uint8)
        cv2.circle(mask, (int(round(x)), int(round(y))), max(1, int(round(r))), 1, -1)
        a = TREE_WEIGHT * conf
        out[mask > 0] = (1 - a) * out[mask > 0] + a * onehot
    return out


class Clip:
    name = 'clip'

    def __init__(self):
        import open_clip
        import torch
        self.torch = torch
        name = os.environ.get('ERFMAP_CLIP_MODEL', 'ViT-B-32')
        weights = os.environ.get('ERFMAP_CLIP_PRETRAINED', 'laion2b_s34b_b79k')
        self.label = 'CLIP %s (%s)' % (name, weights or 'untrained')
        try:
            self.model, _, self.preprocess = open_clip.create_model_and_transforms(name, pretrained=weights or None)
        except Exception as e:
            sys.exit('Could not load CLIP %s (%s). The first run needs internet to download the weights from Hugging Face. %s' % (name, weights, str(e)[-300:]))
        self.tokenizer = open_clip.get_tokenizer(name)
        self.model.eval()
        torch.set_grad_enabled(False)
        self.zone_text = self.embed([PROMPTS[c] for c in CLASSES])
        self.point_kinds = list(POINTS)
        self.point_text = torch.cat([self.embed([POINTS[k] for k in self.point_kinds]), self.zone_text])

    def embed(self, groups):
        out = []
        for phrases in groups:
            e = self.model.encode_text(self.tokenizer([t.format(p) for p in phrases for t in TEMPLATES]))
            e = (e / e.norm(dim=-1, keepdim=True)).mean(dim=0)
            out.append(e / e.norm())
        return self.torch.stack(out)

    def score(self, crops, text):
        rows = []
        for i in range(0, len(crops), 64):
            e = self.model.encode_image(self.torch.stack([self.preprocess(c) for c in crops[i:i + 64]]))
            e = e / e.norm(dim=-1, keepdim=True)
            rows.append((100.0 * e @ text.T).softmax(dim=-1))
        return self.torch.cat(rows).numpy() if rows else np.zeros((0, text.shape[0]))

    def zones(self, image):
        """Per-pixel class probabilities from a grid of overlapping windows."""
        W, H = image.size
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
        probs = self.score([image.crop((max(0, x - pad), max(0, y - pad), min(W, x + P + pad), min(H, y + P + pad))) for x, y in boxes], self.zone_text)
        acc = np.zeros((H, W, len(CLASSES)), np.float32)
        hits = np.zeros((H, W, 1), np.float32)
        for (x, y), p in zip(boxes, probs):
            acc[y:y + P, x:x + P] += p
            hits[y:y + P, x:x + P] += 1
        self.P = P
        return acc / np.maximum(hits, 1), np.ones((H, W), np.float32)

    def points(self, image):
        """Per-pixel lamp post and bench scores from a finer grid, kept only where they beat every surface."""
        W, H = image.size
        Q = max(24, self.P // 2)
        boxes = [(x, y) for y in range(0, H - Q + 1, Q) for x in range(0, W - Q + 1, Q)]
        probs = self.score([image.crop((x, y, x + Q, y + Q)) for x, y in boxes], self.point_text)
        out = {k: np.zeros((H, W), np.float32) for k in self.point_kinds}
        n = len(self.point_kinds)
        for (x, y), p in zip(boxes, probs):
            for o, k in enumerate(self.point_kinds):
                if p[o] >= POINT_MARGIN * float(p[n:].max()):
                    out[k][y:y + Q, x:x + Q] = p[o]
        return out, Q


class SegFormer:
    name = 'segformer'

    def __init__(self):
        import torch
        from transformers import AutoImageProcessor, AutoModelForSemanticSegmentation
        self.torch = torch
        name = os.environ.get('ERFMAP_SEGFORMER_MODEL', 'nvidia/segformer-b2-finetuned-ade-512-512')
        self.label = 'SegFormer ' + name
        self.processor = AutoImageProcessor.from_pretrained(name)
        self.model = AutoModelForSemanticSegmentation.from_pretrained(name).eval()
        id2label = self.model.config.id2label
        self.zone_ids = map_labels(id2label, SYNONYMS)
        self.point_ids = map_labels(id2label, POINT_SYNONYMS)
        if not any(self.zone_ids.values()):
            raise RuntimeError('none of its labels match building, road, path, grass or tree')

    def probabilities(self, image, tile=512):
        """Softmax over the model's own labels for every pixel, run in tiles to keep detail."""
        W, H = image.size
        out = None
        for y in range(0, H, tile):
            for x in range(0, W, tile):
                crop = image.crop((x, y, min(W, x + tile), min(H, y + tile)))
                inputs = self.processor(images=crop, return_tensors='pt')
                with self.torch.no_grad():
                    logits = self.model(**inputs).logits
                logits = self.torch.nn.functional.interpolate(logits, size=(crop.size[1], crop.size[0]), mode='bilinear', align_corners=False)
                p = logits.softmax(dim=1)[0].permute(1, 2, 0).numpy()
                if out is None:
                    out = np.zeros((H, W, p.shape[2]), np.float32)
                out[y:y + crop.size[1], x:x + crop.size[0]] = p
        return out

    def zones(self, image):
        self.raw = self.probabilities(image)
        mapped = np.stack([self.raw[:, :, ids].sum(axis=2) if ids else np.zeros(self.raw.shape[:2], np.float32) for ids in (self.zone_ids[c] for c in CLASSES)], axis=2)
        mass = mapped.sum(axis=2)
        return mapped / np.maximum(mass, 1e-6)[:, :, None], mass

    def points(self, image):
        H, W = self.raw.shape[:2]
        return {k: self.raw[:, :, ids].sum(axis=2) if ids else np.zeros((H, W), np.float32) for k, ids in self.point_ids.items()}


class DeepForest:
    name = 'deepforest'

    def __init__(self):
        from deepforest import main as df
        model = os.environ.get('ERFMAP_DEEPFOREST_MODEL', 'weecology/deepforest-tree')
        self.label = 'DeepForest ' + model
        self.model = df.deepforest()                      # 1.4+ loads the default tree model here
        if hasattr(self.model, 'load_model') and model != 'weecology/deepforest-tree':
            self.model.load_model(model_name=model)
        elif getattr(self.model, 'model', None) is None and hasattr(self.model, 'use_release'):
            self.model.use_release()                      # DeepForest before 1.4

    def crowns(self, path, f):
        """Tree crowns as (x, y, confidence, radius) in work pixels."""
        boxes = self.model.predict_tile(path=path, patch_size=400, patch_overlap=0.1)
        out = []
        if boxes is None:
            return out
        for row in boxes.itertuples():
            if float(row.score) < TREE_MIN:
                continue
            x, y = (row.xmin + row.xmax) / 2 * f, (row.ymin + row.ymax) / 2 * f
            r = max(row.xmax - row.xmin, row.ymax - row.ymin) / 2 * f
            out.append((float(x), float(y), round(float(row.score), 3), float(r)))
        return out


def council_points(image, members, f):
    """Lamp posts and benches: candidates from any member, confidence averaged over every member that can see them."""
    W, H = image.size
    maps, spacing = [], 24
    for m in members:
        if isinstance(m, Clip):
            scores, spacing = m.points(image)
        else:
            scores = m.points(image)
        maps.append((m.name, scores))
    found = []
    for kind in POINTS:
        layers = [(name, scores[kind]) for name, scores in maps if kind in scores]
        if not layers:
            continue
        r = max(2, spacing // 2)
        pooled = [cv2.dilate(v, np.ones((2 * r + 1, 2 * r + 1), np.uint8)) for _, v in layers]   # each member's best nearby
        mean = np.mean(pooled, axis=0)
        # One member must be sure; the average decides the confidence, so a lone vote is flagged for review.
        mask = (np.max(pooled, axis=0) >= POINT_MIN) & (mean >= POINT_MIN / 2)
        count, comp, stats, cent = cv2.connectedComponentsWithStats(mask.astype(np.uint8))
        for c in range(1, count):
            x, y = cent[c]
            xi, yi = int(round(x)), int(round(y))
            said = {name: round(float(p[yi, xi]), 3) for (name, _), p in zip(layers, pooled)}
            found.append((float(mean[yi, xi]), kind, x, y, said, spacing))
    kept = []
    for item in sorted(found, key=lambda q: -q[0]):                     # one point per neighbourhood
        if all(abs(item[2] - k[2]) >= item[5] or abs(item[3] - k[3]) >= item[5] for k in kept):
            kept.append(item)
    return kept


def load_members():
    members, notes = [], []
    for cls, env in ((Clip, 'ERFMAP_CLIP'), (SegFormer, 'ERFMAP_SEGFORMER'), (DeepForest, 'ERFMAP_DEEPFOREST')):
        if os.environ.get(env, '').lower() == 'off':
            notes.append('%s turned off' % cls.name)
            continue
        try:
            members.append(cls())
            print('Council member ready: %s' % members[-1].label, file=sys.stderr)
        except ImportError:
            notes.append('%s not installed' % cls.name)
        except SystemExit:
            raise
        except Exception as e:
            notes.append('%s could not load (%s)' % (cls.name, str(e)[-200:]))
            print('Council member %s skipped: %s' % (cls.name, e), file=sys.stderr)
    if not any(m.name in WEIGHTS for m in members):
        sys.exit('No zone model could load (%s). Install open_clip_torch or transformers.' % '; '.join(notes))
    return members, notes


def main():
    request = json.load(sys.stdin)
    from PIL import Image

    members, notes = load_members()
    regions = []
    for frame in request['frames']:
        original = Image.open(frame['image']).convert('RGB')
        W0, H0 = original.size
        f = WORK_SIDE / max(W0, H0)
        image = original.resize((max(1, round(W0 * f)), max(1, round(H0 * f))))
        W, H = image.size

        # Stage 1: every zone member votes per pixel; tree crowns from DeepForest pull towards "tree".
        votes, weighted = {}, {}
        for m in members:
            if m.name in WEIGHTS:
                probs, w = m.zones(image)
                votes[m.name] = probs
                weighted[m.name] = (probs, w * WEIGHTS[m.name])
        pixel = combine(weighted, (H, W))
        crowns = None
        for m in members:
            if isinstance(m, DeepForest):
                crowns = m.crowns(frame['image'], f)
                pixel = add_tree_crowns(pixel, crowns)
        work = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
        zones = build_zones(work, pixel, (W0, H0), trees=crowns, votes=votes if len(votes) > 1 else None)
        for r in zones:
            regions.append({'frame': frame['id'], **r})
        roofs = [np.array(r['polygon'], np.float32).reshape(-1, 1, 2) for r in zones if r.get('model_label') == 'building']

        # Stage 2: lamp posts and benches as points, anywhere but on a roof.
        for prob, kind, x, y, said, spacing in council_points(image, [m for m in members if m.name in WEIGHTS], f):
            if any(cv2.pointPolygonTest(roof, (x / f, y / f), False) >= 0 for roof in roofs):
                continue
            region = point_region(x / f, y / f, kind, prob, spacing / f)
            if len(said) > 1:
                region['votes'] = said
            regions.append({'frame': frame['id'], **region})
        print('Labelled %s: %d zones and points so far' % (frame['id'], len(regions)), file=sys.stderr)

    names = [m.label for m in members]
    json.dump({'model': {'name': 'Council: ' + ' + '.join(names), 'version': ', '.join(names),
                         'members': [m.name for m in members], 'left_out': notes,
                         'note': 'Zero-shot and general-purpose models voting per pixel; none is trained on this site. Confidence is the combined vote.'},
               'regions': regions}, sys.stdout)


if __name__ == '__main__':
    main()
