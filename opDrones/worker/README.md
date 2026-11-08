# erfMap video-intake worker

The erfMap server (`server.js`) handles uploads, jobs and the review UI. Video processing and computer vision happen in this Python worker. The server runs it once for each pipeline stage, `python worker/erfmap_worker.py run <stage> <job-folder>`, and streams the JSON progress it prints to the browser.

## Setup

1. Install Python 3.10 or later and FFmpeg (`ffmpeg` and `ffprobe` must be on PATH).
2. Create a project environment from the `opDrones` folder: `python3 -m venv .venv` (use Python 3.10+), then `.venv/bin/python -m pip install -r worker/requirements.txt` (NumPy, OpenCV headless and Pillow). On Windows use `python -m venv .venv` and `.venv\Scripts\python -m pip install -r worker/requirements.txt`.
3. Start erfMap as usual (`node server.js`) and open **New Flyover** on the front page, or go to `/intake/`. The intake page lists which tools it found.

| Variable | Purpose |
| --- | --- |
| `ERFMAP_PYTHON` | Python command. Defaults to the project's `.venv` interpreter when present, otherwise `python3` (`python` on Windows). An explicit override takes precedence. |
| `ERFMAP_FFMPEG`, `ERFMAP_FFPROBE` | Path to `ffmpeg`/`ffprobe`, or to the folder that holds them. Setting one folder covers both. Otherwise the worker uses PATH and, on Windows, also checks the registry PATH and winget, Chocolatey, Scoop and `C:\ffmpeg\bin` installs. |
| `ERFMAP_SEGMENTER` | Optional command that replaces the colour-clustering region detector (for example a SAM 2 wrapper) |
| `ERFMAP_CLASSIFIER` | Optional command that labels regions (a model trained on erfMap labels) |

Set these before starting the server; the worker inherits the server's environment. If a stage is unavailable, set it up and then use **Retry this stage**.

## Stages and what they really do

| Stage | Implementation | Status without extra setup |
| --- | --- | --- |
| Video & metadata | Video: `ffprobe` (container, codec, resolution, frame rate, rotation, creation time, camera tags, telemetry streams). Photos: size, plus camera, time and GPS-present flags from EXIF when Pillow is installed. GPS tags are never used. | Works. EXIF needs `pip install pillow`. |
| 1. Frame selection | Video: FFmpeg processes the full video in 30-second extraction sections at up to 2 frames per second, preserving up to 1080 px of image height. There is no whole-video frame cap; every aligned usable frame is analyzed. Longer videos require more processing time and storage. Photos: each photo becomes a frame, downsized to 2000 px on the long side, and only clearly blurry or dark photos are dropped. OpenCV scores sharpness (Laplacian variance), brightness, contrast and edge texture. Frames are flagged as blurry, dark, overexposed, low texture or tilted (bright, featureless sky band). | Works. Tilt is a heuristic because the worker does not parse gimbal telemetry. |
| 2. Image correction | CLAHE cleanup and denoising, then ORB/RANSAC planar alignment. Overlapping photos are matched in any order and stitched into one scene; disconnected photos stop with an explanation instead of inventing adjacency. Video frames are chained to a middle reference. | Lens correction needs camera.json. This is a planar stitch, not an orthomosaic. |
| Scale calibration | Select the two endpoints of one line segment on the assembled scene and specify its known length. That distance sets metres per pixel. | Required before map review. |
| 3. Region detection | Classify the assembled scene once. The model council proposes zones and tree locations; candidate shadows are detected from local luminance. Without models, colour clusters remain unlabelled for correction. Benches and lights wait for zone approval. | CLIP or SegFormer enables automatic zone labels. |
| 4. Classification | The bundled CLIP zero-shot adapter (`adapters/clip_classifier.py`) runs automatically once `open_clip_torch` is installed, or any command set in `ERFMAP_CLASSIFIER`. Predictions below 0.6 confidence, or with no label, are marked for review. | **Unavailable** until one is installed. Regions stay unlabelled, and the reviewer labels them. |
| 5. Cross-frame merging | Regions are warped into the preview, matched by IoU over 0.3 (one per frame) and merged by majority vote. Label conflicts, varying geometry and single-frame detections are flagged. | Works |
| 6. Map geometry | Convert scene polygons, path centre lines and tree points to local metres using the confirmed scene scale. | Approximate, unreferenced, no measured elevation. |
| 7. Review & export | Repeat zone corrections until satisfied, approve dots next, then confirm building entrances and edge access. Import and downloads require completed review and connected path terminals. | Reviewer decisions are persisted. |

Every stage writes `stages/<stage>/result.json` and its images under the job folder, `.erfmap-data/intake/<job>/`. The original upload is kept in `original/`. Retrying a stage clears that stage and the ones after it, and keeps earlier results. Rerunning correction or marker detection replaces marker confirmations, because the preview coordinates change.

## Scene review

New jobs use one stitched scene. Older saved jobs retain their independent photo calibration and export behavior; start a new intake for the new workflow.

1. Review buildings, grass, paths and tree locations. Accepting a building locks its exact footprint during refinement. A correction click states the correct category, including changing something wrongly classified; connected similar colours select a local region. Reevaluate applies all zone corrections and reruns square building and path geometry. Repeat as needed. Vertex dragging remains available for precise boundaries.
2. Shade and tree canopies are occlusion evidence. Similar-width path fragments facing each other can bridge a longer gap when at least half the gap is occluded, with buildings treated as barriers. Candidate shade is a brightness heuristic, not an astronomical model; coordinates, season and capture time are not used. User shade marks also guide these joins.
3. Approve all zone/tree decisions to run the bundled model council for bench and light dots. Without the optional models, add dots manually. Mark missing objects or remove wrong dots, reevaluate, then approve or reject each proposal.
4. Edge path ends receive proposed NPC spawn/leave markers. Mark actual doors on accepted building outlines; nearby path terminals connect to the door. Other interior endpoints are highlighted. Drag their vertices to a confirmed entrance, junction or scene edge. Path ends within 5% of the scene boundary extend to that edge. Only edge access markers must be accepted before import; interior endpoints and building entrances are optional. Return to an earlier review step when needed.

Refinement is image-guided postprocessing of the proposals, not model retraining. New or changed proposals need acceptance again. Correction history and decisions are stored with the job. Re-running a pipeline stage clears review decisions because feature IDs and geometry may change.

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

### Free labelling: a council of models, zones then points

```
pip install open_clip_torch pillow      # CLIP: zones, lamp posts, benches
pip install transformers                # SegFormer: a per-pixel scene model (zones, benches, street lights)
pip install deepforest                  # DeepForest: tree crowns, trained on aerial and drone imagery
```

Install any of them; the ones that are missing sit out (the run's model note lists who voted). Restart the server and region detection and classification pick it up by themselves. All are free and run on your own computer; each downloads its weights from Hugging Face on first use (CLIP about 600 MB, SegFormer b2 about 100 MB, DeepForest about 130 MB).

How the council votes (`adapters/clip_zones.py`):
- **Zones:** CLIP and SegFormer each give every pixel a probability for building, path, road, grass and tree. They are averaged with `WEIGHTS`. SegFormer's own labels are mapped by name (`SYNONYMS`); where it sees something we don't map (sky, water) it does not vote there. DeepForest crowns pull their pixels towards tree (`TREE_WEIGHT`).
- **Trees:** with DeepForest installed, each detected crown (score at least `TREE_MIN`) becomes a tree point. Without it, crowns are found in the combined tree scores.
- **Lamp posts and benches:** one member must be at least 0.6 sure; the confidence is the average of every member's score at that spot, so a lone vote ends up in review.
- Each zone and point keeps every member's score (`votes`). Where members differ by more than 30 points the feature is flagged "models disagree" in Review.

Swap or leave out members with `ERFMAP_CLIP=off`, `ERFMAP_SEGFORMER=off`, `ERFMAP_DEEPFOREST=off`, `ERFMAP_SEGFORMER_MODEL` (any Hugging Face semantic segmentation model, for example one trained on aerial imagery; its label names are matched through `SYNONYMS`), `ERFMAP_DEEPFOREST_MODEL`, `ERFMAP_CLIP_MODEL` and `ERFMAP_CLIP_PRETRAINED`.

None of these models was trained on this kind of site: SegFormer's default (ADE20K) is ground-level scenes and CLIP is web photos. DeepForest expects about 10 cm per pixel, so it suits drone photos better than satellite images. On satellite images (30 to 50 cm per pixel) benches and lamp posts are a few pixels and will mostly be missed.

Zones and points are then built in two stages:

1. **Zones (polygons), in priority order.** A grid of overlapping windows is scored by CLIP as building, path, road, grass or tree, and the scores are smoothed with an edge-aware (guided) filter so boundaries move onto visible edges instead of following the window grid. Each building, path and road then flows along its own colour for a short distance (`fit_to_colour`), so curves and visible ends are followed, and outlines are rounded slightly. A per-photo greenness check (`vegetation`, excess green with an automatic threshold) keeps buildings, paths and roads off green pixels, so coarse scores cannot spread paving over lawns.
   - Buildings are reserved first, each traced as its own footprint.
   - Paths and roads come next, as separate classes covering their full width. Gaps along them are closed so they stay continuous through bends and junctions, and a zone that touches the photo edge is carried exactly to the edge. A path that ends inside the photo stops there.
   - Grass is the fallback for everything left. A path or road that crosses a lawn splits it into separate grass polygons, and a lawn around a building keeps a hole for it, so zones never overlap.
   A higher-priority class wins where its score is within 80% of the best (`PRIORITY`). Buildings are squared up: each side is a best-fit straight line along or across the building's main direction, and sides meet at 90 degrees (`square_up`). Most roofs have a frame, a straight edge around the outside: long straight edges on bare ground are found (`frame_edges`), a bare, rectangular, not path-thin area whose outline mostly sits on them becomes a building even when the scores only lean that way (`framed`, `FRAME_LEAN`), and a building side with a frame edge along it is pinned to that edge. Paths are exported as erfMap `path` lines: the centre line is traced (`thin`, `trace`), split into straight segments, each a least-squares line (`fit_polyline`), carried to the photo edge where the path leaves it, and given the path's average width. Paths broken by shade, a tree or a coarse score are joined (`connect_paths`): two ends that point at each other within 35 degrees and 15% of the photo are joined into one line and the gap is filled in as path, and an end pointing at the side of another path within three path widths is carried on to meet it. Gaps never cross a building.
2. **Points.** Trees (from tree-dominated areas, one per crown), lamp posts and benches each become one point at their visible location. A lamp post or bench needs at least 0.6 and twice the best surface score (`POINT_MIN`, `POINT_MARGIN`), so expect to add some by hand. A point never changes the zone under it.

Zones are kept as drawn through merging (no joining or hole filling). An area with holes is stored as one outline with a zero-width cut to each hole, which the GLB export triangulates correctly. `worker/tests/test_zones.py` checks the behaviour on a synthetic scene.

Notes:
- The first run downloads the model weights from Hugging Face (about 600 MB) and caches them. Later runs work offline.
- On a laptop CPU it takes about 30 to 40 seconds per photo (or video keyframe). No GPU or training is needed.
- Zones come first in the output and points after, so points sit on top.
- It is a general-purpose image model, not trained on drone surveys. Treat everything as a proposal and check it in Review.
- `ERFMAP_ZONES=off` turns the zones pass off and falls back to colour clustering plus the region classifier (`adapters/clip_classifier.py`, same 7 kinds). `ERFMAP_CLIP_MODEL` and `ERFMAP_CLIP_PRETRAINED` choose another [OpenCLIP model](https://github.com/mlfoundations/open_clip).

`worker/adapters/colour_heuristic_classifier.py` implements this contract with a colour heuristic. It exists only to test the boundary. It reports `"heuristic": true`, caps confidence at 0.5 and is labelled as not a trained model in the UI.

**Segmenter** (`ERFMAP_SEGMENTER`): stdin `{"job": "...", "frames": [{"id": "f0004", "image": "/abs/path.jpg"}]}`. stdout `{"regions": [{"frame": "f0004", "polygon": [[x, y], ...], "score": 0.9}]}`.

## Accuracy and limits

- The output is **locally scaled and unreferenced**: metres from an arbitrary origin, with axes that follow the reference video frame. North is unknown and no geographic coordinate is produced. The scenario records this under `site.localScale`.
- One distance calibrates scale **near the measured segment** only. Perspective, camera tilt, terrain and lens distortion make sizes elsewhere in the photo approximate. Measure something long (at least a tenth of the photo's width), away from the edges, ideally near the features you care about.
- Overlapping photos are stitched with planar homographies. Weak overlap stops scene assembly. Perspective, relief and parallax can still distort the assembled scene; sizes remain approximate, with no geographic coordinates or measured heights.
- The planar alignment assumes a roughly flat site seen from above. Relief, tall objects, oblique views and lens distortion are not removed.
- There is no elevation model. Scenarios have no ground samples, 3D exports are flat, and contours are not offered. Connecting an OpenDroneMap DSM is future work.
- On the synthetic test video, scale from markers is within about 3% of ground truth, and a measured distance between two marker centres within 0.3%. Real footage will vary.

## Tests

- `npm test` runs the Node tests for conversion and GLB export.
- `.venv/bin/python -m unittest discover -s worker/tests -v` runs scene stitching, correction, occlusion and pipeline tests. The pipeline suite renders a synthetic flyover with known scale (`worker/tests/make_synthetic_video.py`) and runs every worker stage, once on the video and once on five shuffled stills taken from it.

### Sketch-guided review and SAM 3

Review opens with drawing tools. Drag a rough path centre line and choose its search corridor size. For buildings, click approximate corners and choose **Finish outline**. Recalculate reruns image inference: these marks bias model evidence, rather than forcing polygons. Accepted buildings remain constraints. In point review, outline a representative bench or light and recalculate to search again.

The optional SAM 3 member supports these bench/light outlines as positive visual exemplars. Enable with `ERFMAP_SAM3=on` in the server environment after installing a Transformers release exposing `Sam3Model` and `Sam3Processor` plus PyTorch, and obtaining access to `facebook/sam3` on Hugging Face. Model loading downloads weights on first use. CUDA, Apple MPS and CPU are selected in that order. No hosted inference service is used. `ERFMAP_SAM3_MODEL` overrides the checkpoint. SAM 3 is not enabled or downloaded by default; without it, the existing council uses category detection and soft zone guidance, but does not learn appearance from example outlines. All results require review. See https://huggingface.co/docs/transformers/model_doc/sam3.

Tree proposals now require stronger class/detector confidence, foliage coverage and local crown texture. Uniform lawn is suppressed. These conservative thresholds may miss small, low-contrast or leafless trees; validate against labelled site imagery before treating counts as accurate. The guidance plumbing is tested with synthetic/mocked outputs. SAM 3 inference itself has not been run or benchmarked on this site's imagery.

Tree marker placement refines proposals against local foliage colour and distance
from the crown boundary before converting them to original-photo coordinates.
This helps offset boxes land inside the visible crown rather than on its edge.
If the detector returns no usable crowns, semantic crown detection remains active.
Fallback marker size follows the measured canopy radius, and refined duplicate
points are suppressed. These checks use RGB imagery; they estimate the visible
crown centre, not a measured treetop height. Rerun analysis to update old markers.
