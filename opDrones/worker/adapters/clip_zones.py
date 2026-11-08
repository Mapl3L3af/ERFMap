#!/usr/bin/env python3
"""Two-stage zero-shot labelling with CLIP: zone polygons, then point features.

Stage 1, zones. A grid of overlapping windows is scored by CLIP as building,
path, road or tree. Grass is assigned to the remaining ground after zone review. The scores are smoothed with an edge-aware filter so
zone edges follow visible edges in the photo, then zones are assigned in priority order:

  1. buildings are reserved first;
  2. paths and roads next (kept as separate classes), closed along their
     length so they stay continuous past small occlusions, and carried to the
     photo edge wherever they leave the frame;
  3. grass is the fallback for everything left, split wherever a path or road
     divides it, with holes kept around buildings and other zones.

Zones never overlap. Buildings are squared up to right angles, and paths become erfMap
"path" lines: a centre line of best-fit straight segments with the path's width.

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
    'tree': ['a tree canopy', 'tree branches', 'a tree'],
}
POINTS = {
    'light': ['a lamp post', 'a street lamp'],
    'bench': ['a park bench', 'a wooden bench'],
}
TEMPLATES = ['an aerial photo of {}.', 'a top-down drone photo of {}.']
ZONE_KIND = {'building': 'building', 'path': 'path', 'road': 'road', 'grass': 'grass'}
WORK_SIDE = 1024          # photos are analysed at this longest side
CELLS = 14                # CLIP windows across the longest side
PRIORITY = 0.8            # a higher-priority class wins when within this ratio of the best score
MIN_ZONE = 0.002          # building, path and road pieces smaller than this share of the photo go to grass
VEG_MIN, VEG_MAX = 0.02, 0.10   # limits for the per-photo greenness threshold
JOIN_REACH = 0.15         # path ends this far apart (share of the photo's long side) may be joined ...
JOIN_ANGLE = 35           # ... when each points at the other within this many degrees
T_REACH = 3               # an end pointing at the side of another path is carried up to this many path widths
FRAME_MIN = 0.05          # straight frame edges and framed roofs are at least this share of the photo's long side
FRAME_SUPPORT = 0.5       # share of a rectangle's outline that must lie on visible edges to count as framed
FRAME_LEAN = 0.4          # a framed area becomes a building when its building score is this share of the best
PAVED = 0.6               # on bare (not green) ground, building/path/road wins when within this ratio of the best score
POINT_MIN = 0.6           # a lamp post or bench needs at least this probability ...
POINT_MARGIN = 2.0        # ... and this many times the best surface score


# ---------------------------------------------------------------- geometry (no CLIP needed)
def guided_filter(guide, src, radius, eps=1e-3):
    """Edge-aware smoothing (He et al.): src is smoothed, but edges in guide (0-1 float, HxW) are kept."""
    box = lambda a: cv2.boxFilter(a, -1, (2 * radius + 1, 2 * radius + 1))
    mean_i = box(guide)
    var_i = box(guide * guide) - mean_i * mean_i
    out = np.empty_like(src)
    for k in range(src.shape[2]):
        p = src[:, :, k]
        mean_p = box(p)
        a = (box(guide * p) - mean_i * mean_p) / (var_i + eps)
        b = mean_p - a * mean_i
        out[:, :, k] = box(a) * guide + box(b)
    return out


def snap_to_edges(image, probs, radius):
    """Move class boundaries onto visible edges: blur away window corners, then filter guided by
    brightness and by the green-red colour axis (grass against paving and roofs)."""
    probs = cv2.GaussianBlur(probs.astype(np.float32), (0, 0), radius / 2)
    lab = cv2.cvtColor(cv2.bilateralFilter(image, 7, 30, 7), cv2.COLOR_BGR2LAB).astype(np.float32) / 255
    for channel in (0, 1, 0):
        probs = guided_filter(lab[:, :, channel], probs, radius)
    probs = np.clip(probs, 0, None)
    return probs / np.maximum(probs.sum(axis=2, keepdims=True), 1e-6)


def fit_to_colour(mask, lab, allowed, steps):
    """Let a zone flow along its own colour: within `steps` pixels of its edge, pixels that look like the
    zone join it (following curves and ends the coarse scores missed) and pixels that don't drop out."""
    if not mask.any():
        return mask
    colours = lab[mask]
    centre = np.median(colours, axis=0)
    spread = np.median(np.linalg.norm(colours - centre, axis=1))
    match = (np.linalg.norm(lab - centre, axis=2) <= max(3.0 * spread, 0.04)) & allowed
    kernel = np.ones((3, 3), np.uint8)
    core = cv2.erode(mask.astype(np.uint8), kernel, iterations=steps) > 0
    grown = (mask & match).astype(np.uint8)
    for _ in range(steps):                                   # grow only through matching pixels
        grown = cv2.dilate(grown, kernel) & match.astype(np.uint8)
    return core | (grown > 0)


def vegetation(image):
    """Green, living ground (grass, trees, bushes) by excess greenness, 2g - r - b in chromatic
    coordinates, split at a threshold chosen per photo (Otsu), kept within sensible limits."""
    f = cv2.bilateralFilter(image, 9, 40, 9).astype(np.float32) + 1
    b, g, r = f[:, :, 0], f[:, :, 1], f[:, :, 2]
    exg = (2 * g - r - b) / (b + g + r)
    e8 = np.clip((exg + 0.2) / 0.6 * 255, 0, 255).astype(np.uint8)
    t, _ = cv2.threshold(e8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    threshold = float(np.clip(t / 255 * 0.6 - 0.2, VEG_MIN, VEG_MAX))
    veg = (exg > threshold).astype(np.uint8)
    k = np.ones((5, 5), np.uint8)
    veg = cv2.morphologyEx(cv2.morphologyEx(veg, cv2.MORPH_OPEN, k), cv2.MORPH_CLOSE, k)
    return veg > 0


def crown_center(image, mask, x, y, radius):
    """Find the interior of the local crown, separating foliage from nearby lawn.

    Colour is measured near the proposal, so dark crowns need not share a global
    brightness threshold. Distance to the boundary keeps points off branches and
    crown edges; a proximity term prevents jumping to a neighbouring tree.
    """
    h, w = mask.shape
    radius = max(3, float(radius))
    x0, x1 = max(0, int(x-radius)), min(w, int(x+radius)+1)
    y0, y1 = max(0, int(y-radius)), min(h, int(y+radius)+1)
    if x0 >= x1 or y0 >= y1:
        return float(x), float(y)
    yy, xx = np.ogrid[y0:y1, x0:x1]
    distance = (xx-x)**2 + (yy-y)**2
    local = mask[y0:y1, x0:x1] & (distance <= radius**2)
    lab = cv2.cvtColor(image[y0:y1, x0:x1], cv2.COLOR_BGR2LAB).astype(np.float32)
    seed = local & (distance <= (radius*.3)**2)
    if seed.any():
        colour = np.median(lab[seed], axis=0)
        delta = np.linalg.norm(lab-colour, axis=2)
        similar = local & (delta <= max(15, float(np.percentile(delta[seed], 90))*2))
        if similar.sum() >= max(9, local.sum()*.15):
            local = similar
    depth = cv2.distanceTransform(np.pad(local.astype(np.uint8), 1), cv2.DIST_L2, 5)[1:-1, 1:-1]
    if not depth.any():
        return float(x), float(y)
    score = depth / (1 + distance / radius**2)
    cy, cx = np.unravel_index(np.argmax(score), score.shape)
    return float(x0+cx), float(y0+cy)


def visible_crowns(image, crowns, refine=True):
    """Require visible foliage within a detector crown; bare trunks are not trees."""
    foliage = vegetation(image)
    h, w = foliage.shape
    kept = []
    for x, y, confidence, radius in crowns:
        if not all(np.isfinite(v) for v in (x, y, confidence, radius)) or radius <= 0:
            continue
        x0, x1 = max(0, int(x - radius)), min(w, int(x + radius) + 1)
        y0, y1 = max(0, int(y - radius)), min(h, int(y + radius) + 1)
        if x1 <= x0 or y1 <= y0:
            continue
        yy, xx = np.ogrid[y0:y1, x0:x1]
        disk = (xx - x) ** 2 + (yy - y) ** 2 <= radius ** 2
        gray = cv2.cvtColor(image[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
        texture = float(gray[disk].std()) if disk.any() else 0
        if confidence >= TREE_MIN and disk.any() and foliage[y0:y1, x0:x1][disk].mean() >= 0.55 and texture >= 4:
            cx, cy = crown_center(image, foliage, x, y, radius) if refine else (x, y)
            kept.append((cx, cy, confidence, radius))
    return kept


def frame_edges(image, bare):
    """Long straight edges on bare (not green) ground: the frame most buildings have around the roof,
    plus kerbs and path sides. Returns (edge pixels, segments [x1, y1, x2, y2])."""
    h, w = image.shape[:2]
    gray = cv2.cvtColor(cv2.bilateralFilter(image, 9, 40, 9), cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 40, 120)
    edges[~(cv2.dilate(bare.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0)] = 0
    found = cv2.HoughLinesP(edges, 1, np.pi / 360, 40, minLineLength=int(FRAME_MIN * max(h, w)), maxLineGap=4)
    return edges > 0, (found.reshape(-1, 4).astype(np.float64) if found is not None else np.zeros((0, 4)))


def framed(piece, edges, size):
    """Does a bare area look like a framed roof: close to a rectangle, not thin like a path, and with
    most of its rectangle's outline lying on visible straight edges?"""
    h, w = size
    contours, _ = cv2.findContours(piece.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return False
    c = max(contours, key=cv2.contourArea)
    (cx, cy), (rw, rh), angle = cv2.minAreaRect(c)
    if min(rw, rh) < FRAME_MIN * max(h, w) or cv2.contourArea(c) < 0.75 * rw * rh:
        return False
    outline = np.zeros((h, w), np.uint8)
    cv2.polylines(outline, [np.round(cv2.boxPoints(((cx, cy), (rw, rh), angle))).astype(np.int32)], True, 1, 1)
    near_edge = cv2.dilate(edges.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    return near_edge[outline > 0].mean() >= FRAME_SUPPORT


def square_up(mask, segments=None):
    """A right-angled outline for one building: each side is a best-fit straight line through the
    traced edge, every side runs along or across the building's main direction, and neighbouring
    sides meet at 90 degrees. Where a straight frame edge runs along a side, the side is pinned to it.
    Returns work-pixel corners, or None when no good fit exists."""
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea).reshape(-1, 2).astype(np.float64)
    area = cv2.contourArea(contour.astype(np.float32))
    if len(contour) < 8 or area < 16:
        return None
    # Main direction: length-weighted average of edge angles, folded so that 0 and 90 degrees agree.
    step = np.roll(contour, -3, axis=0) - contour
    angle = np.arctan2(step[:, 1], step[:, 0])
    weight = np.hypot(step[:, 0], step[:, 1])
    theta = np.angle(np.sum(weight * np.exp(4j * angle))) / 4
    axes = [np.array([np.cos(theta), np.sin(theta)]), np.array([-np.sin(theta), np.cos(theta)])]
    # Corners of the traced outline split it into sides; each side takes the closer of the two directions.
    tol = max(2.0, 0.02 * cv2.arcLength(contour.astype(np.float32), True))
    corners = cv2.approxPolyDP(contour.astype(np.float32), tol, True).reshape(-1, 2)
    index = [int(np.argmin(np.hypot(*(contour - c).T))) for c in corners]
    order = np.argsort(index)
    index = [index[i] for i in order]
    sides = []
    for a, b in zip(index, index[1:] + [index[0] + len(contour)]):
        pts = contour[np.arange(a, b + 1) % len(contour)]
        d = pts[-1] - pts[0]
        if np.hypot(*d) < 1e-6:
            continue
        k = 0 if abs(np.dot(d, axes[0])) >= abs(np.dot(d, axes[1])) else 1
        if sides and sides[-1][0] == k:
            sides[-1][1].append(pts)                     # same direction as the last side: one longer side
        else:
            sides.append([k, [pts]])
    if len(sides) > 1 and sides[0][0] == sides[-1][0]:
        sides[0][1] += sides.pop()[1]
    if len(sides) < 4 or len(sides) % 2:
        return None
    lines = []
    snap = max(4.0, 0.02 * max(mask.shape))
    for k, parts in sides:
        pts = np.concatenate(parts)
        normal = axes[1 - k]
        offset = float(np.mean(pts @ normal))                 # best-fit offset of the side
        if segments is not None and len(segments):
            lo, hi = np.min(pts @ axes[k]), np.max(pts @ axes[k])
            best = None
            for x1, y1, x2, y2 in segments:                   # a frame edge along this side pins it
                d = np.array([x2 - x1, y2 - y1])
                n = np.hypot(*d)
                if n == 0 or abs(np.dot(d / n, axes[k])) < np.cos(np.radians(4)):
                    continue
                o = float(np.dot([(x1 + x2) / 2, (y1 + y2) / 2], normal))
                along = sorted([np.dot([x1, y1], axes[k]), np.dot([x2, y2], axes[k])])
                overlap = min(hi, along[1]) - max(lo, along[0])
                if abs(o - offset) <= snap and overlap > 0.3 * (hi - lo) and (best is None or overlap > best[0]):
                    best = (overlap, o)
            if best:
                offset = best[1]
        lines.append((axes[k], normal, offset))
    out = []
    for (d1, n1, c1), (d2, n2, c2) in zip(lines, lines[1:] + lines[:1]):
        A = np.array([n1, n2])
        out.append(np.linalg.solve(A, [c1, c2]))         # neighbouring sides are perpendicular, so they meet
    out = np.array(out)
    fitted = abs(cv2.contourArea(out.astype(np.float32)))
    if not 0.75 * area <= fitted <= 1.25 * area:
        rect = cv2.boxPoints(cv2.minAreaRect(contour.astype(np.float32)))
        return rect if 0.6 * area <= cv2.contourArea(rect) <= 1.4 * area else None
    return out


def thin(mask):
    """One-pixel-wide skeleton (Zhang-Suen thinning)."""
    img = np.pad(mask.astype(np.uint8), 1)
    while True:
        changed = False
        for step in (0, 1):
            p2, p3, p4 = img[:-2, 1:-1], img[:-2, 2:], img[1:-1, 2:]
            p5, p6, p7 = img[2:, 2:], img[2:, 1:-1], img[2:, :-2]
            p8, p9 = img[1:-1, :-2], img[:-2, :-2]
            ring = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
            b = sum(ring[:8])
            a = sum(((ring[i] == 0) & (ring[i + 1] == 1)).astype(np.uint8) for i in range(8))
            c = (p2 * p4 * p6 == 0) if step == 0 else (p2 * p4 * p8 == 0)
            d = (p4 * p6 * p8 == 0) if step == 0 else (p2 * p6 * p8 == 0)
            drop = (img[1:-1, 1:-1] == 1) & (b >= 2) & (b <= 6) & (a == 1) & c & d
            if drop.any():
                img[1:-1, 1:-1][drop] = 0
                changed = True
        if not changed:
            return img[1:-1, 1:-1] > 0


RING = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]   # clockwise from north


def trace(skeleton):
    """Split a skeleton into chains of pixels running between ends and junctions.

    Ends and junctions are found by counting how many separate branches touch a pixel
    (the crossing number), so staircase steps in diagonal lines are not mistaken for junctions."""
    ys, xs = np.nonzero(skeleton)
    on = set(zip(ys.tolist(), xs.tolist()))
    near = lambda q: [(q[0] + dy, q[1] + dx) for dy, dx in RING if (q[0] + dy, q[1] + dx) in on]

    def branches(q):
        ring = [(q[0] + dy, q[1] + dx) in on for dy, dx in RING]
        return sum(1 for i in range(8) if not ring[i] and ring[(i + 1) % 8])

    nodes = {q for q in on if branches(q) != 2}
    visited, chains = set(), []

    def walk(start, first):
        chain, prev, cur = [start, first], start, first
        while cur not in nodes:
            visited.add(cur)
            ahead = [q for q in near(cur) if q != prev and q not in visited and q not in chain[-3:]]
            if not ahead:
                break
            ahead.sort(key=lambda q: (q not in nodes, abs(q[0] - cur[0]) + abs(q[1] - cur[1])))   # junctions first, then straight steps
            prev, cur = cur, ahead[0]
            chain.append(cur)
        return np.array([[x, y] for y, x in chain], np.float64)

    for start in sorted(nodes):
        for first in near(start):
            if first not in visited and first not in nodes:
                chains.append(walk(start, first))
    for q in sorted(on - visited - nodes):                     # closed loops with no end or junction
        if q not in visited:
            visited.add(q)
            chains.append(walk(q, near(q)[0])) if near(q) else None
    return chains


def fit_polyline(points, tol):
    """Straight segments through a chain of centre-line pixels: break points from Douglas-Peucker,
    then each segment is a least-squares line and neighbouring lines meet where they cross."""
    if len(points) < 2:
        return None
    breaks = cv2.approxPolyDP(points.astype(np.float32).reshape(-1, 1, 2), tol, False).reshape(-1, 2)
    index = sorted({int(np.argmin(np.hypot(*(points - b).T))) for b in breaks} | {0, len(points) - 1})
    lines = []
    for a, b in zip(index, index[1:]):
        seg = points[a:b + 1]
        vx, vy, x0, y0 = cv2.fitLine(seg.astype(np.float32), cv2.DIST_L2, 0, 0.01, 0.01).ravel()
        lines.append((np.array([x0, y0], float), np.array([vx, vy], float)))
    project = lambda q, line: line[0] + np.dot(q - line[0], line[1]) * line[1]
    out = [project(points[0], lines[0])]
    for (p1, d1), (p2, d2) in zip(lines, lines[1:]):
        A = np.array([d1, -d2]).T
        if abs(np.linalg.det(A)) < 0.05:                     # nearly straight on: keep the shared break point
            out.append((project(points[index[len(out)]], (p1, d1)) + project(points[index[len(out)]], (p2, d2))) / 2)
        else:
            t = np.linalg.solve(A, p2 - p1)
            out.append(p1 + t[0] * d1)
    out.append(project(points[-1], lines[-1]))
    return np.array(out)


def join_chains(chains):
    """Once spurs are gone, a junction with only two chains left is just a bend: join them into one line."""
    chains = [c for c in chains]
    key = lambda q: (int(round(q[0])), int(round(q[1])))
    while True:
        ends = {}
        for i, c in enumerate(chains):
            for side in (0, -1):
                ends.setdefault(key(c[side]), []).append((i, side))
        pair = next((v for v in ends.values() if len(v) == 2 and v[0][0] != v[1][0]), None)
        if pair is None:
            return chains
        (i, si), (j, sj) = pair
        a = chains[i] if si == -1 else chains[i][::-1]          # a ends at the shared point
        b = chains[j] if sj == 0 else chains[j][::-1]           # b starts there
        chains = [c for k, c in enumerate(chains) if k not in (i, j)] + [np.concatenate([a, b[1:]])]


def centre_lines(piece, frame_size):
    """Centre lines of one path or road area as straight-segment polylines, with its average width.
    Short spurs from ragged edges are dropped; lines that reach the photo edge are carried to it."""
    h, w = frame_size
    dist = cv2.distanceTransform(np.pad(piece.astype(np.uint8), 1), cv2.DIST_L2, 5)[1:-1, 1:-1]
    skeleton = thin(piece)
    if not skeleton.any():
        return [], 0.0
    width = float(2 * np.median(dist[skeleton]))
    chains = [c for c in trace(skeleton) if len(c) >= 2]
    longest = max((len(c) for c in chains), default=0)
    chains = [c for c in chains if len(c) >= max(3, 1.5 * width) or len(c) == longest]   # drop spurs from ragged edges
    chains = join_chains(chains)
    out = []
    for chain in chains:
        line = fit_polyline(chain, max(2.0, width / 2))
        if line is None:
            continue
        for end in (0, -1):
            q = line[end]
            candidates = [(q[0] / w, 0, 0), ((w - 1 - q[0]) / w, 0, w - 1),
                          (q[1] / h, 1, 0), ((h - 1 - q[1]) / h, 1, h - 1)]
            distance, axis, edge = min(candidates)
            if distance <= 0.05:
                line[end, axis] = edge
        out.append(line)
    return out, width


def smooth_mask(mask, size):
    """Round off jagged mask edges without moving them."""
    m = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), size)
    return m >= 0.5


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


def shadow_mask(image):
    """Candidate shade from local luminance contrast; dark roofs/asphalt can also trigger it."""
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    light = lab[:, :, 0]
    surround = cv2.GaussianBlur(light, (0, 0), max(3, max(light.shape) / 35))
    return (light < 0.72 * np.maximum(surround, 1)) & (light < np.percentile(light, 45))


def build_zones(image, probs, size, trees=None, votes=None, locked_buildings=None, forced_masks=None, occlusion_mask=None):
    """Zones and tree points from per-pixel class probabilities.

    image: work-size BGR image. probs: HxWxC in CLASSES order (the council's combined vote).
    size: (w, h) of the original photo. trees: optional [(x, y, confidence, radius)] in work pixels
    from a tree detector, used instead of finding crowns in probs. votes: optional
    {member: HxWxC probs}, reported per zone so a reviewer can see who agreed.
    Returns regions in original-photo pixels."""
    h, w = image.shape[:2]
    scale = w / size[0]
    block = max(16, max(h, w) // 10)
    probs = snap_to_edges(image, probs, max(4, block // 6))
    b, pth, rd, gr, tr = (probs[:, :, CLASSES.index(c)] for c in CLASSES)
    best = probs.max(axis=2)
    canopy = (tr >= PRIORITY * best) & vegetation(image)
    if trees is not None:
        trees = visible_crowns(image, trees)
        # Crown detections also explain gaps in paths, even when pixel votes disagree.
        for x, y, confidence, radius in trees:
            crown_mask = np.zeros((h, w), np.uint8)
            cv2.circle(crown_mask, (round(x), round(y)), max(1, round(radius)), 1, -1)
            canopy |= crown_mask > 0
    shadows = shadow_mask(image)
    occluded = canopy | shadows
    if occlusion_mask is not None:
        occluded |= occlusion_mask
    # Green pixels are grass or trees, whatever the coarse scores say: paving and roofs are never green.
    # On bare ground the models choose between building, path and road, and are trusted more readily.
    bare = ~vegetation(image)
    building = bare & (b >= PAVED * best)
    # Roofs usually have a frame: a bare, rectangular area whose outline sits on straight edges is
    # taken as a building even when the scores only lean that way.
    edges, segments = frame_edges(image, bare)
    count, comp = cv2.connectedComponents((bare & ~building).astype(np.uint8))
    for c in range(1, count):
        piece = comp == c
        if piece.sum() >= 4 * MIN_ZONE * h * w and b[piece].mean() >= FRAME_LEAN * best[piece].mean() and framed(piece, edges, (h, w)):
            building |= piece
    # Visible paving remains eligible even if coarse tree scores dominate nearby.
    # Canopy gaps are handled separately by the path continuity checks.
    line = bare & ~building & (np.maximum(pth, rd) >= PAVED * best)
    path = line & (pth >= rd)
    road = line & (rd > pth)

    k = max(3, block // 4) | 1
    small = np.ones((k, k), np.uint8)
    building = cv2.morphologyEx(building.astype(np.uint8), cv2.MORPH_OPEN, small) > 0
    building = cv2.morphologyEx(building.astype(np.uint8), cv2.MORPH_CLOSE, small) > 0
    # Paths and roads are long and continuous: close small gaps along them, but never over a building.
    reach = np.ones((2 * k + 1, 2 * k + 1), np.uint8)
    path = (cv2.morphologyEx(path.astype(np.uint8), cv2.MORPH_CLOSE, reach) > 0) & ~building & bare
    road = (cv2.morphologyEx(road.astype(np.uint8), cv2.MORPH_CLOSE, reach) > 0) & ~building & bare
    building &= bare
    lab = cv2.cvtColor(cv2.bilateralFilter(image, 7, 30, 7), cv2.COLOR_BGR2LAB).astype(np.float32) / 255
    building = fit_to_colour(building, lab, bare, k)
    path = fit_to_colour(path, lab, bare & ~building & (pth >= rd), 2 * k)   # paths and roads may run on to their visible end,
                                                                      # but a path never flows into road-like ground
    road = fit_to_colour(road, lab, bare & ~building & ~path, 2 * k)
    soft = max(1.0, k / 6)
    building = smooth_mask(building, soft) & bare
    path = smooth_mask(path, soft) & ~building & bare
    road = smooth_mask(road, soft) & ~building & ~path & bare
    both = path & road
    path &= ~(both & (probs[:, :, 2] > probs[:, :, 1]))
    road &= ~path

    def drop_small(mask):
        count, comp, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8))
        keep = np.zeros(count, bool)
        keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= MIN_ZONE * h * w
        return keep[comp]

    building, path, road = drop_small(building), drop_small(path), drop_small(road)
    for kind, mask in (forced_masks or []):
        if kind in ('grass', 'path', 'tree'):
            building &= ~mask
            road &= ~mask
            path &= ~mask
        if kind == 'building':
            building |= mask
        elif kind == 'path':
            path |= mask
    # Buildings are right-angled: replace each traced outline with straight, square-cornered sides.
    squared = []
    count, comp = cv2.connectedComponents(building.astype(np.uint8))
    building = np.zeros((h, w), bool)
    for c in range(1, count):
        piece = comp == c
        corners = square_up(piece, segments)
        if corners is None:
            building |= piece
            continue
        filled = np.zeros((h, w), np.uint8)
        cv2.fillPoly(filled, [np.round(corners).astype(np.int32)], 1)
        building |= filled > 0
        squared.append((filled > 0, corners))
    if locked_buildings is not None:
        building |= locked_buildings.astype(bool)
        squared = []
    path &= ~building
    road &= ~building
    path_shapes, path = path_lines(path, building, scale, size, max(1.0, 0.002 * max(h, w)), occluded, image)
    road &= ~path
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
            exact = next((corners for m, corners in squared if label == 'building' and (m & piece).sum() > 0.9 * piece.sum()), None)
            shapes = [{'polygon': [[round(float(x) / scale, 1), round(float(y) / scale, 1)] for x, y in exact]}] if exact is not None else polygons(piece, scale, size, tol)
            if label == 'path' and path_shapes:
                continue                                       # paths are added as lines below
            for p in shapes:
                region = {'polygon': p['polygon'], 'label': ZONE_KIND[label], 'model_label': label, 'role': 'zone', 'confidence': round(conf, 3)}
                if 'line' in p:
                    region['line'], region['width'] = p['line'], p['width']
                if said:
                    region['votes'] = said
                regions.append(region)

    k_path = CLASSES.index('path')
    for p in path_shapes:
        part = p.pop('part')
        region = {'polygon': p['polygon'], 'label': ZONE_KIND['path'], 'model_label': 'path', 'role': 'zone',
                  'confidence': round(float(probs[:, :, k_path][part].mean()), 3), 'line': p['line'], 'width': p['width']}
        said = {m: round(float(v[:, :, k_path][part].mean()), 3) for m, v in (votes or {}).items()}
        if said:
            region['votes'] = said
        regions.append(region)

    if trees:                             # usable detector crowns take precedence
        for x, y, conf, r in trees:
            regions.append(point_region(x / scale, y / scale, 'tree', conf, 2 * r / scale))
        return regions
    # Trees: one point per crown, wherever trees dominate (usually over grass).
    tree = (tr >= 0.5) & (tr >= 1.5 * np.maximum.reduce([b, pth, rd, gr])) & ~bare
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
        patch = cv2.cvtColor(image[max(0, y-crown//2):y+crown//2+1, max(0, x-crown//2):x+crown//2+1], cv2.COLOR_BGR2GRAY)
        if patch.std() < 4:  # Uniform lawn is not a crown, even when coarse semantics say tree.
            continue
        cx, cy = crown_center(image, tree > 0, x, y, max(crown, float(dist[y, x])*1.5))
        if any(np.hypot(cx / scale-r['point'][0], cy / scale-r['point'][1]) < crown / scale
               for r in regions if r.get('label') == 'tree'):
            continue
        regions.append(point_region(cx / scale, cy / scale, 'tree', float(probs[round(cy), round(cx), CLASSES.index('tree')]), 2 * float(dist[y, x]) / scale))
    return regions


def ends_of(line):
    """Both ends of a polyline with the outward direction at each."""
    out = []
    for end, inner in ((0, 1), (-1, -2)):
        d = line[end] - line[inner]
        n = np.hypot(*d)
        if n > 1e-6:
            out.append((end, line[end], d / n))
    return out


def connect_paths(lines, widths, blocked, frame_size, occluded=None, colours=None):
    """Paths rarely just stop: shade, a tree or a coarse score often breaks one path in two.
    Ends that point at each other are joined into one line (greedily, closest first), and an end
    that points at the side of another path is carried on to meet it. Gaps never cross a building.
    Returns the lines, their widths and the bridging strokes [(a, b, width)]."""
    h, w = frame_size
    reach = JOIN_REACH * max(h, w)
    at_edge = lambda q: q[0] <= 2 or q[1] <= 2 or q[0] >= w - 3 or q[1] >= h - 3
    lines, widths = [l.copy() for l in lines], list(widths)
    colours = [np.asarray(c, float) for c in colours] if colours is not None else None
    def compatible(i, j):
        if colours is None:
            return True
        delta = colours[i] - colours[j]
        return np.linalg.norm(delta[1:]) <= 30 and abs(delta[0]) <= 70

    def clear(a, b, width):
        stroke = np.zeros((h, w), np.uint8)
        cv2.line(stroke, tuple(int(v) for v in np.round(a)), tuple(int(v) for v in np.round(b)), 1, max(1, int(width)))
        return (blocked[stroke > 0]).mean() < 0.1 if stroke.any() else True

    def facing(u, gap):
        n = np.hypot(*gap)
        return n > 0 and np.dot(u, gap / n) >= np.cos(np.radians(JOIN_ANGLE))

    bridges, refused = [], set()
    while True:                                             # 1. end to end
        best = None
        for i in range(len(lines)):
            for j in range(i + 1, len(lines)):
                for ei, qi, ui in ends_of(lines[i]):
                    for ej, qj, uj in ends_of(lines[j]):
                        if at_edge(qi) or at_edge(qj):
                            continue
                        gap = qj - qi
                        d = np.hypot(*gap)
                        permitted = reach
                        if occluded is not None and d <= 2 * reach:
                            stroke = np.zeros((h, w), np.uint8)
                            cv2.line(stroke, tuple(np.round(qi).astype(int)), tuple(np.round(qj).astype(int)), 1, max(1, round(min(widths[i], widths[j]))))
                            if stroke.any() and occluded[stroke > 0].mean() >= 0.5:
                                permitted = 2 * reach
                        if (d <= permitted and compatible(i, j) and max(widths[i], widths[j]) <= 2.5 * max(1, min(widths[i], widths[j])) and facing(ui, gap) and facing(uj, -gap) and (best is None or d < best[0])
                                and (tuple(np.round(qi)), tuple(np.round(qj))) not in refused):
                            best = (d, i, ei, j, ej)
        if best is None:
            break
        d, i, ei, j, ej = best
        a = lines[i] if ei == -1 else lines[i][::-1]          # a ends where the gap starts
        b = lines[j] if ej == 0 else lines[j][::-1]           # b starts where it ends
        width = (widths[i] + widths[j]) / 2
        if not clear(a[-1], b[0], width):
            refused.add((tuple(np.round(lines[i][ei])), tuple(np.round(lines[j][ej]))))
            continue
        bridges.append((a[-1].copy(), b[0].copy(), width))
        joined, wj = np.concatenate([a, b]), width
        if colours is not None:
            colour = (colours[i] + colours[j]) / 2
            colours = [c for k, c in enumerate(colours) if k not in (i, j)] + [colour]
        lines = [l for k, l in enumerate(lines) if k not in (i, j)] + [joined]
        widths = [x for k, x in enumerate(widths) if k not in (i, j)] + [wj]
    for i, line in enumerate(lines):                          # 2. end to the side of another path
        for end, q, u in ends_of(line):
            if at_edge(q):
                continue
            hit = None
            for j, other in enumerate(lines):
                if j == i or not compatible(i, j):
                    continue
                for p1, p2 in zip(other[:-1], other[1:]):
                    A = np.array([u, p1 - p2]).T
                    if abs(np.linalg.det(A)) < 1e-6:
                        continue
                    t, s_ = np.linalg.solve(A, p1 - q)
                    if 0 < t <= min(reach, T_REACH * widths[i]) and 0 <= s_ <= 1 and (hit is None or t < hit[0]):
                        hit = (t, q + t * u)
            if hit and hit[0] > 1 and clear(q, hit[1], widths[i]):
                bridges.append((q.copy(), hit[1], widths[i]))
                line[end] = hit[1]
    return lines, widths, bridges


def path_lines(path, blocked, scale, size, tol, occluded=None, image=None):
    """Every path in a photo as centre-line segments, with breaks joined (see connect_paths).
    Each line gets the part of the path area closest to it, so pieces never overlap.
    Returns the shapes and the path area including the filled gaps."""
    h, w = path.shape
    lines, widths = [], []
    colours = [] if image is not None else None
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB) if image is not None else None
    count, comp = cv2.connectedComponents(path.astype(np.uint8))
    for c in range(1, count):
        found, width = centre_lines(comp == c, (h, w))
        lines += found
        widths += [width] * len(found)
        if colours is not None:
            colours += [np.median(lab[comp == c], axis=0)] * len(found)
    if not lines:
        return [], path
    lines, widths, bridges = connect_paths(lines, widths, blocked, (h, w), occluded, colours)
    path = path.copy()
    for a, b, width in bridges:
        stroke = np.zeros((h, w), np.uint8)
        cv2.line(stroke, tuple(int(v) for v in np.round(a)), tuple(int(v) for v in np.round(b)), 1, max(1, int(round(width))))
        path |= (stroke > 0) & ~blocked
    near = []
    for line in lines:
        drawn = np.full((h, w), 255, np.uint8)
        cv2.polylines(drawn, [np.round(line).astype(np.int32)], False, 0, 1)
        near.append(cv2.distanceTransform(drawn, cv2.DIST_L2, 3))
    owner = np.argmin(np.stack(near), axis=0)
    w0, h0 = size
    snap = lambda v, top: 0.0 if v <= 1.5 else float(top) if v >= top - 1.5 else round(float(v), 1)
    out = []
    for i, line in enumerate(lines):
        part = path & (owner == i)
        for p in sorted(polygons(part, scale, size, tol), key=lambda p: -p['area'])[:1]:
            out.append({'polygon': p['polygon'], 'width': round(widths[i] / scale, 1), 'part': part,
                        'line': [[snap(x / scale, w0), snap(y / scale, h0)] for x, y in line]})
    return out, path


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
WEIGHTS = {'clip': 1.0, 'segformer': 1.0, 'sam3': 2.0}
TREE_WEIGHT = 0.6         # how strongly a DeepForest crown pulls its pixels towards "tree"
TREE_MIN = 0.65            # DeepForest boxes below this score are ignored
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
        self.zone_classes = [c for c in CLASSES if c != 'grass']
        self.zone_text = self.embed([PROMPTS[c] for c in self.zone_classes])
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
        classified = probs
        probs = np.zeros((len(boxes), len(CLASSES)), np.float32)
        for i, kind in enumerate(self.zone_classes):
            probs[:, CLASSES.index(kind)] = classified[:, i]
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
        mapped[:, :, CLASSES.index('grass')] = 0
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


class Sam3:
    """Optional concept segmentation, including site-specific box exemplars."""
    name = 'sam3'

    def __init__(self):
        import torch
        from transformers import Sam3Model, Sam3Processor
        self.torch = torch
        name = os.environ.get('ERFMAP_SAM3_MODEL', 'facebook/sam3')
        self.model = Sam3Model.from_pretrained(name)
        device = 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'
        self.model.to(device).eval()
        self.processor = Sam3Processor.from_pretrained(name)
        self.label = 'SAM 3 ' + name
        self.guidance = []

    def predict(self, image, kind):
        boxes = []
        for mark in self.guidance:
            if mark['kind'] != kind or not mark.get('outline'):
                continue
            pts = np.asarray(mark['outline'], float)
            boxes.append([*pts.min(axis=0), *pts.max(axis=0)])
        args = {'images': image, 'text': {'building': 'building roof', 'path': 'footpath', 'road': 'road', 'tree': 'tree canopy', 'bench': 'park bench', 'light': 'lamp post'}[kind], 'return_tensors': 'pt'}
        if boxes:
            args.update(input_boxes=[boxes], input_boxes_labels=[[1] * len(boxes)])
        inputs = self.processor(**args).to(self.model.device)
        with self.torch.no_grad():
            outputs = self.model(**inputs)
        result = self.processor.post_process_instance_segmentation(outputs, threshold=.65 if kind == 'tree' else .5, mask_threshold=.5, target_sizes=inputs['original_sizes'].tolist())[0]
        return result['masks'].detach().cpu().numpy(), result['scores'].detach().cpu().numpy()

    def zones(self, image):
        W, H = image.size
        out = np.zeros((H, W, len(CLASSES)), np.float32)
        out[:, :, CLASSES.index('grass')] = .15
        for kind in ('building', 'path', 'road', 'tree'):
            masks, scores = self.predict(image, kind)
            for mask, score in zip(masks, scores):
                out[:, :, CLASSES.index(kind)] = np.maximum(out[:, :, CLASSES.index(kind)], mask * score)
        return out / np.maximum(out.sum(axis=2, keepdims=True), 1e-6), np.ones((H, W), np.float32)

    def points(self, image):
        W, H = image.size
        out = {k: np.zeros((H, W), np.float32) for k in POINTS}
        for kind in POINTS:
            masks, scores = self.predict(image, kind)
            for mask, score in zip(masks, scores):
                out[kind] = np.maximum(out[kind], mask * score)
        return out


def apply_guidance(pixel, marks, factor):
    """A rough sketch biases evidence locally; it never forces the resulting boundary."""
    out = pixel.copy()
    h, w = pixel.shape[:2]
    for mark in marks:
        kind = mark['kind']
        if kind not in CLASSES:
            continue
        mask = np.zeros((h, w), np.uint8)
        points = np.round(np.asarray(mark.get('outline') or mark.get('stroke') or [mark['p']]) * factor).astype(np.int32)
        radius = max(3, round(mark.get('radius', 12) * factor))
        if mark.get('outline'):
            cv2.fillPoly(mask, [points], 1)
        elif len(points) > 1:
            cv2.polylines(mask, [points], False, 1, 2 * radius)
        else:
            cv2.circle(mask, tuple(points[0]), radius, 1, -1)
        influence = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), max(2, radius / 2))
        k = CLASSES.index(kind)
        # Only amplify existing model evidence. A contradicted sketch cannot invent a roof/path.
        out[:, :, k] *= 1 + 1.5 * influence
    return out / np.maximum(out.sum(axis=2, keepdims=True), 1e-6)


def load_members():
    members, notes = [], []
    for cls, env in ((Sam3, 'ERFMAP_SAM3'), (Clip, 'ERFMAP_CLIP'), (SegFormer, 'ERFMAP_SEGFORMER'), (DeepForest, 'ERFMAP_DEEPFOREST')):
        if (cls is Sam3 and os.environ.get(env, '').lower() != 'on') or os.environ.get(env, '').lower() == 'off':
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
                if isinstance(m, Sam3):
                    m.guidance = [{**g, 'outline': (np.asarray(g['outline']) * f).tolist()} if g.get('outline') else g for g in request.get('guidance', [])]
                probs, w = m.zones(image)
                votes[m.name] = probs
                weighted[m.name] = (probs, w * WEIGHTS[m.name])
        pixel = apply_guidance(combine(weighted, (H, W)), request.get('guidance', []), f)
        crowns = None
        for m in members:
            if isinstance(m, DeepForest):
                crowns = visible_crowns(cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR),
                                        m.crowns(frame['image'], f), refine=False)
                pixel = add_tree_crowns(pixel, crowns)
        work = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
        locked = np.zeros((H, W), np.uint8)
        for polygon in request.get('locked_buildings', []):
            cv2.fillPoly(locked, [np.round(np.asarray(polygon) * f).astype(np.int32)], 1)
        shade = np.zeros((H, W), np.uint8)
        for mark in request.get('guidance', []):
            if mark['kind'] != 'shadow':
                continue
            pts = np.round(np.asarray(mark.get('stroke') or [mark['p']]) * f).astype(np.int32)
            radius = max(3, round(mark.get('radius', 12) * f))
            cv2.polylines(shade, [pts], False, 1, radius * 2)
            for pt in pts:
                cv2.circle(shade, tuple(pt), radius, 1, -1)
        zones = build_zones(work, pixel, (W0, H0), trees=crowns, votes=votes if len(votes) > 1 else None, locked_buildings=locked, occlusion_mask=shade > 0)
        for r in zones:
            regions.append({'frame': frame['id'], **r})
        roofs = [np.array(r['polygon'], np.float32).reshape(-1, 1, 2) for r in zones if r.get('model_label') == 'building']

        if request.get('phase') == 'zones':
            continue
        if request.get('phase') == 'points':
            regions = [r for r in regions if r.get('role') == 'point']
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
