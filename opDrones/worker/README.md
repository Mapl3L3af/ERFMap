# erfMap video-intake worker

The erfMap server (`server.js`) handles uploads, jobs and the review UI. Video processing and computer vision happen in this Python worker. The server runs it once for each pipeline stage, `python worker/erfmap_worker.py run <stage> <job-folder>`, and streams the JSON progress it prints to the browser.

## Setup

1. Install Python 3.10 or later and FFmpeg (`ffmpeg` and `ffprobe` must be on PATH).
2. `pip install -r worker/requirements.txt` (NumPy and OpenCV headless).
3. Start erfMap as usual (`node server.js`) and open **Video Intake** on the front page, or go to `/intake/`. The intake page lists which tools it found.

| Variable | Purpose |
| --- | --- |
| `ERFMAP_PYTHON` | Python command (default `python3`, or `python` on Windows) |
| `ERFMAP_FFMPEG`, `ERFMAP_FFPROBE` | Path to `ffmpeg`/`ffprobe`, or to the folder that holds them. Setting one folder covers both. Otherwise the worker uses PATH and, on Windows, also checks the registry PATH and winget, Chocolatey, Scoop and `C:\ffmpeg\bin` installs. |
| `ERFMAP_SEGMENTER` | Optional command that replaces the colour-clustering region detector (for example a SAM 2 wrapper) |
| `ERFMAP_CLASSIFIER` | Optional command that labels regions (a model trained on erfMap labels) |

Set these before starting the server; the worker inherits the server's environment. If a stage is unavailable, set it up and then use **Retry this stage**.

## Stages and what they really do

| Stage | Implementation | Status without extra setup |
| --- | --- | --- |
| Video & metadata | Video: `ffprobe` (container, codec, resolution, frame rate, rotation, creation time, camera tags, telemetry streams). Photos: size, plus camera, time and GPS-present flags from EXIF when Pillow is installed. GPS tags are never used. | Works. EXIF needs `pip install pillow`. |
| 1. Frame selection | Video: FFmpeg samples up to 60 frames (at most 2 per second). Photos: each photo becomes a frame, downsized to 2000 px on the long side, and only clearly blurry or dark photos are dropped. OpenCV scores sharpness (Laplacian variance), brightness, contrast and edge texture. Frames are flagged as blurry, dark, overexposed, low texture or tilted (bright, featureless sky band). | Works. Tilt is a heuristic because the worker does not parse gimbal telemetry. |
| 2. Image correction | CLAHE contrast equalisation and light denoising, with before/after previews. ORB feature matching and RANSAC homographies chain each video frame to a middle reference frame. Photos can be in any order: every pair is compared (up to 40 photos), the best-connected photo is the reference, and each photo attaches to the aligned photo it matches best. Photos with under about 50% overlap with any other usually fail to align and are left out, with a warning. The result is a planar alignment preview. Lens correction runs only if `camera.json` (`fx`, `fy`, `cx`, `cy`, `dist`) is in the job folder. | Works. Lens correction is unavailable without calibration. The preview is not an orthomosaic. |
| Scale calibration | **Measured distances:** the reviewer clicks two points they measured on the ground (tape measure ends, cones, a parking-space width) and enters the length in ft, in, m or cm. **Square boards** (any size, set in the UI, 1 ft by default) are detected at several thresholds, refined at half contrast with fitted edges, projected into the preview and grouped across frames. Each marker is flagged as blurry, too small (under 24 px), seen in too few frames (under 3) or possibly obscured. The reviewer confirms or corrects the corners, or places markers by hand. | Works. The scale comes only from the distances and corners the reviewer confirms. |
| 3. Region detection | Baseline: k-means colour clustering on up to 10 keyframes, turned into polygons. Or `ERFMAP_SEGMENTER`. | Baseline works. It is not a learned model. |
| 4. Classification | The bundled CLIP zero-shot adapter (`adapters/clip_classifier.py`) runs automatically once `open_clip_torch` is installed, or any command set in `ERFMAP_CLASSIFIER`. Predictions below 0.6 confidence, or with no label, are marked for review. | **Unavailable** until one is installed. Regions stay unlabelled, and the reviewer labels them. |
| 5. Cross-frame merging | Regions are warped into the preview, matched by IoU over 0.3 (one per frame) and merged by majority vote. Label conflicts, varying geometry and single-frame detections are flagged. | Works |
| 6. Map geometry | Metres per preview pixel is the median over confirmed markers and measured distances, and disagreement between them is reported. Areas stay polygons, lines become the long axis of the region and points become centroids, following erfMap's `kinds` geometry. | Works once one scale reference is confirmed |
| 7. Review & export | In the browser: relabel, rename, set an estimated height, move vertices, and accept or reject. Then import into erfMap, download the scenario JSON, or download a `.glb`. | Works |

Every stage writes `stages/<stage>/result.json` and its images under the job folder, `.erfmap-data/intake/<job>/`. The original upload is kept in `original/`. Retrying a stage clears that stage and the ones after it, and keeps earlier results. Rerunning correction or marker detection replaces marker confirmations, because the preview coordinates change.

## Adapter contracts

Both adapters are shell commands. They receive JSON on stdin and must print JSON on stdout. A non-zero exit marks the stage as failed and shows stderr in the UI.

**Classifier** (`ERFMAP_CLASSIFIER`):

```json
// stdin
{"labels": [{"kind": "grass", "label": "Grass", "color": "#b1c990", "geometry": "area"}, ...],
 "regions": [{"id": "R1", "frame": "f0004", "crop": "/abs/path/R1.png", "polygon": [[x, y], ...], "mean_rgb": [r, g, b], "area_px": 1234}]}
// stdout
{"model": {"name": "my-model", "version": "3"}, "predictions": [{"id": "R1", "label": "lawn", "confidence": 0.91}]}
```

Labels are mapped to erfMap kinds through `intake/label-map.json`. A label that already matches a kind needs no entry. Unmapped labels become unknown and are flagged for review. To extend the label set, add kinds to `erfmap-survey/model.js` (the UI reads them from there) and map new model labels in `label-map.json`.

### Free classifier: CLIP zero-shot

```
pip install open_clip_torch pillow
```

Then restart the server. The Classification stage picks it up by itself; the worker status on the intake home page shows it as the classifier. Set `ERFMAP_CLASSIFIER=off` to turn it off, or to any other command to use a different model.

- The first run downloads the model weights from Hugging Face (about 600 MB) and caches them. Later runs work offline.
- It runs on a laptop CPU, a few seconds per batch of 32 regions. No GPU or training needed.
- It only assigns these kinds: grass, water, road, path, tree, bush, building, light and bench. Each has a few text prompts in `PROMPTS` in the adapter ("an aerial photo of a lawn", ...); edit that list to change the set.
- Regions that look like none of them (people, leaves, cars, dirt, shadows, ...) are **omitted**: they are left out of merging and the map, and show as grey dashed outlines on the Classification stage.
- Grass and bushes are mapped only as **large blocks**. Touching regions of the same kind are joined, and blocks under 2% of the frame are omitted (`LARGE_ONLY` and `LARGE_MIN_FRACTION` in `erfmap_worker.py`).
- It is a general-purpose image model, not trained on drone surveys. Expect reasonable results on grass, water, roads, roofs and trees, and treat everything as a proposal.
- `ERFMAP_CLIP_MODEL` and `ERFMAP_CLIP_PRETRAINED` choose another [OpenCLIP model](https://github.com/mlfoundations/open_clip), e.g. `ViT-L-14` / `laion2b_s32b_b82k` for better accuracy at about 3x the time.

`worker/adapters/colour_heuristic_classifier.py` implements this contract with a colour heuristic. It exists only to test the boundary. It reports `"heuristic": true`, caps confidence at 0.5 and is labelled as not a trained model in the UI.

**Segmenter** (`ERFMAP_SEGMENTER`): stdin `{"job": "...", "frames": [{"id": "f0004", "image": "/abs/path.jpg"}]}`. stdout `{"regions": [{"frame": "f0004", "polygon": [[x, y], ...], "score": 0.9}]}`.

## Accuracy and limits

- The output is **locally scaled and unreferenced**: metres from an arbitrary origin, with axes that follow the reference video frame. North is unknown and no geographic coordinate is produced. The scenario records this under `site.localScale`.
- One reference gives scale near itself only. Spread two or three measured distances (or boards) across the site. If they disagree by more than 10%, the UI warns about tilt, relief, a mis-click or a poor alignment.
- A few photos give much less overlap than video. Shoot straight down with about 60% overlap between neighbouring photos; photos that match no other photo are left out of the map.
- The planar alignment assumes a roughly flat site seen from above. Relief, tall objects, oblique views and lens distortion are not removed.
- There is no elevation model. Scenarios have no ground samples, 3D exports are flat, and contours are not offered. Connecting an OpenDroneMap DSM is future work.
- On the synthetic test video, scale from markers is within about 3% of ground truth, and a measured distance between two marker centres within 0.3%. Real footage will vary.

## Tests

- `npm test` runs the Node tests for conversion and GLB export.
- `python -m unittest worker/tests/test_pipeline.py` renders a synthetic flyover with known scale (`worker/tests/make_synthetic_video.py`) and runs every worker stage, once on the video and once on five shuffled stills taken from it.
