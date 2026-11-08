"""Render image-space path regions and their width-bearing centrelines for review."""
import json
from pathlib import Path
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
JOB = ROOT / '.erfmap-data/intake/e7856f2195a0'
image = cv2.imread(str(JOB/'stages/correction/mosaic.jpg'))
cv2.imwrite(str(OUT/'source.jpg'), image)

def draw(result, title):
    paths = [r for r in result['regions'] if r.get('model_label', r.get('label')) == 'path']
    canvas = image.copy()
    coverage = image.copy()
    for p in paths:
        if p.get('line'):
            cv2.polylines(coverage, [np.round(p['line']).astype(np.int32)], False, (60, 220, 255), max(1, round(p.get('width',1))))
    canvas = cv2.addWeighted(canvas, 0.72, coverage, 0.28, 0)
    for i, p in enumerate(paths):
        poly = np.round(p['polygon']).astype(np.int32)
        cv2.polylines(canvas, [poly], True, (40, 220, 255), 2)
        if p.get('line'):
            line = np.round(p['line']).astype(np.int32)
            cv2.polylines(canvas, [line], False, (240, 30, 220), 4)
            for q in line: cv2.circle(canvas, tuple(q), 5, (255,255,255), -1)
            cv2.putText(canvas, str(i+1), tuple(line[len(line)//2]), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0,0,0), 5)
            cv2.putText(canvas, str(i+1), tuple(line[len(line)//2]), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255,255,255), 2)
    canvas = cv2.resize(canvas, (1000,750), interpolation=cv2.INTER_AREA)
    header = np.full((80,1000,3), 24, np.uint8)
    cv2.putText(header, title+' | '+str(len(paths))+' path pieces', (18,32), cv2.FONT_HERSHEY_SIMPLEX, .75, (255,255,255), 1, cv2.LINE_AA)
    cv2.putText(header, 'Yellow: detected boundary + width   Magenta: fitted centreline', (18,61), cv2.FONT_HERSHEY_SIMPLEX, .55, (210,210,210), 1, cv2.LINE_AA)
    return np.concatenate([header,canvas]), len(paths)

before = json.loads((JOB/'stages/regions/result.json').read_text())
after = json.loads((OUT/'updated-result.json').read_text())
a, n = draw(before, 'Saved result')
height=after.get('model',{}).get('captureProfile',{}).get('height_agl_m','unknown')
b, m = draw(after, 'Updated result - '+str(height)+' m nominal')
cv2.imwrite(str(OUT/'before.png'),a)
cv2.imwrite(str(OUT/'after.png'),b)
cv2.imwrite(str(OUT/'comparison.png'),np.concatenate([a,b],axis=1))
(OUT/'review.json').write_text(json.dumps({'saved_path_pieces':n,'updated_path_pieces':m,'source':'Existing single-image flyover e7856f2195a0','comparison':'Saved inference versus rerun using updated capture prompt and path geometry; not a controlled accuracy benchmark.','height':str(height)+' m nominal assumption, not verified from telemetry.','legend':'Yellow boundary and stroke show detected area/estimated width; magenta is the fitted centreline.','accuracy':'No held-out path annotations; inspect missed paths and false detections visually.'},indent=2))
print('saved pieces:',n,'updated pieces:',m)
