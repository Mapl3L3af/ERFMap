# Frontend workspace

Complete UI snapshot for a separate frontend task. The running app currently serves the original sibling folders; these copies are isolated for editing and later integration.

| Folder | Screen / purpose | App route |
| --- | --- | --- |
| `erfmap-frontpage/` | Landing page, project entry, capture and processing guide | `/`, `/info.html` |
| `erfmap-intake/` | Upload, scale calibration, capture checks, model review, map references and export | `/intake/` |
| `erfmap-survey/` | Interactive map, feature editing, 3D walkthrough, terrain, contours and collaboration | `/survey/` |
| `semantic-labeler/` | Annotation tools and training UI | `/semantic-labeler/` |
| `texture-overlay-reference/` | Texture-overlay example, imagery and implementation reference | Reference material |

Each application folder includes its HTML, CSS, JavaScript and local image/SVG assets. `capture-profile.json` records the current nominal capture context: about 25 metres above local ground, with small fluctuations expected.

## Working on the UI

No frontend framework, build step or package installation is required. Keep each folder name and its relative asset paths when integrating changes. To preview without replacing the original sibling folders, run `node frontend/preview.js` from `opDrones/`, then open http://127.0.0.1:3100. Run the normal backend separately with `npm start` for processing and project APIs. Set `ERFMAP_BACKEND` if the backend uses another address; set `FRONTEND_PORT` to change the preview port. Restart the server after backend changes.

The shared `flight.css`, `flight.js`, and the custom `airframe.svg` provide the visual tokens, accessible SVG controls, and keyboard behavior for all five screens. When integrating these copies, serve those shared files at `/flight.css`, `/flight.js`, and `/airframe.svg` as well as copying each screen folder. The production server still serves the original folders.

The flight-console design uses slate surfaces, orange instrument accents, a contour launch chart, responsive control docks, and system fonts. Symbol buttons retain accessible names and native tooltips. Motion respects reduced-motion preferences, and launch-screen animation sleeps while idle. The launch chart is explicitly illustrative, not live drone telemetry.

The frontend calls same-origin `/api/projects`, `/api/intake` and `/api/training` endpoints. It uses EventSource for live updates and WebRTC for collaborative movement. A standalone static host can display assets, but upload, processing, saved projects and training require the backend or a proxy to it.

`erfmap-survey/model.js` and `erfmap-intake/shared.js` are also imported by the backend and tests. Preserve their CommonJS/browser compatibility and data contracts. `erfmap-intake/reference.js` is shared reference-alignment logic. The optional reference UI is under Source imagery → Map reference → Advanced · Map reference.

This snapshot excludes uploads, saved user projects, trained weights, Python workers, API implementation, credentials and generated diagnostic artifacts. Backend work stays in the repository root, `intake/` and `worker/`.
