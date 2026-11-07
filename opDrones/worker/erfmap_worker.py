#!/usr/bin/env python3
"""erfMap video-intake worker.

The Node server runs this script once per pipeline stage:

    python erfmap_worker.py capabilities
    python erfmap_worker.py run <stage> <job-directory>

Each run prints JSON lines to stdout. Progress lines look like
{"event": "progress", "value": 0.4, "message": "..."}; the last line is
{"event": "result", "status": ..., ...}. The same result is written to
<job>/stages/<stage>/result.json so it can be inspected and audited later.

Everything here works in image pixels or "mosaic pixels" (the canvas of the
reference frame after planar alignment). Nothing is georeferenced. Metres only
appear in the geometry stage, from ground markers the reviewer confirmed.
"""
import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

try:
    import numpy as np
except ImportError:  # pragma: no cover - reported through capabilities
    np = None
try:
    import cv2
except ImportError:  # pragma: no cover - reported through capabilities
    cv2 = None

MARKER_SIDE_M = 0.3048          # 1 ft x 1 ft ground marker
MAX_FRAMES = 60                 # frames sampled from the video
FRAME_HEIGHT = 720              # extracted frame height (px)
MOSAIC_MAX = 2400               # longest mosaic side (px)
UNCERTAIN_BELOW = 0.6           # classifier confidence that needs review
STAGES = ['probe', 'frames', 'correction', 'markers', 'regions', 'classification', 'merging', 'geometry']


# ---------------------------------------------------------------- utilities
def emit(event, **data):
    sys.stdout.write(json.dumps({'event': event, **data}) + '\n')
    sys.stdout.flush()


def progress(value, message=''):
    emit('progress', value=round(float(value), 3), message=message)


def read_json(path, default=None):
    try:
        with open(path, encoding='utf-8') as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    with open(tmp, 'w', encoding='utf-8') as handle:
        json.dump(data, handle, indent=1)
    os.replace(tmp, path)


def _windows_search_dirs():
    """Folders where Windows installers commonly put FFmpeg.

    The server inherits PATH from the terminal that started it. A terminal opened
    before FFmpeg was installed (or an editor's built-in terminal) still has the
    old PATH, so also read the current PATH from the registry and check the
    usual winget, Chocolatey, Scoop and manual install folders.
    """
    dirs = []
    try:
        import winreg
        for root, key in ((winreg.HKEY_CURRENT_USER, 'Environment'),
                          (winreg.HKEY_LOCAL_MACHINE, r'SYSTEM\CurrentControlSet\Control\Session Manager\Environment')):
            try:
                with winreg.OpenKey(root, key) as handle:
                    value = winreg.QueryValueEx(handle, 'Path')[0]
                    dirs += [os.path.expandvars(d) for d in value.split(';') if d]
            except OSError:
                pass
    except ImportError:
        pass
    local = os.environ.get('LOCALAPPDATA', '')
    home = os.path.expanduser('~')
    dirs += [os.path.join(local, 'Microsoft', 'WinGet', 'Links'),
             os.path.join(os.environ.get('ProgramData', r'C:\ProgramData'), 'chocolatey', 'bin'),
             os.path.join(home, 'scoop', 'shims'),
             r'C:\ffmpeg\bin',
             os.path.join(os.environ.get('ProgramFiles', r'C:\Program Files'), 'ffmpeg', 'bin')]
    if local:
        import glob
        pattern = os.path.join(local, 'Microsoft', 'WinGet', 'Packages', '*FFmpeg*', '**', 'bin', 'ffmpeg.exe')
        dirs += [os.path.dirname(p) for p in glob.glob(pattern, recursive=True)]
    return dirs


def tool(name):
    """Locate ffmpeg or ffprobe.

    Order: ERFMAP_FFMPEG / ERFMAP_FFPROBE (a file, or the folder holding it);
    the folder of whichever of the two is set; PATH; then, on Windows, the
    registry PATH and common install folders.
    """
    exe = name + ('.exe' if os.name == 'nt' else '')
    for var in ('ERFMAP_' + name.upper(), 'ERFMAP_FFMPEG', 'ERFMAP_FFPROBE'):
        value = os.environ.get(var, '').strip().strip('"')
        if not value:
            continue
        if var == 'ERFMAP_' + name.upper() and os.path.isfile(value):
            return value
        folder = value if os.path.isdir(value) else os.path.dirname(value)
        if os.path.isfile(os.path.join(folder, exe)):
            return os.path.join(folder, exe)
    found = shutil.which(name)
    if found or os.name != 'nt':
        return found
    for folder in _windows_search_dirs():
        candidate = os.path.join(folder, exe)
        if os.path.isfile(candidate):
            return candidate
    return None


def capabilities():
    ffmpeg, ffprobe = tool('ffmpeg'), tool('ffprobe')
    return {
        'python': sys.version.split()[0],
        'ffmpeg': bool(ffmpeg),
        'ffprobe': bool(ffprobe),
        'ffmpeg_path': ffmpeg,
        'ffprobe_path': ffprobe,
        'numpy': np is not None,
        'opencv': cv2.__version__ if cv2 is not None else None,
        'segmenter': os.environ.get('ERFMAP_SEGMENTER') or None,
        'classifier': os.environ.get('ERFMAP_CLASSIFIER') or None,
    }


class Unavailable(Exception):
    """A dependency this stage needs is not installed or configured."""


def need_cv():
    if np is None or cv2 is None:
        raise Unavailable('OpenCV and NumPy are not installed for the worker. Run: pip install -r worker/requirements.txt')


def stage_dir(job, name):
    path = Path(job) / 'stages' / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def stage_result(job, name):
    result = read_json(Path(job) / 'stages' / name / 'result.json')
    if not result or result.get('status') not in ('complete', 'needs_review', 'unavailable'):
        raise RuntimeError('The ' + name + ' stage has no usable output. Run it first.')
    return result


def rel(job, path):
    return Path(path).relative_to(job).as_posix()


def imread(path):
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError('Could not read image ' + str(path))
    return image


def to_list(matrix):
    return [[float(v) for v in row] for row in matrix]


def apply_h(H, points):
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 1, 2)
    return cv2.perspectiveTransform(pts, np.asarray(H, dtype=np.float64)).reshape(-1, 2)


def polygon_area(points):
    p = np.asarray(points, dtype=np.float64)
    if len(p) < 3:
        return 0.0
    return float(abs(np.dot(p[:, 0], np.roll(p[:, 1], 1)) - np.dot(p[:, 1], np.roll(p[:, 0], 1))) / 2)


def order_corners(corners):
    """Order four corners clockwise in image space, starting nearest the top-left."""
    c = np.asarray(corners, dtype=np.float64)
    centre = c.mean(axis=0)
    angles = np.arctan2(c[:, 1] - centre[1], c[:, 0] - centre[0])
    c = c[np.argsort(angles)]
    start = int(np.argmin(c[:, 0] + c[:, 1]))
    return np.roll(c, -start, axis=0)


def sides(corners):
    c = np.asarray(corners, dtype=np.float64)
    return [float(np.linalg.norm(c[i] - c[(i + 1) % 4])) for i in range(4)]


# ---------------------------------------------------------------- 0. probe
def stage_probe(job):
    ffprobe = tool('ffprobe')
    if not ffprobe:
        raise Unavailable('ffprobe (part of FFmpeg) was not found on PATH. Install FFmpeg or set ERFMAP_FFPROBE.')
    meta = read_json(Path(job) / 'job.json')
    video = Path(job) / meta['original']['path']
    progress(.2, 'Reading container and stream metadata')
    out = subprocess.run([ffprobe, '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', str(video)],
                         capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError('ffprobe could not read this file: ' + out.stderr.strip()[-400:])
    raw = json.loads(out.stdout)
    streams = raw.get('streams', [])
    v = next((s for s in streams if s.get('codec_type') == 'video'), None)
    if not v:
        raise RuntimeError('The file has no video stream.')
    fmt = raw.get('format', {})
    tags = {**{k.lower(): val for k, val in (fmt.get('tags') or {}).items()},
            **{('stream.' + k.lower()): val for k, val in (v.get('tags') or {}).items()}}

    def rate(text):
        try:
            a, b = str(text).split('/')
            return float(a) / float(b) if float(b) else None
        except (ValueError, ZeroDivisionError):
            return None
    rotation = None
    for side in v.get('side_data_list') or []:
        if 'rotation' in side:
            rotation = side['rotation']
    if rotation is None and 'stream.rotate' in tags:
        rotation = tags['stream.rotate']
    camera = {k: tags[k] for k in tags if any(w in k for w in ('make', 'model', 'software', 'encoder', 'handler', 'firmware'))}
    gps_tags = [k for k in tags if 'location' in k or 'gps' in k]
    duration = float(fmt.get('duration') or v.get('duration') or 0)
    metadata = {
        'container': fmt.get('format_long_name') or fmt.get('format_name'),
        'duration_s': duration,
        'size_bytes': int(fmt.get('size') or 0),
        'codec': v.get('codec_long_name') or v.get('codec_name'),
        'width': v.get('width'), 'height': v.get('height'),
        'fps': rate(v.get('avg_frame_rate')) or rate(v.get('r_frame_rate')),
        'frame_count': int(v['nb_frames']) if str(v.get('nb_frames', '')).isdigit() else None,
        'pixel_format': v.get('pix_fmt'),
        'rotation': rotation,
        'creation_time': tags.get('creation_time') or tags.get('stream.creation_time'),
        'camera_tags': camera,
        'data_streams': [s.get('codec_tag_string') or s.get('codec_name') for s in streams if s.get('codec_type') in ('data', 'subtitle')],
        'all_tags': tags,
    }
    warnings = []
    if gps_tags:
        warnings.append('The file contains location tags (' + ', '.join(gps_tags) + '). They are kept in the metadata but not used: this pipeline produces an unreferenced local map.')
    if metadata['data_streams']:
        warnings.append('The file has telemetry or subtitle streams. They are preserved in the original file but this worker does not parse them, so camera tilt is not measured.')
    if duration and duration < 3:
        warnings.append('The video is shorter than 3 seconds, so there may be too little overlap to merge detections.')
    write_json(stage_dir(job, 'probe') / 'metadata.json', raw)
    return {'status': 'complete', 'summary': '%sx%s, %.1f s, %s' % (metadata['width'], metadata['height'], duration, metadata['codec']),
            'metadata': metadata, 'warnings': warnings}


# ---------------------------------------------------------------- 1. frames
def frame_metrics(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    edges = cv2.Canny(gray, 60, 160)
    h = gray.shape[0]
    top, rest = gray[: h // 6], gray[h // 6:]
    top_edges = float((edges[: h // 6] > 0).mean())
    return {
        'sharpness': round(sharp, 1),
        'brightness': round(float(gray.mean()), 1),
        'contrast': round(float(gray.std()), 1),
        'texture': round(float((edges > 0).mean()), 4),
        # A bright, featureless band across the top usually means sky is in
        # view, i.e. the camera is tilted well away from nadir.
        'sky_band': bool(top.mean() > rest.mean() + 35 and top_edges < 0.01),
    }


def stage_frames(job):
    need_cv()
    ffmpeg = tool('ffmpeg')
    if not ffmpeg:
        raise Unavailable('FFmpeg was not found on PATH. Install FFmpeg or set ERFMAP_FFMPEG.')
    meta = read_json(Path(job) / 'job.json')
    video = Path(job) / meta['original']['path']
    probe = stage_result(job, 'probe')['metadata']
    duration = probe.get('duration_s') or 0
    fps = min(2.0, MAX_FRAMES / duration) if duration else 1.0
    out = stage_dir(job, 'frames')
    for old in out.glob('f*.jpg'):
        old.unlink()
    progress(.05, 'Extracting frames with FFmpeg at %.2f fps' % fps)
    cmd = [ffmpeg, '-v', 'error', '-y', '-i', str(video), '-vf', "fps=%.4f,scale=-2:'min(%d,ih)'" % (fps, FRAME_HEIGHT),
           '-frames:v', str(MAX_FRAMES), '-q:v', '3', str(out / 'f%04d.jpg')]
    run = subprocess.run(cmd, capture_output=True, text=True)
    if run.returncode:
        raise RuntimeError('FFmpeg frame extraction failed: ' + run.stderr.strip()[-400:])
    files = sorted(out.glob('f*.jpg'))
    if not files:
        raise RuntimeError('FFmpeg produced no frames from this video.')
    frames = []
    for i, path in enumerate(files):
        image = imread(path)
        frames.append({'id': path.stem, 'index': i, 'time_s': round(i / fps, 2), 'image': rel(job, path),
                       'width': image.shape[1], 'height': image.shape[0], 'metrics': frame_metrics(image)})
        progress(.3 + .6 * (i + 1) / len(files), 'Scoring frame %d of %d' % (i + 1, len(files)))
    sharp = sorted(f['metrics']['sharpness'] for f in frames)
    median = sharp[len(sharp) // 2]
    blur_limit = max(25.0, 0.35 * median)
    for f in frames:
        m, flags = f['metrics'], []
        if m['sharpness'] < blur_limit:
            flags.append('blurry')
        if m['brightness'] < 45:
            flags.append('dark')
        if m['brightness'] > 215:
            flags.append('overexposed')
        if m['texture'] < 0.008:
            flags.append('low texture')
        if m['sky_band']:
            flags.append('tilted (sky visible)')
        f['flags'] = flags
        f['usable'] = not flags
    usable = [f for f in frames if f['usable']]
    warnings = ['Camera tilt is estimated only from sky visible in frame; there is no gimbal telemetry to measure it.']
    if not usable:
        raise RuntimeError('None of the %d frames are usable (all blurry, dark, tilted or featureless).' % len(frames))
    if len(usable) < 3:
        warnings.append('Only %d usable frames. Cross-frame merging needs overlap between several frames.' % len(usable))
    return {'status': 'needs_review' if len(usable) < len(frames) / 2 or len(usable) < 3 else 'complete',
            'summary': '%d of %d frames usable' % (len(usable), len(frames)),
            'sample_fps': fps, 'blur_limit': round(blur_limit, 1), 'frames': frames, 'warnings': warnings}


# ---------------------------------------------------------------- 2. correction
def homography_ok(H):
    if H is None:
        return False
    H = H / H[2, 2]
    det = np.linalg.det(H[:2, :2])
    return 0.4 < det < 2.5 and abs(H[2, 0]) < 0.002 and abs(H[2, 1]) < 0.002


def stage_correction(job):
    need_cv()
    frames = [f for f in stage_result(job, 'frames')['frames'] if f['usable']]
    out = stage_dir(job, 'correction')
    camera = read_json(Path(job) / 'camera.json')
    lens = {'status': 'unavailable', 'reason': 'No camera calibration supplied (camera.json with fx, fy, cx, cy and distortion coefficients). Frames are not lens-corrected.'}
    K = D = None
    if camera:
        try:
            K = np.array([[camera['fx'], 0, camera['cx']], [0, camera['fy'], camera['cy']], [0, 0, 1]], dtype=np.float64)
            D = np.array(camera.get('dist', [0, 0, 0, 0, 0]), dtype=np.float64)
            lens = {'status': 'applied', 'reason': 'Undistorted with the supplied camera.json.'}
        except (KeyError, TypeError) as error:
            lens = {'status': 'failed', 'reason': 'camera.json is missing ' + str(error)}
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    corrected = []
    for i, f in enumerate(frames):
        image = imread(Path(job) / f['image'])
        if K is not None:
            image = cv2.undistort(image, K, D)
        lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
        lab[:, :, 0] = clahe.apply(lab[:, :, 0])
        clean = cv2.fastNlMeansDenoisingColored(cv2.cvtColor(lab, cv2.COLOR_LAB2BGR), None, 3, 3, 7, 15)
        path = out / (f['id'] + '.jpg')
        cv2.imwrite(str(path), clean, [cv2.IMWRITE_JPEG_QUALITY, 88])
        corrected.append({'id': f['id'], 'before': f['image'], 'after': rel(job, path), 'width': clean.shape[1], 'height': clean.shape[0]})
        progress(.4 * (i + 1) / len(frames), 'Cleaning frame %d of %d' % (i + 1, len(frames)))

    # Planar alignment: chain consecutive-frame homographies to a middle reference frame.
    orb = cv2.ORB_create(3000)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    feats = []
    for c in corrected:
        gray = cv2.cvtColor(imread(Path(job) / c['after']), cv2.COLOR_BGR2GRAY)
        feats.append(orb.detectAndCompute(gray, None))
    pair = [None] * len(corrected)   # pair[i]: homography from frame i to frame i-1
    links = []
    for i in range(1, len(corrected)):
        (k1, d1), (k0, d0) = feats[i], feats[i - 1]
        H, inliers = None, 0
        if d1 is not None and d0 is not None and len(k1) > 10 and len(k0) > 10:
            matches = [m for m, n in (p for p in matcher.knnMatch(d1, d0, k=2) if len(p) == 2) if m.distance < 0.75 * n.distance]
            if len(matches) >= 12:
                src = np.float32([k1[m.queryIdx].pt for m in matches])
                dst = np.float32([k0[m.trainIdx].pt for m in matches])
                H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 4.0)
                inliers = int(mask.sum()) if mask is not None else 0
        ok = homography_ok(H) and inliers >= 30
        pair[i] = H / H[2, 2] if ok else None
        links.append({'from': corrected[i]['id'], 'to': corrected[i - 1]['id'], 'inliers': inliers, 'ok': ok})
        progress(.4 + .4 * i / max(1, len(corrected) - 1), 'Aligning frame %d of %d' % (i + 1, len(corrected)))
    ref = len(corrected) // 2
    to_ref = {ref: np.eye(3)}
    for i in range(ref + 1, len(corrected)):
        if pair[i] is None or (i - 1) not in to_ref:
            break
        to_ref[i] = to_ref[i - 1] @ pair[i]
    for i in range(ref - 1, -1, -1):
        if pair[i + 1] is None or (i + 1) not in to_ref:
            break
        to_ref[i] = to_ref[i + 1] @ np.linalg.inv(pair[i + 1])
    h0, w0 = imread(Path(job) / corrected[ref]['after']).shape[:2]
    corners = np.concatenate([apply_h(to_ref[i], [[0, 0], [w0, 0], [w0, h0], [0, h0]]) for i in to_ref])
    lo, hi = corners.min(axis=0), corners.max(axis=0)
    span = hi - lo
    s = min(1.0, MOSAIC_MAX / max(span))
    T = np.array([[s, 0, -lo[0] * s], [0, s, -lo[1] * s], [0, 0, 1]])
    W, H_ = int(math.ceil(span[0] * s)) + 1, int(math.ceil(span[1] * s)) + 1
    acc = np.zeros((H_, W, 3), np.float32)
    weight = np.zeros((H_, W), np.float32)
    for n, i in enumerate(sorted(to_ref)):
        M = T @ to_ref[i]
        image = imread(Path(job) / corrected[i]['after']).astype(np.float32)
        warped = cv2.warpPerspective(image, M, (W, H_))
        mask = cv2.warpPerspective(np.ones(image.shape[:2], np.float32), M, (W, H_))
        acc += warped * mask[:, :, None]
        weight += mask
        corrected[i]['to_mosaic'] = to_list(M)
        progress(.8 + .2 * (n + 1) / len(to_ref), 'Building alignment preview')
    mosaic = (acc / np.maximum(weight, 1e-6)[:, :, None]).clip(0, 255).astype(np.uint8)
    mosaic[weight == 0] = (32, 32, 32)
    cv2.imwrite(str(out / 'mosaic.jpg'), mosaic, [cv2.IMWRITE_JPEG_QUALITY, 85])
    aligned = len(to_ref)
    warnings = ['The alignment preview is a planar homography stitch, not an orthomosaic. Relief, tall objects and camera tilt cause displacement that is not corrected.']
    if lens['status'] != 'applied':
        warnings.append(lens['reason'])
    if aligned < len(corrected):
        warnings.append('%d of %d usable frames could not be aligned to the reference frame (weak feature matches) and are left out of later stages.' % (len(corrected) - aligned, len(corrected)))
    return {'status': 'needs_review' if aligned < max(2, 0.6 * len(corrected)) else 'complete',
            'summary': 'Cleaned %d frames, aligned %d to reference %s' % (len(corrected), aligned, corrected[ref]['id']),
            'lens': lens, 'cleanup': 'CLAHE contrast equalisation and light denoising', 'reference': corrected[ref]['id'],
            'frames': corrected, 'links': links, 'mosaic': {'image': rel(job, out / 'mosaic.jpg'), 'width': W, 'height': H_, 'scale': s},
            'warnings': warnings}


# ---------------------------------------------------------------- 3. markers
def fit_edges(contour, corners):
    """Sharpen approxPolyDP corners: fit a line to the contour points along each
    side and intersect neighbouring lines."""
    pts = contour.reshape(-1, 2).astype(np.float64)
    c = np.asarray(corners, dtype=np.float64)
    lines = []
    for i in range(4):
        a, b = c[i], c[(i + 1) % 4]
        d = b - a
        length = np.linalg.norm(d)
        if length < 1e-6:
            return c
        t = ((pts - a) @ d) / length ** 2
        off = np.abs(d[0] * (pts[:, 1] - a[1]) - d[1] * (pts[:, 0] - a[0])) / length
        near = pts[(t > 0.15) & (t < 0.85) & (off < max(2.0, 0.08 * length))]
        if len(near) < 3:
            return c
        vx, vy, x0, y0 = cv2.fitLine(near.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        lines.append((np.array([x0, y0]), np.array([vx, vy])))
    out = []
    for i in range(4):
        (p1, d1), (p2, d2) = lines[i - 1], lines[i]
        m = np.array([d1, -d2]).T
        if abs(np.linalg.det(m)) < 1e-6:
            return c
        t = np.linalg.solve(m, p2 - p1)
        out.append(p1 + t[0] * d1)
    out = np.array(out)
    return out if np.abs(out - c).max() < 0.25 * min(sides(c)) else c


def quads(binary, min_area, max_area, refine=False):
    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE if refine else cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        a = cv2.contourArea(contour)
        if a < min_area or a > max_area:
            continue
        approx = cv2.approxPolyDP(contour, 0.04 * cv2.arcLength(contour, True), True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue
        c = order_corners(approx.reshape(4, 2).astype(np.float64))
        sd = sides(c)
        if min(sd) < 6 or max(sd) / min(sd) > 1.6:
            continue
        yield (order_corners(fit_edges(contour, c)) if refine else c), a


def contrast_of(gray, corners):
    mask = np.zeros(gray.shape, np.uint8)
    cv2.fillConvexPoly(mask, np.round(corners).astype(np.int32), 255)
    width = max(3, int(min(sides(corners)) * .4))
    ring = cv2.dilate(mask, np.ones((width, width), np.uint8)) - mask
    inside = float(gray[mask > 0].mean()) if mask.any() else 0.0
    outside = float(gray[ring > 0].mean()) if ring.any() else inside
    return inside, outside


def find_squares(image):
    """Candidate high-contrast square markers: (corners, metrics) in frame pixels.

    The 1 ft square is the outer edge of the marker board, so nested pattern
    squares are dropped in favour of the enclosing one.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    smooth = cv2.GaussianBlur(gray, (3, 3), 0)
    candidates = []
    # Several global thresholds in both polarities: a board only needs to
    # separate cleanly from its surroundings at one of them.
    for flip in (False, True):
        g = 255 - smooth if flip else smooth
        for level in (None, 64, 96, 128, 160, 192, 224):
            if level is None:
                _, binary = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            else:
                _, binary = cv2.threshold(g, level, 255, cv2.THRESH_BINARY)
            for c, a in quads(binary, 80, 0.05 * gray.size):
                inside, outside = contrast_of(gray, c)
                if abs(inside - outside) >= 50:
                    candidates.append(c)
    candidates.sort(key=lambda c: -np.mean(sides(c)))
    kept = []
    for c in candidates:
        centre = c.mean(axis=0)
        if all(np.linalg.norm(centre - k.mean(axis=0)) > 0.5 * np.mean(sides(k)) for k in kept):
            kept.append(c)
    found = []
    for c in kept:
        # Refine: re-threshold locally at the half-contrast level so the edge sits
        # where the intensity crosses midway between board and ground.
        inside, outside = contrast_of(gray, c)
        side = np.mean(sides(c))
        x0, y0 = np.maximum(0, np.floor(c.min(axis=0) - side * .6)).astype(int)
        x1, y1 = np.minimum(gray.shape[::-1], np.ceil(c.max(axis=0) + side * .6)).astype(int)
        roi = smooth[y0:y1, x0:x1]
        level = (inside + outside) / 2
        binary = ((roi > level) if inside > outside else (roi < level)).astype(np.uint8) * 255
        best = None
        for q, a in quads(binary, 0.5 * polygon_area(c), 2 * polygon_area(c), refine=True):
            q = q + (x0, y0)
            if cv2.pointPolygonTest(q.astype(np.float32), tuple(float(v) for v in c.mean(axis=0)), False) > 0:
                best = q if best is None or abs(polygon_area(q) - polygon_area(c)) < abs(polygon_area(best) - polygon_area(c)) else best
        if best is None:
            continue
        sd = sides(best)
        # Edge fill: share of a thin band just inside the edge that is board-coloured.
        # Patterns in the middle of the board do not count; occlusion of the edge does.
        board = cv2.fillConvexPoly(np.zeros(gray.shape, np.uint8), np.round(best).astype(np.int32), 1)
        band = board - cv2.erode(board, np.ones((max(3, int(min(sd) * .15)),) * 2, np.uint8))
        on = (smooth > level) if inside > outside else (smooth < level)
        edge_fill = float(np.count_nonzero(band & on)) / max(1, np.count_nonzero(band))
        x, y, w, h = cv2.boundingRect(np.round(best).astype(np.int32))
        patch = gray[max(0, y - 2):y + h + 2, max(0, x - 2):x + w + 2]
        i2, o2 = contrast_of(gray, best)
        found.append((best, {
            'side_px': round(float(np.mean(sd)), 1), 'squareness': round(min(sd) / max(sd), 3),
            'fill': round(edge_fill, 3), 'contrast': round(abs(i2 - o2), 1),
            'sharpness': round(float(cv2.Laplacian(patch, cv2.CV_64F).var()), 1) if patch.size else 0}))
    return found


def stage_markers(job):
    need_cv()
    corr = stage_result(job, 'correction')
    frames = [f for f in corr['frames'] if 'to_mosaic' in f]
    flags_by_frame = {f['id']: f['flags'] for f in stage_result(job, 'frames')['frames']}
    detections = []
    for i, f in enumerate(frames):
        for corners, metrics in find_squares(imread(Path(job) / f['after'])):
            detections.append({'frame': f['id'], 'corners': corners.tolist(),
                               'mosaic': order_corners(apply_h(f['to_mosaic'], corners)).tolist(), **metrics})
        progress((i + 1) / len(frames), 'Searching frame %d of %d for square markers' % (i + 1, len(frames)))
    markers = []
    for d in sorted(detections, key=lambda d: -d['contrast']):
        centre = np.mean(d['mosaic'], axis=0)
        side = np.mean(sides(d['mosaic']))
        home = next((m for m in markers if np.linalg.norm(m['_centre'] - centre) < 1.5 * max(side, m['_side'])), None)
        if home is None:
            home = {'_centre': centre, '_side': side, 'detections': []}
            markers.append(home)
        home['detections'].append(d)
    result = []
    for n, m in enumerate(markers):
        # The 1 ft square is the board's outer edge. Inner pattern squares share
        # the centre but are smaller, so keep only detections near the largest size.
        biggest = max(np.mean(sides(d['mosaic'])) for d in m['detections'])
        ds, seen = [], set()
        for d in sorted(m['detections'], key=lambda d: -np.mean(sides(d['mosaic']))):
            if np.mean(sides(d['mosaic'])) > 0.8 * biggest and d['frame'] not in seen:
                ds.append(d)
                seen.add(d['frame'])
        corners = order_corners(np.median(np.array([d['mosaic'] for d in ds]), axis=0))
        side_frames = [d['side_px'] for d in ds]
        mosaic_sides = [np.mean(sides(d['mosaic'])) for d in ds]
        spread = float(np.std(mosaic_sides) / np.mean(mosaic_sides)) if len(ds) > 1 else 0.0
        flags = []
        if np.median([d['sharpness'] for d in ds]) < 80 or all('blurry' in flags_by_frame.get(d['frame'], []) for d in ds):
            flags.append('blurry')
        if np.median(side_frames) < 24:
            flags.append('too small')
        if len(ds) < 3:
            flags.append('visible in too few frames')
        if np.median([d['squareness'] for d in ds]) < 0.85 or np.median([d['fill'] for d in ds]) < 0.85 or spread > 0.15:
            flags.append('possibly obscured or distorted')
        result.append({'id': 'M%d' % (n + 1), 'corners': corners.tolist(), 'frames': [d['frame'] for d in ds],
                       'side_px_frame': round(float(np.median(side_frames)), 1),
                       'side_px_mosaic': round(float(np.mean(sides(corners))), 2),
                       'size_spread': round(spread, 3), 'flags': flags, 'detections': ds})
    # Single-frame, small, low-contrast candidates are usually clutter; keep them but list them last.
    result.sort(key=lambda m: (len(m['flags']), -len(m['frames'])))
    for n, m in enumerate(result):
        m['id'] = 'M%d' % (n + 1)
    warnings = ['One marker establishes scale only near that marker. Several markers spread around the site make scaling more consistent and expose alignment problems.']
    if not result:
        warnings.append('No square markers were detected. You can place marker corners by hand on the alignment preview.')
    elif sum(1 for m in result if not m['flags']) < 2:
        warnings.append('Fewer than two clean markers were found. Scale will be local and unverified.')
    return {'status': 'needs_review', 'summary': '%d candidate markers (%d unflagged). Confirm the corners before scaling.' % (len(result), sum(1 for m in result if not m['flags'])),
            'marker_side_m': MARKER_SIDE_M, 'mosaic': corr['mosaic'], 'markers': result, 'warnings': warnings}


# ---------------------------------------------------------------- 4. regions
def keyframes(job, limit=10):
    frames = [f for f in stage_result(job, 'correction')['frames'] if 'to_mosaic' in f]
    if len(frames) <= limit:
        return frames
    step = (len(frames) - 1) / (limit - 1)
    return [frames[round(i * step)] for i in range(limit)]


def external(command, payload, what):
    """Run an adapter command. It receives JSON on stdin and must print JSON on stdout."""
    run = subprocess.run(command, input=json.dumps(payload), capture_output=True, text=True, shell=True, timeout=3600)
    if run.returncode:
        raise RuntimeError(what + ' adapter failed (exit %d): %s' % (run.returncode, run.stderr.strip()[-600:]))
    try:
        return json.loads(run.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(what + ' adapter did not print JSON.')


def baseline_regions(image, k=6):
    """Colour-cluster segmentation. A transparent stand-in for SAM 2, not a learned model."""
    h, w = image.shape[:2]
    s = 480 / max(h, w)
    small = cv2.resize(image, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    lab = cv2.cvtColor(cv2.GaussianBlur(small, (7, 7), 0), cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float32)
    _, labels, _ = cv2.kmeans(lab, k, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0), 3, cv2.KMEANS_PP_CENTERS)
    labels = labels.reshape(small.shape[:2])
    regions = []
    kernel = np.ones((5, 5), np.uint8)
    for cluster in range(k):
        mask = cv2.morphologyEx(cv2.morphologyEx((labels == cluster).astype(np.uint8) * 255, cv2.MORPH_OPEN, kernel), cv2.MORPH_CLOSE, kernel)
        count, comp, stats, _ = cv2.connectedComponentsWithStats(mask)
        for c in range(1, count):
            if stats[c, cv2.CC_STAT_AREA] < 0.006 * mask.size:
                continue
            piece = (comp == c).astype(np.uint8)
            contours, _ = cv2.findContours(piece, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            contour = max(contours, key=cv2.contourArea)
            approx = cv2.approxPolyDP(contour, 0.006 * cv2.arcLength(contour, True), True).reshape(-1, 2)
            if len(approx) < 3:
                continue
            colour = cv2.mean(small, mask=piece)[:3]
            regions.append({'polygon': (approx / s).round(1).tolist(), 'area_px': float(stats[c, cv2.CC_STAT_AREA] / s / s),
                            'mean_rgb': [round(colour[2]), round(colour[1]), round(colour[0])]})
    return regions


def stage_regions(job):
    need_cv()
    out = stage_dir(job, 'regions')
    frames = keyframes(job)
    segmenter = os.environ.get('ERFMAP_SEGMENTER')
    method = 'external segmenter: ' + segmenter if segmenter else 'baseline colour clustering (OpenCV k-means). Not SAM 2.'
    regions = []
    if segmenter:
        progress(.1, 'Running external segmenter')
        reply = external(segmenter, {'job': str(Path(job).resolve()), 'frames': [{'id': f['id'], 'image': str((Path(job) / f['after']).resolve())} for f in frames]}, 'Segmenter')
        for r in reply.get('regions', []):
            if r.get('frame') in {f['id'] for f in frames} and len(r.get('polygon', [])) >= 3:
                regions.append({'frame': r['frame'], 'polygon': r['polygon'], 'area_px': polygon_area(r['polygon']), 'mean_rgb': r.get('mean_rgb'), 'score': r.get('score')})
    else:
        for i, f in enumerate(frames):
            for r in baseline_regions(imread(Path(job) / f['after'])):
                regions.append({'frame': f['id'], **r})
            progress((i + 1) / len(frames), 'Segmenting keyframe %d of %d' % (i + 1, len(frames)))
    for n, r in enumerate(regions):
        r['id'] = 'R%d' % (n + 1)
    warnings = [] if segmenter else ['Regions come from colour clustering, which splits shadows and merges similar-looking surfaces. Configure ERFMAP_SEGMENTER for a learned segmenter such as SAM 2.']
    return {'status': 'complete' if regions else 'needs_review', 'summary': '%d candidate regions in %d keyframes' % (len(regions), len(frames)),
            'method': method, 'keyframes': [{'id': f['id'], 'image': f['after'], 'width': f['width'], 'height': f['height']} for f in frames], 'regions': regions, 'warnings': warnings}


# ---------------------------------------------------------------- 5. classification
def stage_classification(job):
    need_cv()
    reg = stage_result(job, 'regions')
    labels = read_json(Path(job) / 'labels.json', {'labels': []})
    label_map = labels.get('map', {})
    kinds = {l['kind'] for l in labels['labels']}
    classifier = os.environ.get('ERFMAP_CLASSIFIER')
    out = stage_dir(job, 'classification')
    crops = out / 'crops'
    crops.mkdir(exist_ok=True)
    images = {}
    payload = []
    for i, r in enumerate(reg['regions']):
        if r['frame'] not in images:
            images[r['frame']] = imread(Path(job) / next(k['image'] for k in reg['keyframes'] if k['id'] == r['frame']))
        image = images[r['frame']]
        poly = np.array(r['polygon'], dtype=np.int32)
        x, y, w, h = cv2.boundingRect(poly)
        mask = np.zeros(image.shape[:2], np.uint8)
        cv2.fillPoly(mask, [poly], 255)
        crop = cv2.bitwise_and(image, image, mask=mask)[y:y + h, x:x + w]
        path = crops / (r['id'] + '.png')
        if crop.size:
            cv2.imwrite(str(path), crop)
        payload.append({'id': r['id'], 'frame': r['frame'], 'crop': str(path.resolve()), 'polygon': r['polygon'], 'mean_rgb': r.get('mean_rgb'), 'area_px': r['area_px']})
        progress(.3 * (i + 1) / max(1, len(reg['regions'])), 'Preparing region crops')
    if not classifier:
        predictions = [{'id': r['id'], 'kind': None, 'model_label': None, 'confidence': None, 'needs_review': True} for r in reg['regions']]
        return {'status': 'unavailable', 'summary': 'No classifier configured. All %d regions are unlabelled and need review.' % len(predictions),
                'reason': 'Set ERFMAP_CLASSIFIER to a command that implements the classifier contract in worker/README.md. Until then, label regions by hand in Review.',
                'model': None, 'predictions': predictions, 'uncertain_below': UNCERTAIN_BELOW, 'warnings': []}
    progress(.4, 'Running classifier')
    reply = external(classifier, {'labels': labels['labels'], 'regions': payload}, 'Classifier')
    by_id = {p.get('id'): p for p in reply.get('predictions', [])}
    predictions, unmapped = [], set()
    for r in reg['regions']:
        p = by_id.get(r['id'], {})
        model_label = p.get('label') or p.get('kind')
        kind = label_map.get(model_label, model_label)
        if model_label is not None and kind not in kinds:
            unmapped.add(str(model_label))
            kind = None
        conf = p.get('confidence')
        conf = float(conf) if isinstance(conf, (int, float)) else None
        predictions.append({'id': r['id'], 'kind': kind, 'model_label': model_label, 'confidence': conf,
                            'needs_review': kind is None or conf is None or conf < UNCERTAIN_BELOW})
    warnings = []
    if unmapped:
        warnings.append('Classifier labels with no erfMap kind: %s. Add them to intake/label-map.json. Those regions are marked unknown.' % ', '.join(sorted(unmapped)))
    if reply.get('model', {}).get('heuristic'):
        warnings.append('The configured classifier reports itself as a heuristic, not a trained model.')
    uncertain = sum(p['needs_review'] for p in predictions)
    return {'status': 'needs_review' if uncertain else 'complete', 'summary': '%d regions classified, %d need review' % (len(predictions), uncertain),
            'model': reply.get('model'), 'predictions': predictions, 'uncertain_below': UNCERTAIN_BELOW, 'warnings': warnings}


# ---------------------------------------------------------------- 6. merging
def stage_merging(job):
    need_cv()
    corr = stage_result(job, 'correction')
    reg = stage_result(job, 'regions')
    cls = stage_result(job, 'classification')
    preds = {p['id']: p for p in cls['predictions']}
    to_mosaic = {f['id']: f['to_mosaic'] for f in corr['frames'] if 'to_mosaic' in f}
    W, H = corr['mosaic']['width'], corr['mosaic']['height']
    s = min(1.0, 900 / max(W, H))          # masks at reduced resolution
    size = (int(W * s) + 1, int(H * s) + 1)
    items = []
    for r in reg['regions']:
        poly = apply_h(to_mosaic[r['frame']], r['polygon'])
        mask = np.zeros((size[1], size[0]), np.uint8)
        cv2.fillPoly(mask, [np.round(poly * s).astype(np.int32)], 1)
        if mask.sum() < 4:
            continue
        items.append({'region': r, 'poly': poly, 'mask': mask.astype(bool), 'pred': preds.get(r['id'], {})})
    items.sort(key=lambda it: -it['mask'].sum())
    clusters = []
    for n, it in enumerate(items):
        best, best_iou = None, 0.3
        for c in clusters:
            if any(m['region']['frame'] == it['region']['frame'] for m in c['members']):
                continue
            inter = np.logical_and(c['union'], it['mask']).sum()
            iou = inter / max(1, np.logical_or(c['seed'], it['mask']).sum())
            if iou > best_iou:
                best, best_iou = c, iou
        if best is None:
            clusters.append({'seed': it['mask'], 'union': it['mask'].copy(), 'votes': it['mask'].astype(np.int32), 'members': [it], 'ious': []})
        else:
            best['members'].append(it)
            best['union'] |= it['mask']
            best['votes'] += it['mask']
            best['ious'].append(float(best_iou))
        progress(.8 * (n + 1) / max(1, len(items)), 'Matching region %d of %d across frames' % (n + 1, len(items)))
    merged = []
    for n, c in enumerate(clusters):
        need = math.ceil(len(c['members']) / 2)
        consensus = (c['votes'] >= need).astype(np.uint8)
        contours, _ = cv2.findContours(consensus, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        approx = cv2.approxPolyDP(contour, 0.006 * cv2.arcLength(contour, True), True).reshape(-1, 2)
        if len(approx) < 3:
            continue
        polygon = (approx / s).round(1).tolist()
        votes = {}
        for m in c['members']:
            k = m['pred'].get('kind')
            if k:
                votes[k] = votes.get(k, 0) + (m['pred'].get('confidence') or 0.0)
        kinds = sorted(votes, key=lambda k: -votes[k])
        kind = kinds[0] if kinds else None
        agreeing = [m for m in c['members'] if m['pred'].get('kind') == kind and kind]
        conf = None
        if agreeing and all(m['pred'].get('confidence') is not None for m in agreeing):
            conf = round(float(np.mean([m['pred']['confidence'] for m in agreeing])) * len(agreeing) / len(c['members']), 3)
        flags = []
        if len(kinds) > 1:
            flags.append('conflicting labels: ' + ', '.join(kinds))
        if c['ious'] and np.mean(c['ious']) < 0.5:
            flags.append('geometry varies between frames')
        if len(c['members']) == 1:
            flags.append('seen in one frame only')
        if kind is None:
            flags.append('unlabelled')
        merged.append({'id': 'G%d' % (n + 1), 'polygon': polygon, 'kind': kind, 'confidence': conf,
                       'members': [m['region']['id'] for m in c['members']], 'frames': sorted({m['region']['frame'] for m in c['members']}),
                       'mean_iou': round(float(np.mean(c['ious'])), 3) if c['ious'] else None, 'flags': flags,
                       'member_polygons': [{'region': m['region']['id'], 'frame': m['region']['frame'], 'polygon': m['poly'].round(1).tolist()} for m in c['members']]})
    conflicts = sum(1 for m in merged if any(f.startswith('conflicting') or f.startswith('geometry') for f in m['flags']))
    return {'status': 'needs_review' if conflicts else 'complete', 'summary': '%d regions merged into %d features, %d with conflicts' % (len(items), len(merged), conflicts),
            'mosaic': corr['mosaic'], 'merged': merged, 'warnings': []}


# ---------------------------------------------------------------- 7. geometry
def stage_geometry(job):
    need_cv()
    merged = stage_result(job, 'merging')
    labels = {l['kind']: l for l in read_json(Path(job) / 'labels.json', {'labels': []})['labels']}
    calibration = read_json(Path(job) / 'calibration.json', {'markers': []})
    confirmed = [m for m in calibration.get('markers', []) if m.get('confirmed') and len(m.get('corners', [])) == 4]
    if not confirmed:
        return {'status': 'needs_review', 'summary': 'Waiting for scale. Confirm at least one ground marker in Scale calibration.',
                'scale': None, 'features': [], 'warnings': ['Without a confirmed marker there is no scale, so no map geometry is produced.']}
    per_marker = [MARKER_SIDE_M / float(np.mean(sides(m['corners']))) for m in confirmed]
    m_per_px = float(np.median(per_marker))
    spread = float(np.std(per_marker) / m_per_px) if len(per_marker) > 1 else None
    warnings = ['Locally scaled, unreferenced: coordinates are metres from an arbitrary origin, axes follow the reference frame (not north), and perspective, terrain and lens effects are not removed.']
    if len(confirmed) == 1:
        warnings.append('Only one marker is confirmed. Scale is reliable near that marker only; distances far from it may be off.')
    if spread is not None and spread > 0.1:
        warnings.append('Confirmed markers disagree on scale by %.0f%%. This usually means camera tilt, terrain relief or a poor alignment.' % (spread * 100))
    features = []
    for g in merged['merged']:
        poly = np.array(g['polygon'], dtype=np.float64) * m_per_px
        kind = g['kind'] or 'unknown'
        geometry = labels.get(kind, {}).get('geometry', 'area')
        note, width = None, None
        if geometry == 'point':
            M = cv2.moments(poly.astype(np.float32))
            p = [[M['m10'] / M['m00'], M['m01'] / M['m00']]] if M['m00'] else [poly.mean(axis=0).tolist()]
            note = 'Point placed at the region centroid.'
        elif geometry == 'line':
            (cx, cy), (w, h), angle = cv2.minAreaRect(poly.astype(np.float32))
            length, a = (w, angle) if w >= h else (h, angle + 90)
            dx, dy = math.cos(math.radians(a)) * length / 2, math.sin(math.radians(a)) * length / 2
            p = [[cx - dx, cy - dy], [cx + dx, cy + dy]]
            width = round(float(min(w, h)), 2)
            note = 'Line approximated by the long axis of the region; width is %.1f m.' % width
        else:
            p = poly.tolist()
        if width is None and geometry != 'point':
            (_, _), (w, h), _ = cv2.minAreaRect(poly.astype(np.float32))
            width = round(float(min(w, h)), 2)
        features.append({'id': g['id'], 'kind': kind, 'predicted_kind': g['kind'], 'geometry': geometry, 'p': p,
                         'region': poly.tolist(), 'width_m': width,
                         'pixel_polygon': g['polygon'], 'confidence': g['confidence'], 'frames': g['frames'],
                         'flags': g['flags'] + ([] if g['kind'] else ['needs label']), 'note': note,
                         'area_m2': round(polygon_area(poly), 2)})
    allp = np.concatenate([np.array(f['p']) for f in features]) if features else np.zeros((1, 2))
    origin = allp.min(axis=0) - 2
    for f in features:
        f['p'] = [[round(x - origin[0], 3), round(y - origin[1], 3)] for x, y in f['p']]
        f['region'] = [[round(x - origin[0], 3), round(y - origin[1], 3)] for x, y in f['region']]
    extent = (allp.max(axis=0) - origin + 2).round(2).tolist()
    return {'status': 'needs_review', 'summary': '%d proposed features at %.4f m per mosaic pixel from %d marker(s)' % (len(features), m_per_px, len(confirmed)),
            'scale': {'m_per_px': m_per_px, 'markers': len(confirmed), 'spread': spread, 'per_marker': per_marker,
                      'origin_px': (origin / m_per_px).tolist(), 'marker_side_m': MARKER_SIDE_M},
            'extent_m': extent, 'mosaic': merged['mosaic'], 'features': features, 'warnings': warnings}


RUNNERS = {'probe': stage_probe, 'frames': stage_frames, 'correction': stage_correction, 'markers': stage_markers,
           'regions': stage_regions, 'classification': stage_classification, 'merging': stage_merging, 'geometry': stage_geometry}


def run(stage, job):
    if stage not in RUNNERS:
        raise SystemExit('Unknown stage ' + stage)
    started = time.time()
    try:
        result = RUNNERS[stage](job)
    except Unavailable as error:
        result = {'status': 'unavailable', 'summary': str(error), 'reason': str(error), 'warnings': []}
    result['stage'] = stage
    result['seconds'] = round(time.time() - started, 2)
    write_json(Path(job) / 'stages' / stage / 'result.json', result)
    emit('result', status=result['status'], summary=result.get('summary'), warnings=result.get('warnings', []))


if __name__ == '__main__':
    if len(sys.argv) >= 2 and sys.argv[1] == 'capabilities':
        print(json.dumps(capabilities()))
    elif len(sys.argv) == 4 and sys.argv[1] == 'run':
        run(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit(__doc__)
