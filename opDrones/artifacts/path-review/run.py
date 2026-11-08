"""Rerun cached models on the sample without changing the saved intake job."""
import json
import os
import sys
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import numpy as np

root = Path(__file__).resolve().parents[2]
out = Path(__file__).resolve().parent
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', ERFMAP_SAM3='off', ERFMAP_DEEPFOREST='off')
sys.path.insert(0, str(root/'worker'))
from adapters import clip_zones
original = clip_zones.build_zones

def capture(image, probs, size, **kwargs):
    np.savez_compressed(out/'model-evidence.npz', image=image, probs=probs, size=size,
                        **{f'vote_{k}':v for k,v in (kwargs.get('votes') or {}).items()})
    return original(image, probs, size, **kwargs)

clip_zones.build_zones = capture
request = {'captureProfile':json.loads((root/'capture-profile.json').read_text()), 'phase':'zones',
           'frames':[{'id':'scene','image':str(root/'.erfmap-data/intake/e7856f2195a0/stages/correction/mosaic.jpg')}]}
sys.stdin = StringIO(json.dumps(request))
with (out/'updated-result.json').open('w') as output, redirect_stdout(output):
    clip_zones.main()
print('Updated model result and image-space evidence saved.')
