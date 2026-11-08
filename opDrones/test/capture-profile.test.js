const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Readable} = require('node:stream');
const {createIntake} = require('../intake/jobs');
const {captureProfile} = require('../intake/capture-profile');
const S = require('../erfmap-intake/shared');

test('new uploads persist assumed 25 m or a supplied height, including after restart', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erf-height-'));
    t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
    const options = {directory, createProject:()=>{}, readBody:async()=>({})};
    const service = createIntake(options);
    t.after(() => service.stopWorkers());
    const upload = async suffix => {
        const req = Readable.from([Buffer.from('test-photo')]);
        req.method = 'POST'; req.headers = {'content-type':'image/jpeg'};
        let result;
        await service.route(req, {writeHead(){},end(data){result=JSON.parse(data);}}, new URL('http://localhost/api/intake/jobs?name=test.jpg&defer=1'+suffix));
        return result;
    };
    const assumed = await upload(''), supplied = await upload('&height_agl_m=24');
    assert.equal(assumed.captureProfile.height_agl_m, 25);
    assert.equal(assumed.captureProfile.height_source, 'assumed');
    assert.equal(supplied.captureProfile.height_agl_m, 24);
    assert.equal(supplied.captureProfile.height_source, 'user-supplied');
    await assert.rejects(upload('&height_agl_m=NaN'), {status:400});
    const restarted = createIntake(options);
    t.after(() => restarted.stopWorkers());
    let saved;
    await restarted.route({method:'GET'}, {writeHead(){},end(data){saved=JSON.parse(data);}}, new URL('http://localhost/api/intake/jobs/'+assumed.id));
    assert.deepEqual(saved.captureProfile, assumed.captureProfile);
});

test('height context travels through export without changing measured scale or terrain', () => {
    const geometry = {features:[], scale:{m_per_px:0.02, origin_px:[0,0]}, mosaic:{width:100,height:100}};
    const job = {id:'test',name:'test.jpg',original:{name:'test.jpg'},sceneMode:'stitched'};
    const legacy = S.buildSite({job,geometry,features:[],labels:[]});
    const current = S.buildSite({job:{...job,captureProfile:captureProfile()},geometry,features:[],labels:[]});
    assert.equal(current.localScale.captureProfile.height_agl_m,25);
    assert.equal(legacy.localScale.captureProfile,null);
    assert.equal(current.localScale.metresPerPixel,0.02);
    assert.equal(current.w,legacy.w);
    assert.equal(current.h,legacy.h);
    assert.deepEqual(current.samples,[]);
});

test('invalid supplied heights cannot become capture assumptions', () => {
    for (const value of ['', ' ', '0', '-2', 'Infinity', 'abc', true]) assert.throws(()=>captureProfile(value), {status:400});
});
