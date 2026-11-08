"""Review new inference on a saved source photo without changing the intake job."""
import json
import os
import sys
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import cv2
import numpy as np

root = Path(__file__).resolve().parents[2]
out = Path(__file__).resolve().parent
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', ERFMAP_SAM3='off', ERFMAP_DEEPFOREST='off')
sys.path.insert(0, str(root/'worker'))
from adapters import clip_zones
capture = clip_zones.build_zones

def record(image, probs, size, **kwargs):
    np.savez_compressed(out/'evidence.npz', image=image, probs=probs, size=size)
    return capture(image, probs, size, **kwargs)

clip_zones.build_zones = record
source = root/'.erfmap-data/intake/e7856f2195a0/stages/frames/f0001.jpg'
request = {'captureProfile':json.loads((root/'capture-profile.json').read_text()), 'phase':'zones', 'frames':[{'id':'scene','image':str(source)}]}
sys.stdin = StringIO(json.dumps(request))
with (out/'result.json').open('w') as output, redirect_stdout(output):
    clip_zones.main()
result = json.loads((out/'result.json').read_text())
image = cv2.imread(str(source))
for p in result['regions']:
    if p.get('label') != 'path':
        continue
    cv2.polylines(image, [np.round(p['polygon']).astype(np.int32)], True, (40,220,255), 2)
    cv2.polylines(image, [np.round(p['line']).astype(np.int32)], False, (240,30,220), 3)
cv2.imwrite(str(out/'review.png'), image)
(out/'README.md').write_text('Natural source photo, higher-resolution tiled inference and updated path geometry. Yellow: detected boundaries. Magenta: centre lines. No held-out boundary annotations are available; this is a visual review, not an accuracy benchmark. Existing intake results are unchanged.\n')
print('Saved inference and review overlay.')
