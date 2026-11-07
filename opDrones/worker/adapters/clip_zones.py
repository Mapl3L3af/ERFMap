#!/usr/bin/env python3
"""Two-pass zero-shot labelling with CLIP: zones first, then objects inside them.

Pass 1, zones: each photo is covered by a grid of overlapping square windows.
CLIP labels every window as grass, path, road, building or tree. Window scores
are averaged per grid cell, smoothed, and neighbouring cells with the same
label become one zone.

Pass 2, objects: a finer grid looks for lamp posts and benches inside the
zones. A window only becomes an object when CLIP is clearly more confident it
shows a lamp post or bench than the surface around it.

It is a general-purpose image model compared with text prompts, not a model
trained on drone surveys: every zone and object is a proposal for review.

    pip install open_clip_torch pillow
    # Used automatically by the worker when open_clip is installed.

Contract (same as ERFMAP_SEGMENTER, plus labels):
stdin  {"frames": [{"id": "f0001", "image": "/abs/path.jpg"}]}
stdout {"model": {...}, "regions": [{"frame", "polygon", "label", "confidence", "role": "zone"|"object"}]}
"""
import json
import os
import sys

ZONES = {
    'grass': ['grass', 'a lawn', 'mowed grass'],
    'path': ['a concrete sidewalk', 'a paved footpath', 'a walkway'],
    'road': ['an asphalt road', 'a parking lot', 'asphalt pavement'],
    'building': ['a building roof', 'a rooftop', 'a house roof'],
    'tree': ['a tree canopy', 'tree branches', 'a tree'],
}
# Most of a site is grass, path or road.
PRIOR = {'grass': 2.0, 'path': 2.0, 'road': 2.0}
OBJECTS = {
    'light': ['a lamp post', 'a street lamp'],
    'bench': ['a park bench', 'a wooden bench'],
}
TEMPLATES = ['an aerial photo of {}.', 'a top-down drone photo of {}.']
WORK_SIDE = 1024          # photos are analysed at this longest side
ZONE_CELLS = 14           # zone windows across the longest side
OBJECT_MIN = 0.6          # an object needs at least this probability ...
OBJECT_MARGIN = 2.0       # ... and this many times the best surface score
MIN_ZONE = 0.004          # zones smaller than this share of the photo are dropped


def main():
    request = json.load(sys.stdin)
    import cv2
    import numpy as np
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

    zone_kinds = list(ZONES)
    zone_text = embed_text([ZONES[k] for k in zone_kinds])
    zone_prior = torch.tensor([PRIOR.get(k, 1.0) for k in zone_kinds])
    object_kinds = list(OBJECTS)
    both_text = torch.cat([embed_text([OBJECTS[k] for k in object_kinds]), zone_text])

    def score(crops, text, prior=None):
        rows = []
        for i in range(0, len(crops), 64):
            e = model.encode_image(torch.stack([preprocess(c) for c in crops[i:i + 64]]))
            e = e / e.norm(dim=-1, keepdim=True)
            p = (100.0 * e @ text.T).softmax(dim=-1)
            if prior is not None:
                p = p * prior
                p = p / p.sum(dim=-1, keepdim=True)
            rows.append(p)
        return torch.cat(rows).numpy() if rows else np.zeros((0, text.shape[0]))

    regions = []
    for frame in request['frames']:
        original = Image.open(frame['image']).convert('RGB')
        W0, H0 = original.size
        f = WORK_SIDE / max(W0, H0)
        image = original.resize((max(1, round(W0 * f)), max(1, round(H0 * f))))
        W, H = image.size

        # ---- pass 1: zones
        P = max(32, max(W, H) // ZONE_CELLS)
        S = P // 2
        cols, rows = max(1, (W - P) // S + 1), max(1, (H - P) // S + 1)
        boxes, crops = [], []
        for r in range(rows):
            for c in range(cols):
                x, y = c * S, r * S
                pad = P // 4                                 # a little context around each window
                crops.append(image.crop((max(0, x - pad), max(0, y - pad), min(W, x + P + pad), min(H, y + P + pad))))
                boxes.append((r, c))
        probs = score(crops, zone_text, zone_prior)
        grid = np.zeros((rows + 1, cols + 1, len(zone_kinds)))
        hits = np.zeros((rows + 1, cols + 1, 1))
        for (r, c), p in zip(boxes, probs):                  # each window covers 2x2 cells of size S
            grid[r:r + 2, c:c + 2] += p
            hits[r:r + 2, c:c + 2] += 1
        grid = grid / np.maximum(hits, 1)
        smooth = np.stack([cv2.blur(grid[:, :, k].astype(np.float32), (3, 3)) for k in range(len(zone_kinds))], axis=2)
        labels = smooth.argmax(axis=2)
        conf = smooth.max(axis=2)
        full = cv2.resize(labels.astype(np.uint8), (W, H), interpolation=cv2.INTER_NEAREST)
        full_conf = cv2.resize(conf.astype(np.float32), (W, H), interpolation=cv2.INTER_LINEAR)
        kernel = np.ones((max(3, S // 2), max(3, S // 2)), np.uint8)
        for k, kind in enumerate(zone_kinds):
            mask = cv2.morphologyEx((full == k).astype(np.uint8) * 255, cv2.MORPH_OPEN, kernel)
            count, comp, stats, _ = cv2.connectedComponentsWithStats(mask)
            for n in range(1, count):
                if stats[n, cv2.CC_STAT_AREA] < MIN_ZONE * W * H:
                    continue
                piece = (comp == n).astype(np.uint8)
                contours, _ = cv2.findContours(piece, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                contour = max(contours, key=cv2.contourArea)
                approx = cv2.approxPolyDP(contour, 0.004 * cv2.arcLength(contour, True), True).reshape(-1, 2)
                if len(approx) < 3:
                    continue
                regions.append({'frame': frame['id'], 'polygon': (approx / f).round(1).tolist(), 'label': kind, 'role': 'zone',
                                'confidence': round(float(full_conf[piece > 0].mean()), 3)})

        # ---- pass 2: objects inside the zones
        Q = max(24, P // 2)
        surface = {zone_kinds.index(k) for k in ('grass', 'path', 'road')}
        boxes, crops = [], []
        for y in range(0, H - Q + 1, Q):
            for x in range(0, W - Q + 1, Q):
                if int(full[y + Q // 2, x + Q // 2]) not in surface:      # lamp posts and benches stand on grass, path or road
                    continue
                crops.append(image.crop((x, y, x + Q, y + Q)))
                boxes.append((x, y))
        probs = score(crops, both_text)
        found = []
        for (x, y), p in zip(boxes, probs):
            o = int(p[:len(object_kinds)].argmax())
            best_surface = float(p[len(object_kinds):].max())
            if p[o] >= OBJECT_MIN and p[o] >= OBJECT_MARGIN * best_surface:
                found.append((float(p[o]), object_kinds[o], x, y))
        kept = []
        for prob, kind, x, y in sorted(found, reverse=True):      # one object per neighbourhood
            if all(abs(x - kx) >= Q or abs(y - ky) >= Q for _, _, kx, ky in kept):
                kept.append((prob, kind, x, y))
        for prob, kind, x, y in kept:
            box = [[x, y], [x + Q, y], [x + Q, y + Q], [x, y + Q]]
            regions.append({'frame': frame['id'], 'polygon': [[round(a / f, 1), round(b / f, 1)] for a, b in box], 'label': kind, 'role': 'object',
                            'confidence': round(prob, 3)})
        print('Labelled %s: %d zones and objects so far' % (frame['id'], len(regions)), file=sys.stderr)

    json.dump({'model': {'name': 'CLIP zones + objects ' + name, 'version': weights or 'untrained',
                         'note': 'Zero-shot: a general-purpose image model compared with text prompts on a grid of windows; not trained on drone surveys.'},
               'regions': regions}, sys.stdout)


if __name__ == '__main__':
    main()
