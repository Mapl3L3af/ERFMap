# erfMap

Run `node server.js` with Node 20 or later, or double-click **Start erfMap.command** on macOS. The app has no package installation step. Open the localhost address printed in the terminal. Teammates on the same network should use the network address printed there.

**New Flyover** opens the video and photo intake flow. **Open Project** imports an exported scenario JSON, a raw survey, or a supported GeoJSON FeatureCollection. Importing creates a saved project. **Join Project** opens an existing project on this server using its four digit code. Four people can edit at once. Keep the server running while collaborating.

Projects are saved under `.erfmap-data/`. Back up this directory to preserve projects and their codes. `ERFMAP_DATA`, `PORT`, and `HOST` override the storage location, port (3000), and listening address. For remote teams, serve one instance on a shared HTTPS address with persistent storage and unbuffered event streams. Anyone with a project code and access to the server can edit that project.

Edits to different features merge. For changes to the same feature, the last edit accepted by the server wins. Movement uses direct WebRTC data channels when available and otherwise travels through the server.

## Video and photo intake (drone imagery without GPS)

**New Flyover** on the front page (or `/intake/`) assembles overlapping overhead photos or video frames into one scene. Confirm a measured ground distance, then review building, grass and path zones. Mark correction points and reevaluate as often as needed; accepted building footprints stay fixed and tree/shadow evidence helps bridge false path breaks. Approve zones before reviewing bench and light dots. Finally mark building entrances and accept NPC access at scene-edge path ends. Unresolved interior path ends block import. Finished reviews can be imported as an erfMap project or downloaded as scenario JSON or a flat `.glb`. Results are locally scaled and unreferenced.

Processing needs Python 3.10+, FFmpeg and `pip install -r worker/requirements.txt`. Without them, uploads are still kept and the affected stages show as unavailable. For automatic labels, `pip install open_clip_torch` adds a free CLIP zero-shot classifier (about 600 MB download on first use). Without it, regions are labelled by hand during review. See `worker/README.md` for setup, the adapter contracts and the limitations. Intake jobs are stored under `.erfmap-data/intake/`.
