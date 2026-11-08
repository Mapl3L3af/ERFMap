# Drone-based 3D mapping and relative terrain contours

## Objective and current implementation

Build a low-cost interactive classified 3D map from overlapping DJI Neo 2 aerial photographs, without LiDAR or a requirement for precise GPS elevation. The intended outputs are a reconstructed point cloud, textured environment model, semantic feature layers, and relative terrain contour lines describing slopes, hills and depressions where ground is visible.

Current intake aligns photos with planar homographies, requires a measured reference distance, proposes semantic features for review, and exports a locally scaled scenario and flat GLB. It does not triangulate camera poses, reconstruct depth, or generate a terrain elevation raster. Extruded building heights and image shadows are not terrain measurements. The drone name is project context; intake remains image based and does not assume flight automation or telemetry support from that aircraft.

## Automatic intake checks (implemented before 2D processing)

New intake jobs run a persistent Capture checks stage after frame selection and before image correction. It reports image quality, overlap evidence, disconnected groups and suspected enclosed coverage gaps. The current pipeline remains 2D; SfM is still a planned integration. Quality is measured on frame-selection imagery at a maximum side of 1024 px, with thresholds and analysis sizes stored in each report. Originals remain unchanged.

- **Blur:** score frame-selection photos at a documented analysis resolution, flag low sharpness and show the affected thumbnails and scores. Record the thresholds; low texture is a separate warning because it can resemble blur. Preserve originals and record every exclusion instead of silently discarding photos.
- **Insufficient overlap:** compare all usable photo pairs with image matching; compare nearby usable frames for video. Estimate shared image support from geometrically verified, spatially distributed matches. Flag weak links and runs lacking redundant views. Report an overlap estimate and confidence, or “unknown” when the evidence is inadequate; a raw match count is not an overlap percentage.
- **Disconnected photos:** build a verified image-match graph and display its connected groups, isolated photos and weak bridges. Request connecting images or let the user explicitly process groups separately. Never place disconnected groups side by side as if their relative positions were known.
- **Coverage gaps:** use image alignment and view redundancy to highlight suspected missing strips, holes or weakly observed areas within the captured scene. Show group image IDs and suggest additional connecting or gap-filling photos. Report areas outside the captured scene as unknown; do not claim complete survey coverage from a connected image graph. Pre-reconstruction coverage is provisional and must be refined using registered camera poses after SfM.

The implemented report distinguishes ready, needs review and blocked suitability, lists source images and exclusion reasons, saves thresholds, and supports a JSON download. Photos are matched exhaustively; videos check the next three usable frames. Coverage previews use planar image footprints within each connected group: green for multiple views, amber for one view, red for suspected enclosed holes. Missing outer strips, hidden ground and absolute survey completeness remain unknown.

Warnings pause processing. With at least one usable capture, **Continue with 2D mapping** records an acknowledgment and resumes the existing planar workflow; this does not authorize or enable multi-view reconstruction when its suitability is blocked. No usable captures means no continuation. Replacement or connecting imagery currently requires a new flyover. Retrying frame selection or capture checks clears the acknowledgment and rebuilds downstream results. Older completed jobs remain accessible without rerunning them automatically.

Future reconstruction integration must enforce its engine's minimum usable-view requirements independently of the 2D acknowledgment. Configurable thresholds, original-resolution quality scoring and editing the capture set within an existing job remain follow-up work.

## Reconstruction integration contract (planned)

1. Preserve original photos and camera metadata. Run and review the automatic intake checks above before reconstruction. Send original images to reconstruction; the enhanced, resized, planar scene used for semantic review must not replace the originals. Record rejected photos and reasons, connected image groups, and reconstruction failures.
2. Integrate an SfM/multi-view stereo engine, such as OpenDroneMap, as an explicit job stage. Retain camera intrinsics, distortion, poses, registered photo IDs, sparse and dense point clouds, and a textured mesh. Disconnected groups must remain separate rather than inventing a spatial relationship.
3. Resolve scale using measured reference distances or surveyed control. Establish a local up direction from gravity/orientation evidence or measured level control; one distance alone does not establish vertical. Store the coordinate transform, units, scale evidence and vertical datum. An arbitrary local zero is sufficient for relative elevations; absolute elevation remains unknown without control.
4. Classify reconstructed surfaces through camera projection with visibility/depth checks, or classify an orthophoto from that reconstruction. Record confidence and contributing images. Existing planar scene coordinates cannot be attached to 3D points without an explicit transform. Retain an unknown class and flag conflicting views for review.
5. Create a digital surface model (DSM), then classify ground geometrically and use reviewed semantic labels as supporting evidence to derive a digital terrain model (DTM). Buildings and tree crowns must not become ground heights. Grass labels do not prove the ground is visible. Keep unsupported ground as NoData, particularly under dense vegetation; interpolation needs a declared gap limit and uncertainty flag.
6. Generate contours from the valid DTM in the same local metric frame. Record contour interval, local zero, raster resolution and source reconstruction. Do not draw across NoData or choose an interval finer than supported vertical accuracy. Offer DSM contours separately and identify them as surface contours.
7. Display textured mesh, semantic layers, terrain and contours as independently selectable layers. Export source provenance and limitations with the artifacts. Keep the existing flat export available when reconstruction is unavailable; report which outputs were actually produced.

## Making semantic intake stronger now

Semantic Studio supports Building, Path, Road, Grass, Tree, Bush, Bench and Light. Existing category IDs remain unchanged; Road is 7 and Grass is 8. Road and grass annotations map to the corresponding pretrained segmentation labels, and the server trainer accepts both classes.

Use polygons for road width, lawns, roofs, and tree canopy boundaries. Points and lines remain useful sparse labels but supervise only a small neighbourhood. Label visible class boundaries, keep roads distinct from pedestrian paths, and avoid including background in building boxes. Do not label shadows as a surface type or guess hidden ground from canopy appearance. Unmarked pixels remain ignored rather than becoming negative examples.

Studio reports the number of labelled images and represented classes, highlights sparse drawing tools, and blocks empty training exports. This describes dataset coverage, not model accuracy. Road/grass supervision can help the model distinguish paving and vegetation; intake still uses grass as the residual zone after other surfaces, so a final grass polygon is not a calibrated grass prediction or a terrain mask.

Training currently tunes the existing SegFormer decoder for ten epochs with a frozen encoder. It preserves the original classifier head and does not compute held-out metrics. Before claiming improved performance, reserve an entire flight/site for validation, rather than distributing adjacent overlapping views across training and validation. Compare the base and fine-tuned models on exactly the same held-out labels using per-class IoU, class recall, and boundary quality; inspect road/path confusion, tree/building confusion, and shadow failures. Keep the prior model available if results regress. Repeat exports of unchanged imagery are additional fine-tuning, not independent evidence of improvement.

## Acceptance criteria for future terrain support

- A blurred-photo fixture is flagged; low-texture imagery receives a distinct warning. Weak-overlap sets, isolated photos and disconnected groups appear in the intake report with source IDs and reasons.
- A deliberately missing strip within an alignable captured scene is flagged as a suspected coverage gap. Without adequate alignment evidence, coverage is reported as unknown rather than complete. Adding connecting or gap-filling photos recomputes the report and updates readiness.
- Reconstruction reports registered images, disconnected groups, reprojection error, and coverage instead of treating every upload as usable.
- Independent measured distances check scale; independent relative height checks assess vertical error and tilt before selecting contour intervals.
- Ground masks exclude roof and canopy elevations, preserve holes where ground is unobserved, and expose interpolation separately.
- A sloped test surface yields consistent relative heights and contours; a flat surface stays flat within measured tolerance. Missing-ground areas produce no terrain contours.
- Reloaded/exported artifacts preserve local units, up direction, zero datum, class provenance and uncertainty. The UI never presents a flat fallback as reconstructed terrain.

## Reference implementation guidance

OpenDroneMap documents [point clouds, textured models and DSM/DTM outputs](https://docs.opendronemap.org/outputs/) and [ground filtering for DTM generation](https://docs.opendronemap.org/arguments/). These are integration references, not dependencies already installed or connected to erfMap.
