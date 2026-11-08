#!/usr/bin/env python3
"""Zero-shot classifier adapter: CLIP compares each region crop with text prompts.

No training is needed. Each erfMap kind that is visible from the air gets a few
phrases ("an aerial photo of a lawn", ...); the crop is labelled with the kind
whose phrases match best, and the softmax probability is the confidence.

It is a general-purpose image model, not one trained on drone surveys: expect
it to be reasonable on large surfaces (grass, water, roads, roofs, trees) and
unreliable on small objects. Low-confidence results are flagged for review.

    pip install open_clip_torch pillow
    # The worker uses this adapter automatically when open_clip is installed.
    # To choose it explicitly: ERFMAP_CLASSIFIER="python worker/adapters/clip_classifier.py"

Settings: ERFMAP_CLIP_MODEL (default ViT-B-32), ERFMAP_CLIP_PRETRAINED
(default laion2b_s34b_b79k). The weights (about 600 MB) download from Hugging
Face on first use and are cached.

Contract: read {"labels": [...], "regions": [{"id", "crop", ...}]} as JSON on
stdin; print {"model": {...}, "predictions": [{"id", "label", "confidence"}]}.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from capture_profile import DEFAULT_PROFILE, capture_profile, prompt_templates

# The only erfMap kinds this classifier assigns. Every region gets the closest
# of these; nothing is left out. Edit this to change the set.
PROMPTS = {
    'building': ['a building roof', 'a rooftop', 'a house roof'],
    'grass': ['a lawn', 'mowed grass', 'a grassy field'],
    'tree': ['a tree with a visible canopy', 'a tree crown', 'a leafy tree canopy'],
    'path': ['a concrete sidewalk', 'a footpath', 'a paved walkway'],
    'road': ['an asphalt road', 'a parking lot', 'an asphalt driveway'],
    'light': ['a lamp post', 'a street light seen from above'],
    'bush': ['a bush', 'a shrub without a tree canopy', 'bare woody vegetation without a canopy'],
    'bench': ['a park bench', 'a bench'],
}
# Most of a site is grass, path or road, so those start more likely. Buildings,
# trees, lamp posts and benches sit on top of them.
PRIOR = {'grass': 3.0, 'path': 3.0, 'road': 3.0}
TEMPLATES = prompt_templates(DEFAULT_PROFILE)
MIN_SIDE = 4        # px; anything smaller has no pixels to compare


def main():
    request = json.load(sys.stdin)
    profile = capture_profile(request.get('captureProfile'))
    templates = prompt_templates(profile)
    import numpy as np
    import open_clip
    import torch
    from PIL import Image

    available = {l['kind'] for l in request['labels']}
    kinds = [k for k in PROMPTS if k in available]
    prompts = {k: PROMPTS[k] for k in kinds}
    classes = list(prompts)
    name = os.environ.get('ERFMAP_CLIP_MODEL', 'ViT-B-32')
    weights = os.environ.get('ERFMAP_CLIP_PRETRAINED', 'laion2b_s34b_b79k')
    print('Loading CLIP %s (%s)' % (name, weights), file=sys.stderr)
    try:
        model, _, preprocess = open_clip.create_model_and_transforms(name, pretrained=weights or None)
    except Exception as e:
        sys.exit('Could not load CLIP %s (%s). The first run needs internet to download the weights from Hugging Face. %s' % (name, weights, str(e)[-300:]))
    tokenizer = open_clip.get_tokenizer(name)
    model.eval()
    torch.set_grad_enabled(False)

    # One averaged text embedding per kind.
    text = []
    for kind in classes:
        phrases = [t.format(p) for p in prompts[kind] for t in templates]
        e = model.encode_text(tokenizer(phrases))
        e = e / e.norm(dim=-1, keepdim=True)
        e = e.mean(dim=0)
        text.append(e / e.norm())
    text = torch.stack(text)
    prior = torch.tensor([PRIOR.get(k, 1.0) for k in classes])

    predictions, batch, ids = [], [], []

    def flush():
        if not batch:
            return
        e = model.encode_image(torch.stack(batch))
        e = e / e.norm(dim=-1, keepdim=True)
        probs = (100.0 * e @ text.T).softmax(dim=-1) * prior
        probs = probs / probs.sum(dim=-1, keepdim=True)
        for rid, p in zip(ids, probs):
            i = int(p.argmax())
            predictions.append({'id': rid, 'label': classes[i], 'confidence': round(float(p[i]), 3),
                                'scores': {k: round(float(v), 3) for k, v in zip(classes, p) if v >= 0.05}})
        batch.clear()
        ids.clear()

    for region in request['regions']:
        path = region.get('crop')
        if not path or not os.path.exists(path):
            predictions.append({'id': region['id'], 'label': None, 'confidence': None})
            continue
        image = Image.open(path).convert('RGB')
        if min(image.size) < MIN_SIDE:
            predictions.append({'id': region['id'], 'label': None, 'confidence': None})
            continue
        # The worker masks pixels outside the region to black. Fill them with the
        # region's mean colour so CLIP is not looking at a black frame.
        a = np.asarray(image).copy()
        outside = a.max(axis=2) == 0
        if outside.any() and not outside.all():
            a[outside] = a[~outside].mean(axis=0).astype(np.uint8)
        batch.append(preprocess(Image.fromarray(a)))
        ids.append(region['id'])
        if len(batch) == 32:
            flush()
    flush()
    json.dump({'model': {'name': 'CLIP zero-shot ' + name, 'version': weights or 'untrained',
                         'captureProfile': profile,
                         'note': 'General-purpose image model with capture-height text context; not evidence of training at that height. Scale still requires a measured ground reference.'},
               'predictions': predictions}, sys.stdout)


if __name__ == '__main__':
    main()
