# Survey texture overlay reference

This folder preserves the November 6, 2026 prototype. The live app code has been restored to its earlier behavior.

## Files

- `implementation.patch` records every edit to the root Fieldform app and the `erfmap-survey` copy.
- `survey-texture.js` and `erfmap-survey-texture.js` preserve the shared image manager as separate files.
- `museum-texture-test.json` is a portable sample scenario with the image embedded.
- `american-history-aerial.jpg` is the source image from the [USGS NAIP Imagery Service](https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer).

The JSON sample was traced manually against the aerial image. Ground elevation is flat and building height is approximate.

## Implementation

The prototype attached a north-up JPEG, PNG, or WebP image to the current survey rectangle. It stored the data URL as `site.textureImage` and the user setting as `site.showTextures`. Browser storage and **Save scenario** then carried those fields with the geometry.

The plan defined one SVG `pattern` containing the image. Its origin came from `project([0, 0])` and its dimensions were `site.w * scale` by `site.h * scale`. Eligible area polygons used the pattern as their fill. Eligible paths and road lines used it as their stroke. The same pattern served every shape, so the image retained one common alignment.

The first-person renderer made a canvas pattern from the decoded image, aligned it to the survey's local metres, and painted eligible ground shapes onto its existing terrain texture. Roof faces sampled that texture using their world X/Y coordinates. Trees, standalone objects, proposed features, and vertical walls kept their existing appearance.

The settings toggle switched between textured surfaces and the prior styling. Eligible kinds were building, grass, soil, shrub, water, pavement, road, roadLine, path, crossing, solar, and greenroof. Features with `source: "Proposed"` were excluded.

## Reapplying

From the repository root, apply `implementation.patch` with `patch -p1 < texture-overlay-reference/implementation.patch`. The patch restores both texture manager files. Move or copy the sample files into `examples/` if you want the importable test map there. The patch was made against the code as it existed on November 6, 2026, so later edits may require merging.

## Improvements to consider

The prototype assumed image corners match the survey's rectangular bounds. A production version should read georeferencing or let you place alignment points, then verify the registration before applying it. Roof photo detail comes from above, so a pitched roof or height displacement can look distorted. Feature masks and overlap order could also be refined, and a tiled image source would handle large surveys more efficiently. The NAIP sample is an illustration of the workflow, while your drone orthomosaic would be the appropriate source for your own sites.
