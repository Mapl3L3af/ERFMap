#!/usr/bin/env python3
"""Fine-tune the existing segmentation head using sparse Studio annotations."""
import base64
import io
import json
import math
import random
import sys
from pathlib import Path
from capture_profile import capture_profile


def rasterize(image, annotations, category_ids, size):
    from PIL import Image, ImageDraw
    mask = Image.new('L', size, 255)
    draw = ImageDraw.Draw(mask)
    sx, sy = size[0] / image.width, size[1] / image.height
    for annotation in annotations:
        label = category_ids[annotation['category_id']]
        points = [(x * sx, y * sy) for x, y in annotation['points']]
        kind = annotation['type']
        # Width/radius are in original-image pixels, then scaled for the mask.
        if kind == 'polygon':
            draw.polygon(points, fill=label)
        elif kind == 'box':
            (x1, y1), (x2, y2) = points
            draw.rectangle((min(x1,x2), min(y1,y2), max(x1,x2), max(y1,y2)), fill=label)
        elif kind == 'polyline':
            draw.line(points, fill=label, width=max(1, round(12 * (sx+sy)/2)))
        elif kind == 'point':
            x, y = points[0]
            rx, ry = max(1, 6*sx), max(1, 6*sy)
            draw.ellipse((x-rx,y-ry,x+rx,y+ry), fill=label)
    return mask


def validate(dataset):
    if dataset.get('format') != 'erfmap-semantic-annotations' or dataset.get('version') != 1:
        raise ValueError('Unsupported training export.')
    categories = {c['id']: c['name'] for c in dataset['categories']}
    if len(categories) != len(dataset['categories']) or not set(categories.values()) <= {'path','building','tree','bench','light','bush','road','grass'}:
        raise ValueError('Unsupported or duplicate training categories.')
    images = {}
    for image in dataset['images']:
        capture_profile(image.get('captureProfile'))
        if image['id'] in images or not isinstance(image['width'], int) or not isinstance(image['height'], int) or min(image['width'],image['height']) < 1:
            raise ValueError('Invalid image dimensions or duplicate image.')
        images[image['id']] = image
    grouped = {key: [] for key in images}
    for a in dataset['annotations']:
        image = images[a['image_id']]
        count = {'point':1, 'box':2, 'polyline':2, 'polygon':3}.get(a['type'])
        points = a['points']
        if a['category_id'] not in categories or count is None or len(points) < count or (a['type'] in ('point','box') and len(points) != count):
            raise ValueError('Invalid annotation geometry or category.')
        for point in points:
            if len(point) != 2 or not all(isinstance(v,(float,int)) and math.isfinite(v) for v in point) or not (0 <= point[0] <= image['width'] and 0 <= point[1] <= image['height']):
                raise ValueError('Annotation outside image.')
        grouped[a['image_id']].append(a)
    if not any(grouped.values()):
        raise ValueError('Add labels before training.')
    return categories, images, grouped


def report(message):
    print(json.dumps({'message':message}), flush=True)


def train(source, destination):
    dataset = json.loads(Path(source).read_text())
    categories, images, grouped = validate(dataset)
    try:
        import numpy as np
        import torch
        from PIL import Image
        from transformers import AutoImageProcessor, AutoModelForSemanticSegmentation
        from adapters.clip_zones import map_labels, SYNONYMS, POINT_SYNONYMS
    except ImportError as error:
        raise RuntimeError('Training needs the server Python environment to have torch, transformers, pillow, numpy and opencv-python-headless. Install worker/training-requirements.txt. ' + str(error)) from error
    import os
    base = os.environ.get('ERFMAP_SEGFORMER_MODEL', 'nvidia/segformer-b2-finetuned-ade-512-512')
    report('Loading SegFormer (first use may download model weights)…')
    processor = AutoImageProcessor.from_pretrained(base, do_reduce_labels=False)
    model = AutoModelForSemanticSegmentation.from_pretrained(base)
    if model.config.model_type != 'segformer':
        raise ValueError('Direct training currently requires a SegFormer model.')
    mapping = map_labels(model.config.id2label, {**SYNONYMS, **POINT_SYNONYMS})
    used = {a['category_id'] for a in dataset['annotations']}
    category_ids = {}
    for category in used:
        candidates = mapping.get(categories[category], [])
        if not candidates:
            raise ValueError('The selected base model has no label for ' + categories[category])
        category_ids[category] = candidates[0]
    # Preserve pretrained classes and train the decoder only, limiting overfitting
    # on small, partially labelled datasets and reducing laptop memory usage.
    for parameter in model.segformer.parameters():
        parameter.requires_grad = False
    device = 'cuda' if torch.cuda.is_available() else ('mps' if torch.backends.mps.is_available() else 'cpu')
    model.to(device)
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad), lr=1e-5)
    records = []
    for key, image in images.items():
        if not grouped[key]:
            continue
        prefix, encoded = image['data_url'].split(',',1)
        if prefix not in ('data:image/png;base64','data:image/jpeg;base64','data:image/webp;base64'):
            raise ValueError('Unsupported image encoding.')
        picture = Image.open(io.BytesIO(base64.b64decode(encoded, validate=True))).convert('RGB')
        if picture.size != (image['width'],image['height']):
            raise ValueError('Exported image dimensions do not match.')
        # Tile at inference resolution to preserve small point labels.
        mask = rasterize(picture, grouped[key], category_ids, picture.size)
        for y in range(0,picture.height,512):
            for x in range(0,picture.width,512):
                bounds = (x,y,min(x+512,picture.width),min(y+512,picture.height))
                tile_mask = mask.crop(bounds)
                if np.any(np.asarray(tile_mask) != 255):
                    records.append((picture.crop(bounds), tile_mask))
    if not records:
        raise ValueError('No labelled pixels remain in the training images.')
    random.seed(42)
    torch.manual_seed(42)
    epochs = 10
    for epoch in range(epochs):
        random.shuffle(records)
        model.train()
        model.segformer.eval()
        total = 0.0
        for index, (picture, mask) in enumerate(records):
            inputs = processor(images=picture, segmentation_maps=mask, do_reduce_labels=False, return_tensors='pt')
            inputs = {k:v.to(device) for k,v in inputs.items()}
            optimizer.zero_grad()
            loss = model(**inputs).loss
            if not torch.isfinite(loss):
                raise ValueError('Training produced an invalid loss; the previous model remains active.')
            loss.backward()
            optimizer.step()
            total += loss.item()
            report(f'Training epoch {epoch+1}/{epochs}, tile {index+1}/{len(records)}')
        report(f'Epoch {epoch+1}/{epochs}: loss {total/len(records):.4f}')
    output = Path(destination)
    output.mkdir(parents=True, exist_ok=True)
    model.cpu().save_pretrained(output)
    processor.save_pretrained(output)
    profiles = {key: capture_profile(image.get('captureProfile')) for key, image in images.items() if grouped[key]}
    (output/'training-summary.json').write_text(json.dumps({'images':len(profiles),'captureProfiles':profiles,'capture_note':'Height is dataset provenance, not an additional neural input. Unknown heights remain unknown. Validate on a separate flight near the deployment height.','tiles':len(records),'epochs':epochs,'base':base,'validation':'Not evaluated on held-out images; review predictions.', 'line_width_px':12,'point_radius_px':6}))
    report('Model saved. Activating…')


if __name__ == '__main__':
    try:
        train(*sys.argv[1:])
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
