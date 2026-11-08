const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createIntake} = require('../intake/jobs');
const S = require('../erfmap-intake/shared');

function fixture(t, usable = true, legacy = false) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erfmap-capture-'));
    t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
    const id = 'cafecafecafe', folder = path.join(directory, 'intake', id);
    fs.mkdirSync(path.join(folder, 'stages/capture'), {recursive:true});
    const report = {readiness: 'blocked', images: [{id:'a', excluded: !usable}], reasons: ['Disconnected image groups.']};
    fs.writeFileSync(path.join(folder, 'stages/capture/result.json'), JSON.stringify(report));
    const stages = Object.fromEntries(S.STAGES.map(s => [s.id, {status: ['probe','frames'].includes(s.id) ? 'complete' : s.id === 'capture' ? 'needs_review' : 'blocked', attempts: 1}]));
    if (legacy) { delete stages.capture; stages.correction.status = 'complete'; fs.unlinkSync(path.join(folder, 'stages/capture/result.json')); }
    fs.writeFileSync(path.join(folder, 'job.json'), JSON.stringify({id, started:false, stages, calibration:{references:[]}, review:{features:{}}}));
    const intake = createIntake({directory, createProject:()=>{}, readBody:async req => req.body || {}});
    t.after(() => intake.stopWorkers());
    async function request(action, body = {}, method = 'POST') {
        let data;
        const response = {writeHead(){},end(text){data=JSON.parse(text);}};
        await intake.route({method,body},response,new URL('http://localhost/api/intake/jobs/'+id+'/'+action));
        return data;
    }
    return {request, folder};
}

test('capture warnings gate later retries and acknowledgment is saved', async t => {
    const {request, folder} = fixture(t);
    await assert.rejects(request('stages/correction/retry'), /Review capture checks/);
    await assert.rejects(request('capture-review', {action:'skip'}), /continue-2d/);
    const job = await request('capture-review', {action:'continue-2d'});
    assert.equal(job.captureReview.action, 'continue-2d');
    assert.equal(job.captureReview.readiness, 'blocked');
    assert.ok(job.captureReview.at);
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'job.json'))).captureReview.action, 'continue-2d');
    await request('stages/capture/retry');
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'job.json'))).captureReview, undefined);
});

test('zero usable images cannot be acknowledged', async t => {
    const {request} = fixture(t, false);
    await assert.rejects(request('capture-review', {action:'continue-2d'}), /No usable images/);
});

test('older jobs gain a skipped capture stage without invalidating completed processing', async t => {
    const {request} = fixture(t, true, true);
    const report = await request('stages/capture', {}, 'GET');
    assert.equal(report.status, 'complete');
});

test('measurement saves height with scale and rejects invalid height without changing the job', async t => {
    const {request, folder} = fixture(t);
    const calibration = {markers: [], references: [{id:'D1', a:[10,10], b:[100,10], metres:9, confirmed:true}], height_agl_m:31};
    const job = await request('calibration', calibration);
    assert.equal(job.captureProfile.height_agl_m, 31);
    assert.equal(job.captureProfile.height_source, 'user-supplied');
    assert.equal(job.calibration.references[0].metres, 9);
    const saved = JSON.parse(fs.readFileSync(path.join(folder, 'job.json')));
    assert.equal(saved.captureProfile.height_agl_m, 31);
    await assert.rejects(request('calibration', {...calibration, height_agl_m:-1}), {status:400});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'job.json'))), saved);
});
