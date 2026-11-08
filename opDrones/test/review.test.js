const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createIntake} = require('../intake/jobs');
const S = require('../erfmap-intake/shared');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erfmap-review-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const id = '123456abcdef', root = path.join(directory, 'intake', id);
    fs.mkdirSync(path.join(root, 'stages', 'geometry'), {recursive: true});
    const features = [
        {id: 'roof', kind: 'building', p: [[60, 40], [80, 40], [80, 60], [60, 60]], geometry: 'area'},
        {id: 'walk', kind: 'path', p: [[0, 50], [59.5, 50]], geometry: 'line'},
        {id: 'bench', kind: 'bench', p: [[20, 55]], geometry: 'point'},
    ];
    const geometry = {features, scale: {m_per_px: 1, origin_px: [0, 0]}, extent_m: [100, 100], mosaic: {width: 100, height: 100}};
    const writeGeometry = () => fs.writeFileSync(path.join(root, 'stages/geometry/result.json'), JSON.stringify(geometry));
    writeGeometry();
    fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify({id, name: 'scene', original: {name: 'scene.jpg'}, sceneMode: 'stitched', stages: Object.fromEntries(S.STAGES.map(s => [s.id, {status: s.id === 'review' ? 'needs_review' : 'complete'}])), review: {phase: 'zones', pointsDetected: true, features: {}}, imports: []}));
    const intake = createIntake({directory, createProject: () => '1234', readBody: async req => req.body || {}});
    async function request(action, body, method = 'POST') {
        let status, data;
        const res = {writeHead(code) { status = code; }, end(text) { data = JSON.parse(text); }};
        await intake.route({method, body}, res, new URL('http://localhost/api/intake/jobs/' + id + '/' + action));
        return {status, data};
    }
    return {request, geometry, writeGeometry, readJob: () => JSON.parse(fs.readFileSync(path.join(root, 'job.json'), 'utf8'))};
}

test('review gates import through zones, dots, edge access and confirmed building entrances', async t => {
    const {request} = fixture(t);
    await assert.rejects(request('scenario', null, 'GET'), /Finish zone/);
    await assert.rejects(request('review-step', {}), /Accept or reject/);
    await request('review', {features: {roof: {status: 'accepted'}, walk: {status: 'accepted'}}});
    assert.equal((await request('review-step', {})).data.review.phase, 'points');
    await assert.rejects(request('review-step', {}), /Accept or reject/);
    await request('review', {features: {bench: {status: 'rejected'}}});
    const access = await request('review-step', {});
    assert.equal(access.data.review.phase, 'access');
    await assert.rejects(request('review-step', {}), /Accept or reject/);
    await request('review', {features: {'access-walk-0': {status: 'accepted'}}});
    await assert.rejects(request('entrance', {p: [20, 20]}), /accepted building outline/);
    const door = await request('entrance', {p: [60, 50]});
    assert.equal(door.data.review.phase, 'access');
    assert.equal((await request('review-step', {})).data.review.phase, 'ready');
    const scenario = (await request('scenario', null, 'GET')).data;
    assert.equal(scenario.format, 'fieldform-site-v1');
    assert.equal(scenario.site.features.filter(f => f.kind === 'entrance').length, 2);
    assert.equal(scenario.site.features.filter(f => f.kind === 'bench').length, 0);
    assert.equal(scenario.site.accessReviewed, true);
    const network = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../erfmap-survey/model.js'), 'utf8') + '\ngraph(site).walkingNetwork;', {site: scenario.site});
    for (const entrance of scenario.site.features.filter(f => f.kind === 'entrance')) {
        assert.ok(network.nodes.some(p => Math.hypot(p[0] - entrance.p[0][0], p[1] - entrance.p[0][1]) < .02), 'Confirmed entrances must remain connected outside the building wall');
    }
    assert.equal((await request('import')).data.code, '1234');
});

test('a rejected edge access cannot pass readiness and can be regenerated', async t => {
    const {request} = fixture(t);
    await request('review', {features: {roof: {status: 'accepted'}, walk: {status: 'accepted'}, bench: {status: 'rejected'}}});
    await request('review-step', {});
    await request('review-step', {});
    await request('entrance', {p: [60, 50]});
    await request('review', {features: {'access-walk-0': {status: 'rejected'}}});
    await assert.rejects(request('review-step', {}), /accepted access marker/);
    await request('review-step', {back: 'points'});
    const next = (await request('review-step', {})).data;
    assert.equal(next.review.features['access-walk-0'], undefined);
    await request('review', {features: {'access-walk-0': {status: 'accepted'}}});
    assert.equal((await request('review-step', {})).data.review.phase, 'ready');
});

test('path junctions are not terminals and isolated interior ends remain unresolved', () => {
    const geometry = {scale: {m_per_px: 1, origin_px: [0, 0]}, mosaic: {width: 101, height: 101}};
    const features = [{id: 'a', kind: 'path', p: [[0, 50], [100, 50]]}, {id: 'b', kind: 'path', p: [[50, 50], [50, 80]]}];
    assert.deepEqual(S.pathEnds(features, geometry).map(e => e.type), ['edge', 'edge', 'junction', 'unresolved']);
    assert.equal(S.edgeAccess(features, geometry).length, 2);
});

test('invalid feedback is rejected without running a model', async t => {
    const {request} = fixture(t);
    await assert.rejects(request('feedback', {marks: [{kind: 'building', p: [NaN, 2]}]}), /valid correction/);
    await assert.rejects(request('feedback', {marks: [{kind: 'path', p: [-10, 4]}]}), /inside the scene/);
});

 test('near-edge model paths snap to the boundary and interior ends need no markers', async t => {
    const {request, geometry, writeGeometry} = fixture(t);
    geometry.features.find(f => f.id === 'walk').p = [[5, 50], [50, 50]];
    writeGeometry();
    const features = S.reviewedFeatures(geometry, {}, [{kind: 'path', geometry: 'line'}]);
    assert.deepEqual(features.find(f => f.id === 'walk').p, [[0, 50], [50, 50]]);
    await request('review', {features: {roof: {status: 'accepted'}, walk: {status: 'accepted'}, bench: {status: 'rejected'}}});
    await request('review-step', {});
    await request('review-step', {});
    await request('review', {features: {'access-walk-0': {status: 'accepted'}}});
    assert.equal((await request('review-step', {})).data.review.phase, 'ready');
    assert.equal((await request('scenario', null, 'GET')).data.site.features.filter(f => f.kind === 'entrance').length, 1);
});


test('processing stays locked until a reference line is saved', async t => {
    const {request, readJob} = fixture(t);
    const response = await request('calibration', {markers: [], references: []});
    assert.equal(response.status, 200);
    const job = readJob();
    for (const id of ['regions', 'classification', 'merging', 'geometry', 'review']) {
        assert.equal(job.stages[id].status, 'blocked');
        assert.match(job.stages[id].summary, /reference line/);
    }
});
