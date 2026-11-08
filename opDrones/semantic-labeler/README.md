# Semantic Studio

Start erfMap with `npm start`, then open http://localhost:3000/semantic-labeler/.

Install training dependencies once in the Python environment used by the server:

```sh
.venv/bin/python -m pip install -r worker/training-requirements.txt
```

The server uses `ERFMAP_PYTHON`, the project's `.venv`, or `python3` in that order.

1. Add PNG, JPEG or WebP aerial images.
2. Choose a class and draw boxes, polylines, dots or polygons. Buildings default to polygons: click around the building footprint, then press Enter or double-click to finish. Enter or double-click also finishes a line; Escape cancels.
   Label vegetation with a visible tree canopy as **Tree**; vegetation without a tree canopy is **Bush**. Bushes and benches default to dots; use polygons to label their full footprint for training.
3. Use **Save project** for a portable backup. Browser autosave uses IndexedDB.
4. Click **Export & train**. This downloads `semantic-training-data.json` as a backup, uploads the images and labels to the erfMap server, and starts local SegFormer fine-tuning. Progress and errors appear below the image. Reloading reconnects to training progress.
5. Successful training automatically activates the saved model for new analyses, including after server restarts. Existing analysis results need to be reevaluated. Training failure leaves the previous model active.

The first training run may download the pretrained SegFormer checkpoint. Training uses CUDA, Apple MPS or CPU, takes ten epochs, and freezes the encoder while tuning the decoder. Each export fine-tunes the currently selected model; avoid repeatedly exporting unchanged labels. Models and dataset snapshots are retained under `.erfmap-data/training/` (or `ERFMAP_DATA/training/`). One training job runs at a time. Stopping the server interrupts training; export again to retry.

Annotations are sparse supervision: unmarked pixels are ignored, boxes fill their rectangles, polygons fill their boundaries, lines use a 12-original-pixel width and dots a 6-original-pixel radius. For accurate outlines, use polygons. The existing pretrained class labels and classifier head are preserved; a custom base model must contain matching class names. Training success means the weights were saved, not that prediction accuracy improved. Review predictions; this workflow does not yet compute held-out validation metrics.

## Export format

`semantic-training-data.json` contains `categories`, `images`, and `annotations`. Original images are embedded as data URLs. Annotations have `image_id`, `category_id`, `type`, and `points` in original image pixels, with origin at top-left. Boxes contain two opposite corners; polylines contain ordered vertices; dots contain one point; polygons close implicitly.

Opening `index.html` directly or serving this folder with a standalone static server supports annotation and backup exports only. Automatic training requires the erfMap server and `/api/training`.

## Drone mapping and terrain

The project direction is overlapping DJI Neo 2 imagery → SfM reconstruction → classified 3D surfaces → relative ground contours. See [the mapping plan](MAPPING-PLAN.md) for the intended pipeline, integration requirements, and acceptance criteria. Current intake remains planar with a flat GLB; semantic training does not reconstruct elevation.

Road (category 7) and Grass (category 8) now support polygon supervision alongside the existing classes. Studio reports labelled image and class counts and blocks training with no annotations. Use polygons for road width, grass surfaces and tree canopy boundaries. Keep a separate flight/site for evaluating predictions; neighbouring overlapping views are not independent validation. Intake still assigns grass as the residual zone, so a grass polygon is not proof of exposed terrain.
