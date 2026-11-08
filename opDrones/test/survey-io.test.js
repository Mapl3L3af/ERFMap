const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {demo, restore, kinds} = require('../erfmap-survey/model.js');
const io = require('../erfmap-survey/survey-io.js');
const scoring = require('../erfmap-survey/scoring.js');

// A 4×4 PNG, so texture bytes can be compared exactly.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFklEQVR4nGP4z8DwHxkzEBEQGgYMDABq4w/xXgSdlgAAAABJRU5ErkJggg==';

function survey() {
    const site = demo();
    site.features.forEach((f, i) => { f._syncId = 'id-' + i; });
    site.features[3].name = 'Field house (renamed)';               // an edit
    site.features[3].tagProperties = {roofShape: 'Pointed'};
    site.features.push({kind: 'tree', p: [[60, 40]], name: 'New oak', source: 'Proposed', tagProperties: {maxGrowth: 18}, _syncId: 'proposal-1'});
    site.features.push({kind: 'bench', p: [[31, 46]], name: 'New bench', source: 'Proposed', _syncId: 'proposal-2'});
    site.features[0].intake = {job: 'abc', predictedKind: 'grass', confidence: .81, reviewStatus: 'accepted'};
    site.scoring = {rates: {bench: 1800}, assumptions: {visitsPerDay: 350}, baseline: {at: '2026-11-08T00:00:00Z', features: site.features.slice(0, -2)}};
    site.assets = {ortho: {type: 'image', role: 'orthophoto', data: PNG, bounds: [0, 0, site.w, site.h], name: 'flyover.png', projection: 'planar-xy'}};
    site.features.filter(f => f.kind === 'grass' || f.kind === 'building').forEach(f => { f.texture = {asset: 'ortho', projection: 'planar-xy'}; });
    site.showTextures = true;
    return site;
}

test('JSON round-trip keeps ids, labels, edits, proposals, score inputs and asset mappings', () => {
    const site = survey();
    const text = JSON.stringify({format: 'fieldform-site-v1', site});
    const back = restore(JSON.parse(text).site);
    assert.deepEqual(back, site);
    assert.equal(scoring.evaluate(back, {kinds}).changes.length, scoring.evaluate(site, {kinds}).changes.length);
});

test('GLB round-trip restores the whole editable survey, textures included', () => {
    const site = survey();
    const glb = io.exportGlb(site, {kinds, heightAt: p => p[0] * .01});
    const {json} = io.parseGlb(glb);
    assert.equal(json.images.length, 1);
    assert.ok(json.meshes.some(m => m.primitives[0].attributes.TEXCOORD_0 != null), 'captured items carry UVs');
    assert.equal(json.nodes.filter(n => n.extras?.erfmap?.feature).length, site.features.length);
    const {site: back, report} = io.importGlb(glb, {kinds});
    assert.equal(report.complete, true, report.missing.join('; '));
    assert.deepEqual(restore(back), site);
    assert.equal(back.assets.ortho.data, PNG);
    const before = scoring.evaluate(site, {kinds}), after = scoring.evaluate(back, {kinds});
    assert.deepEqual(after.totals, before.totals);
});

test('GLB export is valid glTF binary with aligned chunks and in-range accessors', () => {
    const glb = io.exportGlb(survey(), {kinds});
    const dv = new DataView(glb.buffer);
    assert.equal(dv.getUint32(8, true), glb.length);
    const jsonLength = dv.getUint32(12, true);
    assert.equal(jsonLength % 4, 0);
    const {json, bin} = io.parseGlb(glb);
    for (const v of json.bufferViews) assert.ok(v.byteOffset + v.byteLength <= bin.length);
    for (const a of json.accessors) {
        const v = json.bufferViews[a.bufferView];
        assert.equal(v.byteOffset % 4, 0);
        assert.equal(a.count * {VEC2: 8, VEC3: 12}[a.type], v.byteLength);
    }
    for (const m of json.materials) assert.ok(m.pbrMetallicRoughness.baseColorFactor.every(c => c >= 0 && c <= 1));
});

test('standalone GLB imports by mesh outline and names what is missing', () => {
    const glb = io.exportGlb(survey(), {kinds});
    const {json, bin} = io.parseGlb(glb);
    delete json.asset.extras;
    json.nodes.forEach(n => { delete n.extras; });
    json.nodes[1].rotation = [0, .38, 0, .92];
    // Re-pack the stripped JSON with the same binary chunk.
    let body = new TextEncoder().encode(JSON.stringify(json));
    const pad = (4 - body.length % 4) % 4, padded = new Uint8Array(body.length + pad).fill(0x20); padded.set(body); body = padded;
    const out = new Uint8Array(12 + 8 + body.length + 8 + bin.length), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
    dv.setUint32(12, body.length, true); dv.setUint32(16, 0x4E4F534A, true); out.set(body, 20);
    dv.setUint32(20 + body.length, bin.length, true); dv.setUint32(24 + body.length, 0x004E4942, true); out.set(bin, 28 + body.length);
    const {site, report} = io.importGlb(out, {kinds});
    assert.equal(report.source, 'standalone');
    assert.equal(report.complete, false);
    assert.ok(report.missing.some(m => /no item ids/.test(m)));
    assert.ok(report.missing.some(m => /rotations/.test(m)));
    assert.ok(report.missing.some(m => /embedded image/.test(m)));
    const field = site.features.find(f => /Field house/.test(f.name));
    assert.equal(field.kind, 'building');
    assert.ok(field.height > 4);
    assert.ok(site.features.some(f => f.kind === 'tree' && f.p.length === 1));
    assert.ok(site.features.every(f => f._syncId));
    restore(site);       // still a valid, editable survey
});

test('foreign files are rejected with a clear message', () => {
    assert.throws(() => io.importGlb(new Uint8Array(40)), /Not a GLB/);
});

test('survey scripts load in the page in dependency order', () => {
    const html = fs.readFileSync(path.join(__dirname, '../erfmap-survey/index.html'), 'utf8');
    const order = ['model.js', 'scoring.js', 'walk.js', 'texture.js', 'survey-io.js', 'app.js', 'menus.js'].map(f => html.indexOf('src="' + f + '"'));
    assert.ok(order.every(i => i > 0));
    assert.ok(order.indexOf(Math.max(...order.slice(0, 6))) <= 5 && order[5] > order[4] && order[6] > order[5]);
});
