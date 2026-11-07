#!/usr/bin/env python3
"""Render a synthetic nadir "drone" pass over a drawn site, for testing the pipeline.

The output is test data with known ground truth: 120 px per metre on the ground
plane, three 1 ft (0.3048 m) white marker boards with a black centre, and a few
deliberately bad frames (motion blur, darkness). It is not a real survey.

    python worker/tests/make_synthetic_video.py out.mp4
"""
import subprocess
import sys

import cv2
import numpy as np

PX_PER_M = 120
W_M, H_M = 40, 16
MARKERS_M = [(6, 6.5), (19, 8), (34, 6)]


def ground():
    rng = np.random.default_rng(7)
    h, w = H_M * PX_PER_M, W_M * PX_PER_M
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = (70, 140, 80)                                       # grass (BGR)
    noise = rng.normal(0, 18, (h, w, 1)).astype(np.int16)
    img = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    m = lambda x: int(x * PX_PER_M)
    cv2.rectangle(img, (0, m(13)), (w, m(16)), (110, 112, 115), -1)                 # road
    cv2.rectangle(img, (m(24), m(2)), (m(31), m(7.5)), (120, 165, 205), -1)        # building roof
    cv2.ellipse(img, (m(12), m(9)), (m(4), m(2.2)), 0, 0, 360, (170, 120, 60), -1)  # pond
    cv2.line(img, (0, m(11.5)), (w, m(11.5)), (175, 205, 220), m(1.2))            # footpath
    texture = rng.normal(0, 10, (h, w, 1)).astype(np.int16)
    img = np.clip(img.astype(np.int16) + texture, 0, 255).astype(np.uint8)
    side = round(0.3048 * PX_PER_M)            # 37 px: the board edge, within 1.2% of 1 ft
    for x, y in MARKERS_M:
        x0, y0 = int(x * PX_PER_M) - side // 2, int(y * PX_PER_M) - side // 2
        img[y0:y0 + side, x0:x0 + side] = (250, 250, 250)
        q = side // 4
        img[y0 + q:y0 + side - q, x0 + q:x0 + side - q] = (15, 15, 15)
    return img


def main(path):
    site = ground()
    view_w, view_h = 1600, 900
    frames = 150
    ff = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', '1280x720', '-r', '15',
                           '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', 'make=Synthetic',
                           '-metadata', 'model=erfMap test renderer', path], stdin=subprocess.PIPE)
    for i in range(frames):
        t = i / (frames - 1)
        x0 = int(t * (site.shape[1] - view_w))
        y0 = int((site.shape[0] - view_h) / 2 + 60 * np.sin(t * 3))
        angle = 4 * np.sin(t * 2)
        M = cv2.getRotationMatrix2D((x0 + view_w / 2, y0 + view_h / 2), angle, 1.0)
        M[:, 2] -= (x0, y0)
        view = cv2.warpAffine(site, M, (view_w, view_h), borderValue=(40, 40, 40))
        view = cv2.resize(view, (1280, 720), interpolation=cv2.INTER_AREA)
        if 40 <= i < 46:
            view = cv2.filter2D(view, -1, np.ones((1, 25), np.float32) / 25)   # motion blur
        if 100 <= i < 106:
            view = (view * 0.18).astype(np.uint8)                            # under-exposed
        ff.stdin.write(view.tobytes())
    ff.stdin.close()
    ff.wait()


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'synthetic-flyover.mp4')
