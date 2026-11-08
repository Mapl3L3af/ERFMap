// Shared by the intake page (browser) and the server (Node): stage list, review
// merging, conversion to erfMap's fieldform-site-v1 scenario, and the GLB export.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined') module.exports = api; else root.intakeShared = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const STAGES = [
        {id: 'probe', title: 'Video & metadata', worker: true},
        {id: 'frames', step: 1, title: 'Frame selection', worker: true},
        {id: 'correction', step: 2, title: 'Image correction', worker: true},
        {id: 'markers', title: 'Scale calibration', worker: true},
        {id: 'regions', step: 3, title: 'Region detection', worker: true},
        {id: 'classification', step: 4, title: 'Classification', worker: true, optional: true},
        {id: 'merging', step: 5, title: 'Cross-frame merging', worker: true},
        {id: 'geometry', step: 6, title: 'Map geometry', worker: true},
        {id: 'review', step: 7, title: 'Review & export', worker: false},
    ];
    const MARGIN = 2;
    const NO_ELEVATION = 'The video has no GPS or altimetry, and no elevation model (for example an OpenDroneMap DSM) is connected, so ground height is unknown.';

    const geometryOf = (labels, kind) => (labels.find(l => l.kind === kind) || {geometry: 'area'}).geometry;
    const labelOf = (labels, kind) => (labels.find(l => l.kind === kind) || {label: kind}).label;
    const minimum = {area: 3, line: 2, point: 1};

    function centroid(poly) {
        let a = 0, x = 0, y = 0;
        poly.forEach((p, i) => {
            const q = poly[(i + 1) % poly.length], c = p[0] * q[1] - q[0] * p[1];
            a += c; x += (p[0] + q[0]) * c; y += (p[1] + q[1]) * c;
        });
        if (Math.abs(a) < 1e-9) return poly.reduce((s, p) => [s[0] + p[0] / poly.length, s[1] + p[1] / poly.length], [0, 0]);
        return [x / (3 * a), y / (3 * a)];
    }
    // Long axis of a region through its centroid, used when a region is labelled as a line.
    function axis(poly) {
        const c = centroid(poly);
        let xx = 0, xy = 0, yy = 0;
        for (const [x, y] of poly) { xx += (x - c[0]) ** 2; xy += (x - c[0]) * (y - c[1]); yy += (y - c[1]) ** 2; }
        const angle = Math.atan2(2 * xy, xx - yy) / 2, d = [Math.cos(angle), Math.sin(angle)];
        const t = poly.map(p => (p[0] - c[0]) * d[0] + (p[1] - c[1]) * d[1]);
        return [Math.min(...t), Math.max(...t)].map(v => [c[0] + d[0] * v, c[1] + d[1] * v]);
    }
    function shapeFor(geometry, region) {
        if (geometry === 'point') return [centroid(region)];
        if (geometry === 'line') return axis(region);
        return region.map(p => [...p]);
    }

    // Combine worker proposals with the reviewer's edits. Nothing here is accepted
    // unless the reviewer marked it accepted.
    // Approximate size of a feature in metres, from its current (possibly edited) points.
    function sizeOf(geometry, p) {
        if (geometry === 'area' && p.length >= 3) {
            let a = 0;
            for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; }
            return {area_m2: +Math.abs(a / 2).toFixed(1)};
        }
        if (geometry === 'line' && p.length >= 2) return {length_m: +p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0).toFixed(2)};
        return {};
    }

    function reviewedFeatures(geometry, edits, labels) {
        return geometry.features.map(f => {
            const e = edits[f.id] || {};
            const kind = e.kind || f.kind, type = geometryOf(labels, kind);
            const region = f.region || f.p;
            let p = e.p && e.p.length >= minimum[type] ? e.p : kind === f.kind ? f.p : shapeFor(type, region);
            if (type === 'point') p = p.slice(0, 1);
            if (kind === 'path' && geometry.mosaic && geometry.scale?.m_per_px) {
                const sc = geometry.scale, limits = [geometry.mosaic.width - 1, geometry.mosaic.height - 1];
                p = p.map(q => [...q]);
                for (const index of [0, p.length - 1]) {
                    const px = p[index].map((v, axis) => v / sc.m_per_px + sc.origin_px[axis]);
                    const candidates = limits.flatMap((limit, axis) => [
                        {distance: px[axis] / (limit + 1), axis, edge: 0},
                        {distance: (limit - px[axis]) / (limit + 1), axis, edge: limit},
                    ]).sort((a, b) => a.distance - b.distance);
                    const nearest = candidates[0];
                    if (nearest.distance >= 0 && nearest.distance <= .05)
                        p[index][nearest.axis] = (nearest.edge - sc.origin_px[nearest.axis]) * sc.m_per_px;
                }
            }
            return {
                id: f.id, kind, geometry: type, p, region, name: e.name || f.name || labelOf(labels, kind),
                predictedKind: f.predicted_kind || null, confidence: f.confidence ?? null, frames: f.frames || [],
                flags: (f.flags || []).filter(x => !(e.kind && ['unlabelled', 'needs label'].includes(x))), note: f.note || null, width: f.width_m ?? null,
                height: Number.isFinite(e.height) ? e.height : null, status: e.status || 'proposed',
                edited: Boolean(e.p || (e.kind && e.kind !== f.kind) || e.name), reviewedAt: e.reviewedAt || null,
                image: f.image || null, calibration: f.calibration || null, size: sizeOf(type, p),
            };
        });
    }

    function segmentPoint(p, a, b) {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        return [a[0] + t * dx, a[1] + t * dy];
    }
    function pathEnds(features, geometry) {
        const paths = features.filter(f => f.kind === 'path' && f.status !== 'rejected');
        const entrances = features.filter(f => f.kind === 'entrance' && f.status !== 'rejected');
        const sc = geometry.scale, tolerance = Math.max(.15, sc.m_per_px * 3), result = [];
        for (const path of paths) for (const index of [0, path.p.length - 1]) {
            const p = path.p[index], px = [p[0] / sc.m_per_px + sc.origin_px[0], p[1] / sc.m_per_px + sc.origin_px[1]];
            const distance = q => Math.hypot(p[0] - q[0], p[1] - q[1]);
            const junction = paths.some(other => other.id !== path.id && other.p.slice(1).some((b, i) => distance(segmentPoint(p, other.p[i], b)) <= tolerance));
            const edge = px[0] >= -3 && px[1] >= -3 && px[0] <= geometry.mosaic.width + 2 && px[1] <= geometry.mosaic.height + 2 && Math.min(px[0], px[1], geometry.mosaic.width - 1 - px[0], geometry.mosaic.height - 1 - px[1]) <= 3;
            const entrance = entrances.some(e => distance(e.p[0]) <= tolerance);
            result.push({path: path.id, index, p, type: junction ? 'junction' : edge ? 'edge' : entrance ? 'entrance' : 'unresolved'});
        }
        return result;
    }
    function edgeAccess(features, geometry) {
        const result = [];
        for (const end of pathEnds(features, geometry).filter(e => e.type === 'edge')) {
            const near = f => Math.hypot(f.p[0][0] - end.p[0], f.p[0][1] - end.p[1]) < .15;
            if (result.some(near) || features.some(f => f.kind === 'entrance' && f.status !== 'rejected' && near(f))) continue;
            result.push({id: 'access-' + end.path + '-' + end.index, kind: 'entrance', geometry: 'point', p: [end.p], region: [end.p],
                frames: ['scene'], flags: ['NPC spawn / leave at scene edge'], name: 'Path access', predicted_kind: 'entrance'});
        }
        return result;
    }

    const TEXTURED = new Set(['building', 'grass', 'soil', 'shrub', 'water', 'pavement', 'road', 'roadLine', 'path', 'crossing', 'canopy', 'unknown']);
    function buildSite({job, geometry, features, labels, texture}) {
        const accepted = features.filter(f => f.status === 'accepted');
        const all = accepted.flatMap(f => f.p);
        const minX = all.length ? Math.min(...all.map(p => p[0])) : 0, minY = all.length ? Math.min(...all.map(p => p[1])) : 0;
        const sceneBounds = job.sceneMode === 'stitched' && geometry.mosaic && geometry.scale?.m_per_px;
        const origin = sceneBounds ? geometry.scale.origin_px.map(v => -v * geometry.scale.m_per_px) : [minX - MARGIN, minY - MARGIN];
        const shift = p => p.map((v, axis) => +(v - origin[axis]).toFixed(3));
        const out = accepted.map(f => {
            const feature = {kind: f.kind, p: f.p.map(shift), name: f.name, source: 'Drone intake', _syncId: 'intake-' + job.id + '-' + f.id};
            if (texture && sceneBounds && TEXTURED.has(f.kind)) feature.texture = {asset: 'flyover', projection: 'planar-xy'};
            if (f.height) feature.height = f.height;
            if (f.width && f.geometry === 'line') feature.tagProperties = {width: +f.width.toFixed(2)};
            feature.intake = {
                job: job.id, video: job.original.name, feature: f.id, predictedKind: f.predictedKind, confidence: f.confidence,
                frames: f.frames, reviewStatus: 'accepted', reviewedAt: f.reviewedAt, editedByReviewer: f.edited,
                heightSource: f.height ? 'reviewer estimate, not measured' : null,
            };
            if (f.image) {
                feature.intake.sourceImage = f.image.source || f.image.frame;
                feature.intake.calibration = {...f.calibration, scaleNote: 'Scale from one measured distance in this photo only; approximate away from that segment.'};
                feature.intake.approximateSize = f.size;
            }
            return feature;
        });
        const xs = out.flatMap(f => f.p.map(p => p[0])), ys = out.flatMap(f => f.p.map(p => p[1]));
        const scale = geometry.scale || {};
        return {
            name: 'Drone survey · ' + job.name.replace(/\.[^.]+$/, ''),
            w: sceneBounds ? (geometry.mosaic.width - 1) * geometry.scale.m_per_px : +((xs.length ? Math.max(...xs) : 0) + MARGIN).toFixed(2),
            h: sceneBounds ? (geometry.mosaic.height - 1) * geometry.scale.m_per_px : +((ys.length ? Math.max(...ys) : 0) + MARGIN).toFixed(2),
            features: out,
            samples: sceneBounds ? (geometry.geometry_fusion?.ground_samples || []).map(([x, y, z]) => [...shift([x, y]), z]) : [],
            showContours: Boolean(sceneBounds && geometry.geometry_fusion?.ground_samples?.length),
            reconstruction: geometry.geometry_fusion?.used
                ? {heights: 'relative to a local zero (lowest ground sample), not sea level', coverage: geometry.geometry_fusion.coverage, verticalErrorM: geometry.geometry_fusion.vertical_error_m, relabelled: geometry.geometry_fusion.changed.length}
                : {heights: 'none', reason: geometry.geometry_fusion?.reason || 'No reconstruction for this job; terrain is flat.'},
            ...(texture && sceneBounds ? {assets: {flyover: {type: 'image', role: 'orthophoto', data: texture, name: 'flyover alignment preview', projection: 'planar-xy',
                bounds: [0, 0, (geometry.mosaic.width - 1) * geometry.scale.m_per_px, (geometry.mosaic.height - 1) * geometry.scale.m_per_px],
                note: 'Planar alignment preview from the flyover, not an orthomosaic: tall objects lean.'}}, showTextures: true} : {}),
            ...(job.sceneMode === 'stitched' ? {accessReviewed: true} : {}),
            localScale: scale.mode === 'per-image' ? {
                label: 'Locally scaled, unreferenced', unreferenced: true,
                method: 'One measured distance per photo; each photo scaled on its own',
                images: (scale.images || []).map(i => ({image: i.source || i.frame, reference: i.reference, metres: i.metres, label: i.label, segmentPx: i.segment_px, metresPerPixel: i.m_per_px, flags: i.flags})),
                axes: 'x and y follow each photo. Photos are placed side by side; their real positions relative to each other and north are unknown.',
                limits: 'Approximate. Not survey-grade, no geographic coordinates, no measured heights. Perspective, camera tilt, terrain and lens distortion are not removed; sizes far from a photo\'s measured segment are less reliable.',
                job: job.id,
            } : {
                label: 'Locally scaled, unreferenced', unreferenced: true,
                method: '1 ft (0.3048 m) ground markers', markers: scale.markers || 0,
                metresPerPixel: scale.m_per_px || null, markerDisagreement: scale.spread ?? null,
                axes: 'x and y follow the reference video frame. North is unknown.',
                limits: 'Not survey-grade. Perspective, terrain relief, lens distortion and camera tilt are not removed.',
                job: job.id,
            },
        };
    }

    // ------------------------------------------------------------------ 3D
    const DEFAULT_LINE_WIDTH = 0.5, POINT_SIZE = 0.5;
    function describe(f, geometry) {
        if (geometry === 'point') return {shape: POINT_SIZE + ' m square point symbol (not to scale)', height: null};
        if (geometry === 'line') {
            const width = Number(f.tagProperties?.width);
            return {shape: 'flat ribbon ' + (width > 0 ? width + ' m wide (from region width)' : DEFAULT_LINE_WIDTH + ' m wide (nominal)'), height: null};
        }
        if (f.height) return {shape: 'footprint extruded ' + f.height + ' m', height: f.height, heightSource: 'reviewer estimate, not measured'};
        return {shape: 'flat footprint', height: null};
    }
    function modelSummary(site, labels) {
        return {
            format: 'glTF 2.0 binary (.glb)', units: 'metres', upAxis: 'Y (glTF convention); map x → glTF X, map y → glTF Z',
            referenced: false, label: 'Locally scaled, unreferenced',
            elevation: {status: 'flat', value: 0, reason: NO_ELEVATION},
            contours: {available: false, reason: 'Contours need an elevation model. ' + NO_ELEVATION},
            extent: [site.w, site.h],
            features: site.features.map(f => ({name: f.name, kind: f.kind, ...describe(f, labels ? geometryOf(labels, f.kind) : f.p.length === 1 ? 'point' : 'area')})),
        };
    }

    // Ear clipping for simple polygons (no holes), returning index triples.
    function triangulate(poly) {
        const n = poly.length;
        if (n < 3) return [];
        let signed = 0;
        for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; signed += a[0] * b[1] - b[0] * a[1]; }
        const idx = [...Array(n).keys()];
        if (signed < 0) idx.reverse();
        const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        const inTri = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
        const out = [];
        let guard = 0;
        while (idx.length > 3 && guard++ < 10000) {
            let clipped = false;
            for (let i = 0; i < idx.length; i++) {
                const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
                const a = poly[ia], b = poly[ib], c = poly[ic];
                if (cross(a, b, c) <= 1e-12) continue;
                // Skip vertices that sit on a corner: an area with holes is one outline with zero-width cuts, so cut ends repeat.
                const corner = p => [a, b, c].some(q => q[0] === p[0] && q[1] === p[1]);
                if (idx.some(j => j !== ia && j !== ib && j !== ic && !corner(poly[j]) && inTri(poly[j], a, b, c))) continue;
                out.push([ia, ib, ic]); idx.splice(i, 1); clipped = true; break;
            }
            if (!clipped) break;   // degenerate: fall back to a fan for the rest
        }
        for (let i = 1; i < idx.length - 1; i++) out.push([idx[0], idx[i], idx[i + 1]]);
        return out;
    }

    function srgbToLinear(hex) {
        return [1, 3, 5].map(i => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    }

    function buildGlb(site, labels) {
        const meshes = [], nodes = [], materials = [], materialIndex = new Map(), chunks = [], accessors = [], bufferViews = [];
        let offset = 0;
        function material(kind, color) {
            if (!materialIndex.has(kind)) {
                materialIndex.set(kind, materials.length);
                materials.push({name: kind, doubleSided: true, pbrMetallicRoughness: {baseColorFactor: [...srgbToLinear(color), 1], metallicFactor: 0, roughnessFactor: 0.9}});
            }
            return materialIndex.get(kind);
        }
        function push(array, target) {
            const bytes = new Uint8Array(array.buffer);
            bufferViews.push({buffer: 0, byteOffset: offset, byteLength: bytes.length, target});
            chunks.push(bytes);
            offset += bytes.length;
            const pad = (4 - offset % 4) % 4;
            if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; }
            return bufferViews.length - 1;
        }
        // Triangles in map coordinates [x, y, up]; emitted as glTF [x, up, y].
        function addMesh(name, kind, color, tris, extras) {
            if (!tris.length) return;
            const pos = new Float32Array(tris.length * 9), nor = new Float32Array(tris.length * 9);
            tris.forEach((t, i) => {
                const [a, b, c] = t.map(p => [p[0], p[2], p[1]]);
                const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
                const len = Math.hypot(...n) || 1; n = n.map(x => x / len);
                [a, b, c].forEach((p, j) => { pos.set(p, i * 9 + j * 3); nor.set(n, i * 9 + j * 3); });
            });
            const min = [0, 1, 2].map(k => Math.min(...Array.from({length: pos.length / 3}, (_, i) => pos[i * 3 + k])));
            const max = [0, 1, 2].map(k => Math.max(...Array.from({length: pos.length / 3}, (_, i) => pos[i * 3 + k])));
            accessors.push({bufferView: push(pos, 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max});
            accessors.push({bufferView: push(nor, 34962), componentType: 5126, count: nor.length / 3, type: 'VEC3'});
            meshes.push({name, primitives: [{attributes: {POSITION: accessors.length - 2, NORMAL: accessors.length - 1}, material: material(kind, color)}]});
            nodes.push({name, mesh: meshes.length - 1, extras});
        }
        const flat = (poly, z) => triangulate(poly).map(t => t.map(i => [...poly[i], z]));
        function ribbon(line, width, z) {
            const tris = [];
            for (let i = 0; i < line.length - 1; i++) {
                const a = line[i], b = line[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
                const o = [-(b[1] - a[1]) / len * width / 2, (b[0] - a[0]) / len * width / 2];
                const q = [[a[0] + o[0], a[1] + o[1]], [b[0] + o[0], b[1] + o[1]], [b[0] - o[0], b[1] - o[1]], [a[0] - o[0], a[1] - o[1]]];
                tris.push(...flat(q, z));
            }
            return tris;
        }
        addMesh('Survey extent (flat, elevation unknown)', '_ground', '#8f8f86', flat([[0, 0], [site.w, 0], [site.w, site.h], [0, site.h]], 0), {note: NO_ELEVATION});
        site.features.forEach((f, i) => {
            const label = labels.find(l => l.kind === f.kind) || {color: '#bcb6c4', geometry: 'area'};
            const lift = 0.01 + (label.geometry === 'line' ? 0.02 : label.geometry === 'point' ? 0.03 : 0) + (i % 50) * 0.0002;
            let tris;
            if (label.geometry === 'point') {
                const [x, y] = f.p[0], r = POINT_SIZE / 2;
                tris = flat([[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]], lift);
            } else if (label.geometry === 'line') {
                tris = ribbon(f.p, Number(f.tagProperties?.width) > 0 ? Number(f.tagProperties.width) : DEFAULT_LINE_WIDTH, lift);
            } else if (f.height) {
                const top = f.height;
                tris = flat(f.p, top);
                f.p.forEach((a, j) => {
                    const b = f.p[(j + 1) % f.p.length];
                    tris.push([[...a, 0], [...b, 0], [...b, top]], [[...a, 0], [...b, top], [...a, top]]);
                });
            } else tris = flat(f.p, lift);
            addMesh(f.name, f.kind, label.color, tris, {kind: f.kind, ...describe(f, label.geometry), intake: f.intake || null});
        });
        const gltf = {
            asset: {version: '2.0', generator: 'erfMap video intake', extras: {label: 'Locally scaled, unreferenced', units: 'metres', elevation: 'flat (0 m): ' + NO_ELEVATION, localScale: site.localScale || null}},
            scene: 0, scenes: [{name: site.name, nodes: nodes.map((_, i) => i)}], nodes, meshes, materials, accessors, bufferViews,
            buffers: [{byteLength: offset}],
        };
        const enc = new TextEncoder();
        let jsonBytes = enc.encode(JSON.stringify(gltf));
        const jsonPad = (4 - jsonBytes.length % 4) % 4;
        if (jsonPad) { const padded = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20); padded.set(jsonBytes); jsonBytes = padded; }
        const total = 12 + 8 + jsonBytes.length + 8 + offset;
        const out = new Uint8Array(total), view = new DataView(out.buffer);
        view.setUint32(0, 0x46546C67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
        view.setUint32(12, jsonBytes.length, true); view.setUint32(16, 0x4E4F534A, true); out.set(jsonBytes, 20);
        let at = 20 + jsonBytes.length;
        view.setUint32(at, offset, true); view.setUint32(at + 4, 0x004E4942, true); at += 8;
        for (const c of chunks) { out.set(c, at); at += c.length; }
        return out;
    }

    return {STAGES, NO_ELEVATION, centroid, axis, shapeFor, sizeOf, reviewedFeatures, buildSite, modelSummary, triangulate, buildGlb, geometryOf, segmentPoint, pathEnds, edgeAccess};
});
