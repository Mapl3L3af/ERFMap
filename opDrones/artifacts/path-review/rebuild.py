"""Rebuild path geometry from cached votes; no second model inference is needed."""
import json
import sys
from pathlib import Path
import numpy as np
root=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'worker'))
from adapters import clip_zones
out=Path(__file__).resolve().parent
data=np.load(out/'model-evidence.npz')
result=json.loads((out/'updated-result.json').read_text())
regions=clip_zones.build_zones(data['image'],data['probs'],tuple(int(x) for x in data['size']),votes={k[5:]:data[k] for k in data.files if k.startswith('vote_')})
result['regions']=[{'frame':'scene',**r} for r in regions]
(out/'updated-result.json').write_text(json.dumps(result))
print('Geometry rebuilt from cached model votes.')
