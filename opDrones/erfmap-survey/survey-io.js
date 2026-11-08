// Survey round-trips: editable JSON and textured GLB.
//
// JSON is the survey itself (`fieldform-site-v1`), so ids, labels, edits,
// proposals, score inputs and asset mappings all travel unchanged.
//
// GLB carries the same survey twice: as geometry any 3D tool can open (one node
// per item, photo textures on captured items) and as metadata erfMap reads back
// (`asset.extras.erfmap` holds the survey, `node.extras.erfmap` each item). A GLB
// from another tool has neither, so import rebuilds what it can from the meshes
// and lists what is missing.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined') module.exports = api; else root.surveyIO = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const FORMAT = 'erfmap-survey-glb', VERSION = 1;

    // ---------------------------------------------------------------- bytes
    function dataUrlToBytes(url) {
        const comma = url.indexOf(','), mime = url.slice(5, url.indexOf(';'));
        const bin = atob(url.slice(comma + 1)), out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return {bytes: out, mime};
    }
    function bytesToDataUrl(bytes, mime) {
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return 'data:' + mime + ';base64,' + btoa(bin);
    }
    const srgb = hex => [1, 3, 5].map(i => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });

    // ---------------------------------------------------------------- geometry
    function signedArea(p) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - a[1] * b[0]; } return s / 2; }
    function triangulate(poly) {
        const idx = poly.map((_, i) => i);
        if (signedArea(poly) < 0) idx.reverse();
        const tris = [], cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        const inTri = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
        let guard = 0;
        while (idx.length > 3 && guard++ < 10000) {
            let cut = false;
            for (let i = 0; i < idx.length; i++) {
                const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
                const a = poly[ia], b = poly[ib], c = poly[ic];
                if (cross(a, b, c) <= 1e-12) continue;
                if (idx.some(j => j !== ia && j !== ib && j !== ic && inTri(poly[j], a, b, c))) continue;
                tris.push([ia, ib, ic]); idx.splice(i, 1); cut = true; break;
            }
            if (!cut) break;
        }
        if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
        else for (let i = 1; i < idx.length - 1; i++) tris.push([idx[0], idx[i], idx[i + 1]]);   // degenerate fallback
        return tris;
    }
    const flat = (poly, z) => triangulate(poly).map(t => t.map(i => [poly[i][0], poly[i][1], typeof z === 'function' ? z(poly[i]) : z]));
    function ribbon(line, width, z) {
        const tris = [];
        for (let i = 0; i < line.length - 1; i++) {
            const a = line[i], b = line[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
            const o = [-(b[1] - a[1]) / len * width / 2, (b[0] - a[0]) / len * width / 2];
            tris.push(...flat([[a[0] + o[0], a[1] + o[1]], [b[0] + o[0], b[1] + o[1]], [b[0] - o[0], b[1] - o[1]], [a[0] - o[0], a[1] - o[1]]], z));
        }
        return tris;
    }
    function prism(base, bottom, top) {
        const tris = flat(base, top);
        base.forEach((a, j) => {
            const b = base[(j + 1) % base.length];
            tris.push([[...a, bottom], [...b, bottom], [...b, top]], [[...a, bottom], [...b, top], [...a, top]]);
        });
        return tris;
    }
    const circle = (c, r, n = 10) => Array.from({length: n}, (_, i) => [c[0] + r * Math.cos(i * 2 * Math.PI / n), c[1] + r * Math.sin(i * 2 * Math.PI / n)]);

    // ---------------------------------------------------------------- export
    function exportGlb(site, options = {}) {
        const kinds = options.kinds || {}, colorOf = options.color || (f => kinds[f.kind]?.[1] || '#bcb6c4');
        const heightAt = options.heightAt || (() => 0);
        const geometryOf = f => kinds[f.kind]?.[2] || (f.p.length === 1 ? 'point' : 'area');
        const meshes = [], nodes = [], materials = [], textures = [], images = [], samplers = [], accessors = [], bufferViews = [], chunks = [];
        let offset = 0;
        const materialIndex = new Map(), imageIndex = new Map();
        function view(bytes, target) {
            bufferViews.push(target ? {buffer: 0, byteOffset: offset, byteLength: bytes.length, target} : {buffer: 0, byteOffset: offset, byteLength: bytes.length});
            chunks.push(bytes); offset += bytes.length;
            const pad = (4 - offset % 4) % 4;
            if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; }
            return bufferViews.length - 1;
        }
        // Images: one glTF image per survey asset, stored in the binary chunk.
        const assetMeta = {};
        for (const [id, a] of Object.entries(site.assets || {})) {
            const {data, ...meta} = a || {};
            assetMeta[id] = meta;
            if (a?.type !== 'image' || typeof data !== 'string' || !data.startsWith('data:image/')) continue;
            const {bytes, mime} = dataUrlToBytes(data);
            if (!samplers.length) samplers.push({magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071});
            images.push({name: id, mimeType: mime, bufferView: view(bytes)});
            textures.push({sampler: 0, source: images.length - 1});
            imageIndex.set(id, textures.length - 1);
            assetMeta[id].image = images.length - 1;
        }
        function material(key, color, texture) {
            const id = key + (texture != null ? '#tex' + texture : '');
            if (!materialIndex.has(id)) {
                materialIndex.set(id, materials.length);
                const pbr = {baseColorFactor: texture != null ? [1, 1, 1, 1] : [...srgb(color), 1], metallicFactor: 0, roughnessFactor: .9};
                if (texture != null) pbr.baseColorTexture = {index: texture};
                materials.push({name: id, doubleSided: true, pbrMetallicRoughness: pbr});
            }
            return materialIndex.get(id);
        }
        // Triangles in survey coordinates [east, south, up]; glTF is [east, up, south].
        function addMesh(name, tris, mat, uvOf, extras) {
            if (!tris.length) return;
            const n = tris.length * 3, pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = uvOf ? new Float32Array(n * 2) : null;
            tris.forEach((t, i) => {
                const g = t.map(p => [p[0], p[2], p[1]]);
                const u = [g[1][0] - g[0][0], g[1][1] - g[0][1], g[1][2] - g[0][2]], v = [g[2][0] - g[0][0], g[2][1] - g[0][1], g[2][2] - g[0][2]];
                let nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
                const len = Math.hypot(...nn) || 1; nn = nn.map(x => x / len);
                g.forEach((p, j) => { pos.set(p, (i * 3 + j) * 3); nor.set(nn, (i * 3 + j) * 3); if (uv) uv.set(uvOf(t[j]), (i * 3 + j) * 2); });
            });
            const min = [0, 1, 2].map(k => { let m = Infinity; for (let i = k; i < pos.length; i += 3) m = Math.min(m, pos[i]); return m; });
            const max = [0, 1, 2].map(k => { let m = -Infinity; for (let i = k; i < pos.length; i += 3) m = Math.max(m, pos[i]); return m; });
            const attributes = {};
            accessors.push({bufferView: view(new Uint8Array(pos.buffer), 34962), componentType: 5126, count: n, type: 'VEC3', min, max}); attributes.POSITION = accessors.length - 1;
            accessors.push({bufferView: view(new Uint8Array(nor.buffer), 34962), componentType: 5126, count: n, type: 'VEC3'}); attributes.NORMAL = accessors.length - 1;
            if (uv) { accessors.push({bufferView: view(new Uint8Array(uv.buffer), 34962), componentType: 5126, count: n, type: 'VEC2'}); attributes.TEXCOORD_0 = accessors.length - 1; }
            meshes.push({name, primitives: [{attributes, material: mat}]});
            nodes.push({name, mesh: meshes.length - 1, extras});
        }
        const planar = id => {
            const a = site.assets?.[id], b = Array.isArray(a?.bounds) ? a.bounds : [0, 0, site.w, site.h];
            return p => [(p[0] - b[0]) / b[2], (p[1] - b[1]) / b[3]];
        };
        // Terrain: a grid that follows the survey's ground samples (flat when there are none).
        const steps = 24, ground = [];
        for (let y = 0; y < steps; y++) for (let x = 0; x < steps; x++) {
            const q = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].map(([i, j]) => [i * site.w / steps, j * site.h / steps]);
            ground.push(...[[q[0], q[1], q[2]], [q[0], q[2], q[3]]].map(t => t.map(p => [p[0], p[1], heightAt(p)])));
        }
        const groundAsset = site.assets?.ortho && imageIndex.has('ortho') && site.showTextures !== false ? 'ortho' : null;
        addMesh('Ground', ground, material('_ground', '#8f9a7c', groundAsset ? imageIndex.get('ortho') : null), groundAsset ? planar('ortho') : null,
            {erfmap: {role: 'ground', samples: site.samples?.length || 0, note: site.samples?.length ? 'Relative heights from ground samples; local zero, not absolute elevation.' : 'Flat: no ground samples.'}});
        site.features.forEach((f, i) => {
            const g = geometryOf(f), color = colorOf(f), z = p => heightAt(p);
            const texId = f.texture?.asset && imageIndex.has(f.texture.asset) ? f.texture.asset : null;
            const mat = material(f.kind, color, texId ? imageIndex.get(texId) : null), uv = texId ? planar(texId) : null;
            const lift = .02 + (i % 50) * .0004;
            let tris;
            if (g === 'point') {
                const c = f.p[0], base = heightAt(c);
                if (f.kind === 'tree') {
                    const size = Math.max(2, Math.min(40, Number(f.tagProperties?.maxGrowth) || 16)) / 18;
                    tris = [...prism(circle(c, .28 * size, 8), base, base + 3.4 * size), ...prism(circle(c, 2.2 * size, 10), base + 2.4 * size, base + 6 * size)];
                } else {
                    const h = f.kind === 'light' ? 4.5 : f.kind === 'bench' ? .5 : 1, r = f.kind === 'bench' ? .9 : .3;
                    tris = prism(circle(c, r, 8), base, base + h);
                }
            } else if (g === 'line') {
                const width = Number(f.tagProperties?.width) > 0 ? Number(f.tagProperties.width) : f.kind === 'roadLine' ? 6 : f.kind === 'path' ? 1.8 : .3;
                tris = f.kind === 'fence' ? f.p.slice(1).flatMap((b, j) => prism([f.p[j], b, [b[0] + .05, b[1] + .05], [f.p[j][0] + .05, f.p[j][1] + .05]], heightAt(b), heightAt(b) + 1.2)) : ribbon(f.p, width, p => z(p) + lift);
            } else if (f.kind === 'building') {
                const base = Math.min(...f.p.map(heightAt)), top = Math.max(...f.p.map(heightAt)) + (Number(f.height) || 5);
                tris = prism(f.p, base, top);
            } else tris = flat(f.p, p => z(p) + lift);
            addMesh(f.name || f.kind, tris, mat, uv, {erfmap: {index: i, feature: f}});
        });
        const {assets, ...rest} = site;
        const gltf = {
            asset: {version: '2.0', generator: 'erfMap survey', extras: {erfmap: {format: FORMAT, version: VERSION, units: 'metres', axes: 'x east, y up, z south (survey y)', site: rest, assets: assetMeta}}},
            scene: 0, scenes: [{name: site.name, nodes: nodes.map((_, i) => i)}], nodes, meshes, materials, accessors, bufferViews, buffers: [{byteLength: offset}],
        };
        if (images.length) Object.assign(gltf, {images, textures, samplers});
        const enc = new TextEncoder();
        let json = enc.encode(JSON.stringify(gltf));
        const jp = (4 - json.length % 4) % 4;
        if (jp) { const padded = new Uint8Array(json.length + jp).fill(0x20); padded.set(json); json = padded; }
        const total = 12 + 8 + json.length + 8 + offset, out = new Uint8Array(total), dv = new DataView(out.buffer);
        dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
        dv.setUint32(12, json.length, true); dv.setUint32(16, 0x4E4F534A, true); out.set(json, 20);
        let at = 20 + json.length;
        dv.setUint32(at, offset, true); dv.setUint32(at + 4, 0x004E4942, true); at += 8;
        for (const c of chunks) { out.set(c, at); at += c.length; }
        return out;
    }

    // ---------------------------------------------------------------- import
    function parseGlb(input) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes.length < 20 || dv.getUint32(0, true) !== 0x46546C67) throw Error('Not a GLB file (missing glTF header).');
        if (dv.getUint32(4, true) !== 2) throw Error('Only glTF 2.0 GLB files are supported.');
        let at = 12, json = null, bin = null;
        while (at + 8 <= bytes.length) {
            const len = dv.getUint32(at, true), type = dv.getUint32(at + 4, true), body = bytes.subarray(at + 8, at + 8 + len);
            if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(body));
            else if (type === 0x004E4942) bin = body;
            at += 8 + len;
        }
        if (!json) throw Error('GLB has no JSON chunk.');
        return {json, bin};
    }
    function viewBytes(gltf, bin, index) {
        const v = gltf.bufferViews[index];
        if (!bin || (v.buffer ?? 0) !== 0) throw Error('GLB references an external buffer, which is not supported.');
        return bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
    }
    function readAccessor(gltf, bin, index) {
        const a = gltf.accessors[index], size = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4}[a.type];
        const bv = gltf.bufferViews[a.bufferView], raw = viewBytes(gltf, bin, a.bufferView);
        const Ctor = {5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array}[a.componentType];
        if (!Ctor) throw Error('Unsupported accessor type ' + a.componentType + '.');
        const stride = bv.byteStride || size * Ctor.BYTES_PER_ELEMENT, out = [];
        const base = raw.byteOffset + (a.byteOffset || 0), dv = new DataView(raw.buffer);
        for (let i = 0; i < a.count; i++) {
            const row = [];
            for (let k = 0; k < size; k++) {
                const o = base + i * stride + k * Ctor.BYTES_PER_ELEMENT;
                row.push(Ctor === Float32Array ? dv.getFloat32(o, true) : Ctor === Uint32Array ? dv.getUint32(o, true) : Ctor === Uint16Array ? dv.getUint16(o, true) : dv.getUint8(o));
            }
            out.push(size === 1 ? row[0] : row);
        }
        return out;
    }
    function hull(points) {
        const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        if (p.length < 3) return p;
        const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const lower = [], upper = [];
        for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
        for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
        return lower.slice(0, -1).concat(upper.slice(0, -1));
    }
    const KEYWORDS = [['building', /build|house|roof|shed|hall|museum|pavilion/i], ['tree', /tree|oak|maple|pine|birch/i], ['water', /water|pond|lake|pool/i],
        ['path', /path|walk|trail|sidewalk/i], ['roadLine', /road|street|avenue|drive/i], ['grass', /grass|lawn|turf|field|garden/i], ['pavement', /pave|plaza|terrace|court|parking/i],
        ['bench', /bench|seat/i], ['light', /light|lamp/i], ['bin', /bin|trash|garbage|waste/i], ['shrub', /shrub|hedge/i], ['bush', /bush/i], ['fence', /fence|rail/i]];

    // Import a GLB. Returns {site, report: {source, complete, missing[], notes[]}}.
    function importGlb(input, options = {}) {
        const kinds = options.kinds || {};
        const {json: gltf, bin} = parseGlb(input);
        const meta = gltf.asset?.extras?.erfmap;
        const imageData = i => {
            const img = gltf.images?.[i];
            if (!img || img.bufferView == null) return null;
            return bytesToDataUrl(viewBytes(gltf, bin, img.bufferView), img.mimeType || 'image/png');
        };
        if (meta?.format === FORMAT && meta.site) {
            const site = JSON.parse(JSON.stringify(meta.site));
            const missing = [];
            const assets = {};
            for (const [id, a] of Object.entries(meta.assets || {})) {
                const {image, ...rest} = a;
                const data = image != null ? imageData(image) : null;
                if (image != null && !data) missing.push('image for asset "' + id + '"');
                assets[id] = data ? {...rest, data} : rest;
            }
            if (Object.keys(assets).length) site.assets = assets;
            // Node metadata wins where it disagrees, so per-item edits made in another
            // tool's extras panel are kept; geometry stays the survey's own.
            const ids = new Set(site.features.map(f => f._syncId).filter(Boolean));
            const seen = (gltf.nodes || []).filter(n => n.extras?.erfmap?.feature).length;
            if (seen < site.features.length) missing.push((site.features.length - seen) + ' item node(s) were removed from the model; their survey data is still restored from the file metadata');
            return {site, report: {source: 'erfmap', complete: !missing.length, missing, notes: ['Restored ' + site.features.length + ' items with ' + ids.size + ' ids, labels, edits, proposals, score inputs and ' + Object.keys(assets).length + ' texture asset(s).']}};
        }
        // Standalone or partially tagged GLB: rebuild items from meshes.
        const missing = [], notes = [], features = [];
        let rotated = 0, tagged = 0, unknown = 0;
        const all = [];
        const parentOf = new Map();
        (gltf.nodes || []).forEach((n, i) => (n.children || []).forEach(c => parentOf.set(c, i)));
        const transform = i => {
            let t = [0, 0, 0], s = [1, 1, 1];
            for (let j = i; j !== undefined; j = parentOf.get(j)) {
                const n = gltf.nodes[j];
                if (n.rotation && n.rotation.some((v, k) => Math.abs(v - (k === 3 ? 1 : 0)) > 1e-6)) rotated++;
                if (n.matrix) rotated++;
                const ns = n.scale || [1, 1, 1], nt = n.translation || [0, 0, 0];
                t = [t[0] * ns[0] + nt[0], t[1] * ns[1] + nt[1], t[2] * ns[2] + nt[2]]; s = [s[0] * ns[0], s[1] * ns[1], s[2] * ns[2]];
            }
            return p => [p[0] * s[0] + t[0], p[1] * s[1] + t[1], p[2] * s[2] + t[2]];
        };
        (gltf.nodes || []).forEach((n, i) => {
            if (n.mesh == null) return;
            const mesh = gltf.meshes[n.mesh], tf = transform(i);
            const pts = mesh.primitives.flatMap(pr => pr.attributes?.POSITION != null ? readAccessor(gltf, bin, pr.attributes.POSITION) : []).map(tf);
            if (!pts.length) return;
            all.push(...pts);
            features.push({node: n, mesh, pts, material: mesh.primitives[0]?.material != null ? gltf.materials?.[mesh.primitives[0].material]?.name : ''});
        });
        if (!all.length) throw Error('This GLB has no mesh geometry to import.');
        const minX = Math.min(...all.map(p => p[0])), maxX = Math.max(...all.map(p => p[0]));
        const minZ = Math.min(...all.map(p => p[2])), maxZ = Math.max(...all.map(p => p[2]));
        const minY = Math.min(...all.map(p => p[1]));
        const w = Math.max(1, maxX - minX), h = Math.max(1, maxZ - minZ);
        const out = [];
        for (const item of features) {
            const tag = item.node.extras?.erfmap?.feature;
            if (item.node.extras?.erfmap?.role === 'ground') continue;
            if (tag && Array.isArray(tag.p)) { out.push(JSON.parse(JSON.stringify(tag))); tagged++; continue; }
            const xs = item.pts.map(p => p[0]), zs = item.pts.map(p => p[2]), ys = item.pts.map(p => p[1]);
            const spanX = Math.max(...xs) - Math.min(...xs), spanZ = Math.max(...zs) - Math.min(...zs), tall = Math.max(...ys) - Math.min(...ys);
            if (spanX > .9 * w && spanZ > .9 * h && tall < .5) continue;      // the ground or extent plane
            const name = [item.node.name, item.mesh.name, item.material].filter(Boolean).join(' ');
            let kind = (KEYWORDS.find(([, re]) => re.test(name)) || [])[0];
            const foot = hull(item.pts.map(p => [+(p[0] - minX).toFixed(3), +(p[2] - minZ).toFixed(3)]));
            const area = Math.abs(signedArea(foot)), c = foot.reduce((s, q) => [s[0] + q[0] / foot.length, s[1] + q[1] / foot.length], [0, 0]);
            if (!kind) { kind = tall > 2 && area > 6 ? 'building' : 'unknown'; unknown++; }
            const geom = kinds[kind]?.[2] || 'area';
            const f = {kind, name: item.node.name || item.mesh.name || 'Imported item', source: 'GLB import', _syncId: 'glb-' + out.length + '-' + Math.random().toString(36).slice(2, 8)};
            if (geom === 'point') f.p = [c];
            else if (geom === 'line') { const long = spanX >= spanZ; const ends = [...foot].sort((a, b) => long ? a[0] - b[0] : a[1] - b[1]); f.p = [ends[0], ends[ends.length - 1]]; f.tagProperties = {width: +Math.max(.3, long ? spanZ : spanX).toFixed(2)}; }
            else f.p = foot.length >= 3 ? foot : [[c[0] - .5, c[1] - .5], [c[0] + .5, c[1] - .5], [c[0] + .5, c[1] + .5]];
            if (kind === 'building') f.height = +tall.toFixed(2);
            f.importNote = 'Footprint from mesh outline (convex hull); kind ' + (KEYWORDS.some(([k, re]) => k === kind && re.test(name)) ? 'from its name "' + name + '"' : 'guessed from shape');
            out.push(f);
        }
        const site = {name: gltf.scenes?.[gltf.scene || 0]?.name || 'Imported GLB', w: +w.toFixed(2), h: +h.toFixed(2), features: out, samples: [], showContours: false};
        if (tagged && tagged === out.length) missing.push('survey-level data (score inputs, baseline, pedestrians, texture assets): only per-item metadata was present');
        else {
            missing.push('erfMap survey metadata: no item ids, review history, proposals or score inputs');
            if (unknown) missing.push(unknown + ' item(s) without a recognisable label: marked Unknown or guessed as buildings from their height; check them in Properties');
            missing.push('ground heights: terrain is flat, so contours are off');
        }
        if (gltf.images?.length) missing.push(gltf.images.length + ' embedded image(s) are not mapped to survey items');
        if (rotated) missing.push('rotations on ' + rotated + ' node(s) were ignored; footprints may be turned');
        notes.push('Units assumed to be metres with +Y up and +Z as survey south. Origin moved to the model\'s corner.');
        if (minY !== 0) notes.push('Model base sat at ' + minY.toFixed(2) + ' m; heights are kept relative.');
        return {site, report: {source: tagged ? 'erfmap-items' : 'standalone', complete: false, missing, notes}};
    }
    return {exportGlb, importGlb, parseGlb, triangulate, dataUrlToBytes, bytesToDataUrl, FORMAT};
});
