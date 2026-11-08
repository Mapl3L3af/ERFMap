# Proposed review redesign

## Goal

Replace the current multi-stage review wizard with one map-led workspace. People should be able to understand what needs attention, correct it where it appears, and finish without having to learn the difference between zones, dots, and access review.

## Proposed flow

1. **Open the map with a short status summary.** Show the scene, scale, counts of unreviewed items, and any blocking issue. Give one clear primary action: “Review 24 suggestions” or “Fix capture issue”. Avoid a long stepper that makes every job look like a fixed sequence.
2. **Review suggestions in one queue.** Keep a single list with plain filters such as Areas, Trees and objects, and Connections. Each row says what the feature is, where it is, and why it was flagged (low confidence, model disagreement, or overlap). Selecting a row zooms to it and opens simple actions: Keep, Remove, Change type, and Edit shape.
3. **Use a focused map editor.** Make the selected feature obvious, dim unrelated overlays, and offer undo/redo. Use familiar drawing actions: click to add outline points, drag vertices to adjust, and finish/cancel buttons. Keep specialized correction tools behind “Improve suggestions” so casual reviewers can simply accept or reject.
4. **Handle access as a map checklist.** Surface only required scene-edge connections as checklist items with “Show on map” and “Mark access”. Keep building entrances and interior connections optional, and explain that distinction beside the relevant controls. Do not make access a separate wizard phase.
5. **Finish with a readiness summary.** Show accepted, removed, and unresolved counts, list only actual blockers, and provide a preview of the resulting map. One “Import map” action becomes available when required edge access items are resolved. Keep exports nearby after import.

## Interaction details

- Preserve autosaved review decisions and show “Saved” feedback; keep the existing back-end review data compatible during migration.
- Provide bulk actions per visible filter, with a clear count and undo.
- Make keyboard access practical: tab through queue items/actions, use Enter to select, and expose map edits in a complementary feature form for people who cannot use precise dragging.
- Use plain language throughout: “suggestion”, “area”, “object”, “connection”, “keep”, and “remove”. Put confidence and model diagnostics in a secondary details panel.
- Keep a compact progress indicator based on remaining required work rather than numbered stages. Users may move freely between queue categories.
- Never hide a path or building simply because another category is active; filters should control emphasis and list contents, while map context remains visible.

## Migration sequence

1. Restructure the review screen into map, queue, selection details, and readiness summary while retaining the current API and `zones`/`points`/`access` state internally.
2. Remove phase gating from the user interface; allow changes across categories at any time and keep current validation for required scene-edge access.
3. Add undo/redo and bulk review actions, then simplify correction controls.
4. Migrate stored review state only if the new flow needs fields the existing feature decisions cannot represent. Keep old jobs readable.
5. Validate with keyboard-only use, a small screen, a no-model/manual-label job, a normal flyover, and a job with unresolved edge access before removing the old flow.

## Success criteria

- A first-time reviewer can identify the next action without reading setup documentation.
- All proposals can be reviewed from one workspace without being forced through category-specific screens.
- Required access blockers are clear, locatable on the map, and distinguishable from optional edits.
- Decisions survive refresh and import/export output matches the accepted geometry.
