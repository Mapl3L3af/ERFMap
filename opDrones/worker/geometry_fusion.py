"""Geometry-aware relabelling of proposed map features.

Imagery alone confuses flat roofs with paving, lawns with tree crowns, and
roads with car parks. When a reconstruction is available, simple 3D cues
separate them well:

* height above ground (HAG): buildings and tree crowns stand up, ground does not
* slope: ground and flat roofs are gentle; walls and crown edges are steep
* surface shape (roughness): roofs and paving are planar, crowns are bumpy

Input contract (written by a reconstruction step such as OpenDroneMap; nothing
in erfMap produces it yet):

    <job>/reconstruction/height.npy   float32 surface heights in metres (DSM),
                                       one value per geometry-mosaic pixel,
                                       NaN where nothing was reconstructed
    <job>/reconstruction/meta.json    optional {"ground": "ground.npy",
                                       "vertical_error_m": 0.3}
    <job>/reconstruction/ground.npy   optional terrain heights (DTM) on the
                                       same grid; estimated from the DSM when
                                       missing

The raster may be a different size from the mosaic; it is resampled to it.
Every decision falls back to the imagery label when the geometry is missing,
too sparse inside a feature, or too noisy to trust. The report says which.
"""
import json
import math
from pathlib import Path

import cv2
import numpy as np

# Classes the geometry can speak to. Everything else keeps its imagery label.
ELEVATED = {'building', 'tree', 'canopy'}
GROUND = {'grass', 'path', 'road', 'pavement', 'soil', 'water', 'shrub'}

MIN_VALID = 0.6          # share of a feature's pixels that need a height
BUILDING_HAG = 2.0       # metres: anything standing this high is not ground
TREE_HAG = 1.5
GROUND_HAG = 0.6
ROUGH_CROWN = 0.35       # metres RMS from a local plane: crowns are bumpy
ROUGH_PLANAR = 0.15      # roofs and paving are flat at this scale
STEEP_DEG = 25.0         # ground steeper than this is flagged as terrain, not paving


def load(job, shape, m_per_px=None):
    """Return (dsm, dtm, meta, reason). dsm/dtm are None when unavailable."""
    root = Path(job) / 'reconstruction'
    path = root / 'height.npy'
    if not path.exists():
        return None, None, {}, 'No reconstruction (reconstruction/height.npy) for this job; labels come from imagery only.'
    meta = {}
    if (root / 'meta.json').exists():
        try:
            meta = json.loads((root / 'meta.json').read_text())
        except ValueError:
            return None, None, {}, 'reconstruction/meta.json is not valid JSON; labels come from imagery only.'
    try:
        dsm = np.load(path).astype(np.float32)
    except Exception as error:   # corrupt or wrong type: fall back, never fail the stage
        return None, None, meta, 'Could not read the height raster (%s); labels come from imagery only.' % error
    if dsm.ndim != 2 or min(dsm.shape) < 8:
        return None, None, meta, 'The height raster is not a 2D grid; labels come from imagery only.'
    dsm = resample(dsm, shape)
    dtm = None
    if meta.get('ground') and (root / meta['ground']).exists():
        try:
            dtm = resample(np.load(root / meta['ground']).astype(np.float32), shape)
        except Exception:
            dtm = None
    if dtm is None:
        dtm = estimate_ground(dsm, m_per_px or meta.get('m_per_px'))
    return dsm, dtm, meta, None


def resample(raster, shape):
    h, w = shape
    if raster.shape == (h, w):
        return raster
    valid = np.isfinite(raster).astype(np.float32)
    filled = np.where(np.isfinite(raster), raster, 0).astype(np.float32)
    a = cv2.resize(filled, (w, h), interpolation=cv2.INTER_LINEAR)
    b = cv2.resize(valid, (w, h), interpolation=cv2.INTER_LINEAR)
    out = np.where(b > .5, a / np.maximum(b, 1e-6), np.nan).astype(np.float32)
    return out


GROUND_WINDOW_M = 30.0   # wider than most buildings, so roofs drop to the ground around them


def estimate_ground(dsm, m_per_px=None, window_px=None):
    """A crude DTM: a large grey opening (min then max filter) removes objects
    narrower than the window, so roofs and crowns drop to the surrounding ground.
    Buildings wider than the window are missed; supply ground.npy for those."""
    h, w = dsm.shape
    if window_px is None:
        window_px = GROUND_WINDOW_M / m_per_px if m_per_px else min(h, w) / 6
    k = max(9, int(round(min(window_px, min(h, w) / 2))) | 1)
    fill = np.nanmax(dsm) if np.isfinite(dsm).any() else 0
    src = np.where(np.isfinite(dsm), dsm, fill).astype(np.float32)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    opened = cv2.dilate(cv2.erode(src, kernel), kernel)
    opened = cv2.GaussianBlur(opened, (0, 0), k / 4)
    return np.where(np.isfinite(dsm), np.minimum(opened, src), np.nan).astype(np.float32)


def surface_cues(dsm, dtm, m_per_px):
    """Per-pixel height above ground, slope (degrees) and roughness (metres)."""
    hag = dsm - dtm
    filled = np.where(np.isfinite(dsm), dsm, np.nanmedian(dsm)).astype(np.float32)
    gx = cv2.Sobel(filled, cv2.CV_32F, 1, 0, ksize=3) / (8 * m_per_px)
    gy = cv2.Sobel(filled, cv2.CV_32F, 0, 1, ksize=3) / (8 * m_per_px)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    # Roughness: RMS of the residual after removing a local plane (approximated
    # by a box mean, which removes the planar trend over a small window).
    k = max(3, int(round(1.0 / max(m_per_px, 1e-6))) | 1)     # about one metre
    mean = cv2.blur(filled, (k, k))
    rough = np.sqrt(cv2.blur((filled - mean) ** 2, (k, k)))
    invalid = ~np.isfinite(dsm)
    slope[invalid] = np.nan
    rough[invalid] = np.nan
    return hag, slope, rough


def feature_mask(shape, polygon_px, point_px=None, radius_px=4):
    mask = np.zeros(shape, np.uint8)
    if polygon_px is not None and len(polygon_px) >= 3:
        cv2.fillPoly(mask, [np.round(np.array(polygon_px)).astype(np.int32)], 1)
    elif point_px is not None:
        cv2.circle(mask, tuple(int(round(v)) for v in point_px), int(radius_px), 1, -1)
    return mask.astype(bool)


def stats(mask, hag, slope, rough):
    n = int(mask.sum())
    if not n:
        return None
    h = hag[mask]
    valid = np.isfinite(h)
    out = {'pixels': n, 'valid': round(float(valid.mean()), 3)}
    if valid.sum() < 4:
        return out
    out.update({
        'hag_median_m': round(float(np.median(h[valid])), 2),
        'hag_p90_m': round(float(np.percentile(h[valid], 90)), 2),
        'slope_median_deg': round(float(np.nanmedian(slope[mask])), 1),
        'roughness_m': round(float(np.nanmedian(rough[mask])), 3),
    })
    return out


def decide(kind, s, vertical_error):
    """Geometry vote for one feature. Returns (kind, reason) or (None, reason)
    when the geometry cannot be trusted for this feature."""
    if s is None or s['valid'] < MIN_VALID or 'hag_median_m' not in s:
        return None, 'too little reconstructed surface inside the feature'
    hag, p90, rough, slope = s['hag_median_m'], s['hag_p90_m'], s['roughness_m'], s['slope_median_deg']
    # Noise relative to the cue we need: when the vertical error approaches the
    # thresholds, say so and keep the imagery label.
    if vertical_error >= GROUND_HAG:
        return None, 'vertical error %.2f m is too large to separate ground from raised objects' % vertical_error
    uneven = rough >= ROUGH_CROWN or slope >= 35
    if kind in GROUND and hag >= BUILDING_HAG and rough <= ROUGH_PLANAR and slope < STEEP_DEG:
        return 'building', 'flat surface %.1f m above ground' % hag
    if kind in GROUND and hag >= TREE_HAG and uneven:
        return 'tree', 'uneven crown %.1f m above ground' % hag
    if kind == 'building' and hag < GROUND_HAG:
        return ('grass' if rough >= ROUGH_PLANAR else 'pavement'), 'labelled building but only %.1f m above ground' % hag
    if kind == 'building' and uneven and p90 >= TREE_HAG:
        return 'tree', 'bumpy %.1f m high surface reads as a tree crown, not a roof' % hag
    if kind in ('tree', 'canopy') and p90 < GROUND_HAG:
        return 'grass', 'no raised crown (90th percentile %.1f m)' % p90
    if kind in GROUND and slope >= STEEP_DEG and kind in ('path', 'road', 'pavement'):
        return kind, 'kept; ground slope %.0f° is steep for paving, check on site' % slope
    return kind, 'geometry agrees'


def apply(job, features, mosaic_shape, m_per_px, kinds_available=None):
    """Relabel features in place where the geometry is decisive. Returns a report."""
    dsm, dtm, meta, reason = load(job, mosaic_shape, m_per_px)
    report = {'used': False, 'reason': reason, 'changed': [], 'kept': 0, 'fallback': 0}
    if dsm is None:
        return report
    coverage = float(np.isfinite(dsm).mean())
    if coverage < 0.2:
        report['reason'] = 'Only %.0f%% of the scene was reconstructed; labels come from imagery only.' % (coverage * 100)
        return report
    vertical = float(meta.get('vertical_error_m', 0.2))
    hag, slope, rough = surface_cues(dsm, dtm, m_per_px)
    report.update({'used': True, 'reason': None, 'coverage': round(coverage, 3), 'vertical_error_m': vertical})
    for f in features:
        point = f.get('point_px') or ((f['p'][0][0] / m_per_px, f['p'][0][1] / m_per_px) if f.get('geometry') == 'point' and not f.get('pixel_polygon') else None)
        mask = feature_mask(dsm.shape, f.get('pixel_polygon'), point, radius_px=max(3, 1.5 / m_per_px))
        s = stats(mask, hag, slope, rough)
        new, why = decide(f['kind'], s, vertical)
        f['geometry_evidence'] = dict(s or {}, decision=why)
        if new is None:
            report['fallback'] += 1
            f.setdefault('flags', []).append('geometry unavailable')
            continue
        if kinds_available is not None and new not in kinds_available:
            report['kept'] += 1
            continue
        if new != f['kind']:
            report['changed'].append({'id': f.get('id'), 'from': f['kind'], 'to': new, 'why': why})
            f['image_kind'] = f['kind']
            f['kind'] = new
            f.setdefault('flags', []).append('relabelled by geometry')
        else:
            report['kept'] += 1
    return report


# ----------------------------------------------------------------- evaluation
def per_class_iou(pred, truth, classes, ignore=-1):
    out = {}
    valid = truth != ignore
    for i, name in enumerate(classes):
        p, t = (pred == i) & valid, (truth == i) & valid
        union = int((p | t).sum())
        if union:
            out[name] = round(int((p & t).sum()) / union, 3)
    return out


def compare(image_only, fused, truth, classes, ignore=-1):
    """Image-only baseline vs geometry-fused labels on the same held-out truth.

    `truth` uses `ignore` for unlabelled pixels (sparse labels from Semantic
    Studio). Returns per-class IoU for both and the mean difference."""
    a = per_class_iou(image_only, truth, classes, ignore)
    b = per_class_iou(fused, truth, classes, ignore)
    shared = sorted(set(a) | set(b))
    miou = lambda d: round(sum(d.get(k, 0) for k in shared) / max(1, len(shared)), 3)
    return {'classes': shared, 'image_only': a, 'fused': b,
            'mean_iou': {'image_only': miou(a), 'fused': miou(b)},
            'labelled_pixels': int((truth != ignore).sum())}


def fuse_raster(image_label, classes, hag, rough, slope=None):
    """Pixel labels for evaluation against dense labels. Raised surfaces are
    judged as whole objects (connected components), so roof edges and crown
    gaps follow the object's overall shape rather than flickering per pixel."""
    out = image_label.copy()
    idx = {c: i for i, c in enumerate(classes)}
    ok = np.isfinite(hag)
    ground = np.isin(image_label, [idx[c] for c in GROUND if c in idx])
    raised = (ok & (hag >= TREE_HAG)).astype(np.uint8)
    count, comp = cv2.connectedComponents(raised, connectivity=8)
    for c in range(1, count):
        m = comp == c
        if m.sum() < 9:
            continue
        median_rough = float(np.nanmedian(rough[m]))
        median_slope = float(np.nanmedian(slope[m])) if slope is not None else 0.0
        target = None
        if median_rough <= ROUGH_PLANAR and median_slope < STEEP_DEG and float(np.median(hag[m])) >= BUILDING_HAG:
            target = idx.get('building')
        elif median_rough >= ROUGH_CROWN or median_slope >= 35:
            target = idx.get('tree')
        if target is not None:
            out[m & (ground | (image_label == idx.get('building', -9)) | (image_label == idx.get('tree', -9)))] = target
    low = ok & (hag < GROUND_HAG)
    if 'building' in idx:
        paving = idx.get('pavement', idx.get('path'))
        if paving is not None:
            out[low & (image_label == idx['building'])] = paving
    if 'tree' in idx and 'grass' in idx:
        out[low & (image_label == idx['tree'])] = idx['grass']
    return out


def evaluate(job, classes=('building', 'road', 'path', 'grass', 'tree', 'pavement')):
    """Compare against labels when <job>/reconstruction/labels.npy exists
    (class index per mosaic pixel, -1 unlabelled) together with
    <job>/reconstruction/image_labels.npy (the imagery-only prediction)."""
    root = Path(job) / 'reconstruction'
    if not (root / 'labels.npy').exists() or not (root / 'image_labels.npy').exists():
        return {'status': 'blocked', 'reason': 'No held-out labels: export Semantic Studio labels for this scene as reconstruction/labels.npy to compare against the image-only baseline.'}
    truth = np.load(root / 'labels.npy')
    image = np.load(root / 'image_labels.npy')
    dsm, dtm, meta, reason = load(job, truth.shape)
    if dsm is None:
        return {'status': 'blocked', 'reason': reason}
    hag, slope, rough = surface_cues(dsm, dtm, float(meta.get('m_per_px', 0.05)))
    return dict(compare(image, fuse_raster(image, list(classes), hag, rough, slope), truth, list(classes)), status='complete')
