#!/usr/bin/env python3
"""Reference classifier adapter: a colour heuristic, NOT a trained model.

It exists to exercise the classifier contract end to end. It looks only at the
mean colour of each region, so it confuses roofs, paths and bare soil, and it
caps confidence at 0.5 so every prediction is flagged for review.

    ERFMAP_CLASSIFIER="python worker/adapters/colour_heuristic_classifier.py"

Contract: read {"labels": [...], "regions": [{"id", "crop", "mean_rgb", ...}]} as
JSON on stdin; print {"model": {...}, "predictions": [{"id", "label", "confidence"}]}.
"""
import colorsys
import json
import sys

request = json.load(sys.stdin)
kinds = {label['kind'] for label in request['labels']}
predictions = []
for region in request['regions']:
    r, g, b = [c / 255 for c in (region.get('mean_rgb') or [128, 128, 128])]
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    if s < 0.15:
        label, confidence = ('road' if v < 0.55 else 'pavement'), 0.35
    elif 0.17 < h < 0.45:
        label, confidence = 'grass', 0.5
    elif 0.45 <= h < 0.7:
        label, confidence = 'water', 0.45
    else:
        label, confidence = 'unknown', 0.2
    if label not in kinds:
        label = 'unknown'
    predictions.append({'id': region['id'], 'label': label, 'confidence': confidence})
json.dump({'model': {'name': 'colour-heuristic', 'version': '1', 'heuristic': True}, 'predictions': predictions}, sys.stdout)
