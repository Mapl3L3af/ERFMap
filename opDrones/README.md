# erfMap

Run `node server.js` with Node 20 or later, or double-click **Start erfMap.command** on macOS. The app has no package installation step. Open the localhost address printed in the terminal. Teammates on the same network should use the network address printed there.

**New Flyover** starts a demonstration survey. **Open Project** imports an exported scenario JSON, a raw survey, or a supported GeoJSON FeatureCollection. Both create a saved project. **Join Project** opens an existing project on this server using its four digit code. Four people can edit at once. Keep the server running while collaborating.

Projects are saved under `.erfmap-data/`. Back up this directory to preserve projects and their codes. `ERFMAP_DATA`, `PORT`, and `HOST` override the storage location, port (3000), and listening address. For remote teams, serve one instance on a shared HTTPS address with persistent storage and unbuffered event streams. Anyone with a project code and access to the server can edit that project.

Edits to different features merge. For changes to the same feature, the last edit accepted by the server wins. Movement uses direct WebRTC data channels when available and otherwise travels through the server.

## Video and photo intake (drone imagery without GPS)

**Video Intake** on the front page (or `/intake/`) turns a drone video, or one or more photos, into proposed map features. Upload, then watch each stage: frame selection, image correction, scale calibration (for photos, one distance you measured on the ground per photo; each photo is scaled on its own), region detection, classification, cross-frame merging and map geometry. Then review the proposals and import the accepted ones as a new erfMap project, download them as scenario JSON, or download a flat `.glb` 3D model. Results are **locally scaled, unreferenced**: there are no world coordinates and they are not survey-grade.

Processing needs Python 3.10+, FFmpeg and `pip install -r worker/requirements.txt`. Without them, uploads are still kept and the affected stages show as unavailable. For automatic labels, `pip install open_clip_torch` adds a free CLIP zero-shot classifier (about 600 MB download on first use). Without it, regions are labelled by hand during review. See `worker/README.md` for setup, the adapter contracts and the limitations. Intake jobs are stored under `.erfmap-data/intake/`.
