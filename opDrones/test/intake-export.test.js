const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createIntake} = require('../intake/jobs');
const S = require('../erfmap-intake/shared');
const {restore, kinds} = require('../erfmap-survey/model');
const io = require('../erfmap-survey/survey-io');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFklEQVR4nGP4z8DwHxkzEBEQGgYMDABq4w/xXgSdlgAAAABJRU5ErkJggg==', 'base64');

function job(t, {fusion} = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erfmap-export-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const id = 'abcdef654321', root = path.join(directory, 'intake', id);
    fs.mkdirSync(path.join(root, 'stages', 'geometry'), {recursive: true});
    fs.writeFileSync(path.join(root, 'stages', 'geometry', 'mosaic.png'), PNG);
    const features = [
        {id: 'roof', kind: 'building', p: [[60, 40], [80, 40], [80, 60], [60, 60]], geometry: 'area'},
        {id: 'lawn', kind: 'grass', p: [[0, 0], [50, 0], [50, 40], [0, 40]], geometry: 'area'},
        {id: 'oak', kind: 'tree', p: [[20, 20]], geometry: 'point'},
    ];
    const geometry = {features, scale: {m_per_px: 1, origin_px: [0, 0]}, extent_m: [100, 100], mosaic: {image: 'stages/geometry/mosaic.png', width: 101, height: 101},
        geometry_fusion: fusion || {used: false, reason: 'No reconstruction for this job; labels come from imagery only.', changed: []}};
    fs.writeFileSync(path.join(root, 'stages/geometry/result.json'), JSON.stringify(geometry));
    fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify({id, name: 'park.mp4', original: {name: 'park.mp4'}, sceneMode: 'stitched',
        stages: Object.fromEntries(S.STAGES.map(s => [s.id, {status: 'complete'}])),
        review: {phase: 'ready', features: Object.fromEntries(features.map(f => [f.id, {status: 'accepted'}]))}, imports: []}));
    const intake = createIntake({directory, createProject: () => '1234', readBody: async req => req.body || {}});
    return async () => {
        let data;
        const res = {writeHead() {}, end(text) { data = JSON.parse(text); }};
        await intake.route({method: 'GET'}, res, new URL('http://localhost/api/intake/jobs/' + id + '/scenario'));
        return data;
    };
}

test('intake export carries the flyover photo, per-item texture mappings and stable ids', async t => {
    const {site} = await job(t)();
    assert.equal(site.assets.flyover.data, 'data:image/png;base64,' + PNG.toString('base64'));
    assert.deepEqual(site.assets.flyover.bounds, [0, 0, 100, 100]);
    assert.deepEqual(site.features.find(f => f.name === 'Grass' || f.kind === 'grass').texture, {asset: 'flyover', projection: 'planar-xy'});
    assert.equal(site.features.find(f => f.kind === 'tree').texture, undefined, 'trees keep their 3D model colours');
    assert.ok(site.features.every(f => /^intake-abcdef654321-/.test(f._syncId)));
    assert.equal(site.samples.length, 0);
    assert.equal(site.reconstruction.heights, 'none');
    // The export opens in the survey and survives a textured GLB round-trip.
    const back = io.importGlb(io.exportGlb(restore(site), {kinds}), {kinds});
    assert.equal(back.report.complete, true);
    assert.deepEqual(back.site.features, site.features);
    assert.equal(back.site.assets.flyover.data, site.assets.flyover.data);
});

test('reconstructed ground heights become relative survey samples with contours on', async t => {
    const fusion = {used: true, coverage: .9, vertical_error_m: .2, changed: [{id: 'roof', from: 'pavement', to: 'building'}],
        ground_samples: [[0, 0, 0], [50, 0, 1.5], [0, 50, .5], [50, 50, 2]]};
    const {site} = await job(t, {fusion})();
    assert.equal(site.samples.length, 4);
    assert.deepEqual(site.samples[1], [50, 0, 1.5]);
    assert.equal(site.showContours, true);
    assert.match(site.reconstruction.heights, /relative/);
    assert.equal(site.reconstruction.relabelled, 1);
});
