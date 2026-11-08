# erfMap

Run `node server.js` with Node 20 or later, or double-click **Start erfMap.command** on macOS or **Start erfMap.cmd** on Windows. The app has no package installation step. Open the localhost address printed in the terminal. Teammates on the same network should use the network address printed there.

**New Flyover** opens the video and photo intake flow. **Open Project** imports an exported scenario JSON, a raw survey, or a supported GeoJSON FeatureCollection. Importing creates a saved project. **Join Project** opens an existing project on this server using its four digit code. Four people can edit at once. Keep the server running while collaborating.

Projects are saved under `.erfmap-data/`. Back up this directory to preserve projects and their codes. `ERFMAP_DATA`, `PORT`, and `HOST` override the storage location, port (3000), and listening address. For remote teams, serve one instance on a shared HTTPS address with persistent storage and unbuffered event streams. Anyone with a project code and access to the server can edit that project.

Edits to different features merge. For changes to the same feature, the last edit accepted by the server wins. Movement uses direct WebRTC data channels when available and otherwise travels through the server.

## Video and photo intake (drone imagery without GPS)

There is no fixed capture height. Each flyover is described by the ground detail measured from its own photos or frames (metres per pixel after calibration), so any overhead imagery is accepted. A height is recorded only when supplied for that flyover. Capture context follows detection, review and export; it never replaces measured scale or supplies terrain elevation. Older jobs that carried the retired 25 m assumption are treated as unknown height.

For optional map assistance, open **Source imagery → Map reference → Advanced · Map reference**. Match at least two known ground coordinates to their positions in the assembled image, then import building/path KML or GeoJSON. A third control point checks alignment. Reference geometry guides classification and retains its source in exports; explicit ground elevations can check relative terrain when a reconstructed grid exists. This is a local import workflow; live Google lookups are not configured. Saving a reference reprocesses proposals and replaces the current feature review.

**New Flyover** on the front page (or `/intake/`) assembles overlapping overhead photos or video frames into one scene. Confirm a measured ground distance, then review building, grass and path zones. Mark correction points and reevaluate as often as needed; accepted building footprints stay fixed and tree/shadow evidence helps bridge false path breaks. Approve zones before reviewing bench and light dots. Finally mark building entrances and accept NPC access at scene-edge path ends. Unresolved interior path ends block import. Finished reviews can be imported as an erfMap project or downloaded as scenario JSON or a `.glb` model (terrain-aware when ground data is supplied). Results are locally scaled and unreferenced.

Processing needs Python 3.10+, FFmpeg and the packages in `worker/requirements.txt`. `Start erfMap.command` creates `.venv` and installs or refreshes those packages on first launch or when the requirements change; this includes rasterio for the NodeODM reconstruction adapter. An external NodeODM service is still needed to run photogrammetry. Without Python dependencies, uploads are still kept and the affected stages show as unavailable. For automatic labels, `pip install open_clip_torch` adds a free CLIP zero-shot classifier (about 600 MB download on first use). Without it, regions are labelled by hand during review. See `worker/README.md` for setup, the adapter contracts and the limitations. Intake jobs are stored under `.erfmap-data/intake/`.

The proposed map-led review redesign is documented in [`docs/review-sequence-redesign.md`](docs/review-sequence-redesign.md).

## Train on your own labels

Open `/semantic-labeler/` on the erfMap server, label your aerial images, and choose **Export & train**. This exports a backup, fine-tunes SegFormer locally, and automatically activates the saved model for new analyses. Install `worker/training-requirements.txt` in the server Python environment first. See `semantic-labeler/README.md` for setup and annotation assumptions.

## Drone 3D mapping direction

The project targets low-cost mapping from overlapping DJI Neo 2 photographs: photogrammetry and Structure from Motion (SfM) for a point cloud and textured mesh, semantic labels for buildings, roads, grass and trees, and relative terrain contours in an interactive map. This is the development objective; today's intake uses planar stitching and a flat feature-based GLB, without a bundled SfM engine. Registered ground grids from the reconstruction adapter or the survey’s File → Import ground grid flow support terrain-aware 3D and relative contours.

The reconstruction integration requirements and model training guidance are in [the mapping plan](semantic-labeler/MAPPING-PLAN.md). Semantic Studio now includes explicit road and grass training polygons alongside the existing object classes. Labels improve semantic supervision; they do not supply depth measurements. Training completion alone is not evidence of improved accuracy.

## Field guide, terrain and portable 3D

**Info** opens `/info.html`: capture guidance, review steps, formats, processing capabilities and recovery instructions. The guide includes a ground-grid JSON example.

In the survey, **File → Import ground grid** accepts `erfmap-ground-grid-v1` JSON with metre units, source provenance and a regular grid registered to the local map. **Settings → Contour spacing** controls relative contour intervals (up to 200 levels). **Analyse → Elevation map** measures profiles. Ground grids preserve missing observations; terrain triangles and contours only cover cells with four valid corners. Older scattered sample surveys still use interpolated terrain.

**File → Download 3D model** exports the current edited survey, terrain and visible contours as GLB. Embedded scenario data allows this GLB to reopen through **Open Project** or **Import survey**. Generic third-party GLBs are not accepted as editable surveys. Ground and feature materials use category colors; this export is not a photorealistic reconstructed mesh. **Download contours** exports local-coordinate contour segments and provenance as JSON, not WGS84 GeoJSON.

Automatic reconstruction can now use a local NodeODM service via `ERFMAP_NODEODM_URL` (see `worker/README.md`). Missing depth is never inferred from the flat image. Test a representative captured site and ground controls before treating the resulting terrain as survey-grade.
