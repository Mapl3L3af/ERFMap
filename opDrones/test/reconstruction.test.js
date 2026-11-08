const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Readable} = require('node:stream');
const R = require('../intake/reconstruction');
const {createIntake} = require('../intake/jobs');
const S = require('../erfmap-intake/shared');

const config = {enabled:true, url:'http://127.0.0.1:3001', buildingModel:true};
const options = ['dtm','pc-classify','dem-gapfill-steps','skip-3dmodel'].map(name=>({name}));
const engine = async url => ({ok:true, json:async()=>url.endsWith('/info') ? {engine:'odm',engineVersion:'test',maxImages:200} : options});

test('engine checks require ODM and building-model support and report connection failure', async()=>{
    assert.equal((await R.check(config, engine)).ready, true);
    await assert.rejects(R.check(config, async()=>{throw Error('offline');}), /offline/);
    await assert.rejects(R.check(config, async url=>({ok:true,json:async()=>url.endsWith('/info')?{engine:'other'}:options})), /ODM engine/);
    await assert.rejects(R.check(config, async url=>({ok:true,json:async()=>url.endsWith('/info')?{engine:'odm'}:options.slice(0,3)})), /skip-3dmodel/);
    for(const url of ['file:///tmp/a','http://user:password@localhost:3001','http://localhost:3001?token=x']) assert.throws(()=>R.configuration({...config,url}), {status:400});
});

test('per-flyover settings isolate engines and preserve legacy environment configuration',()=>{
    const inherited = {ERFMAP_NODEODM_URL:'http://old:3001',ERFMAP_RECONSTRUCTOR:'custom',OTHER:'kept'};
    assert.deepEqual(R.environment({},inherited),inherited);
    assert.deepEqual(R.environment({reconstruction:{enabled:false}},inherited),{OTHER:'kept'});
    const enabled=R.environment({reconstruction:config},inherited);
    assert.equal(enabled.ERFMAP_NODEODM_URL,config.url);
    assert.equal(enabled.ERFMAP_RECONSTRUCTOR,undefined);
    assert.equal(inherited.ERFMAP_NODEODM_URL,'http://old:3001');
});

function fixture(t) {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erf-reconstruction-'));
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    const service=createIntake({directory,createProject:()=>{},readBody:async req=>req.body||{}});
    t.after(()=>service.stopWorkers());
    async function call(address, body, req={method:'POST',body}) {
        let data;
        await service.route(req,{writeHead(){},end(text){data=JSON.parse(text);}},new URL('http://localhost/api/intake/'+address));
        return data;
    }
    return {directory,call};
}

test('optional upload persists engine choice, leaves ordinary uploads off, and enforces minimum photos', async t=>{
    t.mock.method(global,'fetch',engine);
    const {directory,call}=fixture(t);
    const upload=async suffix=>{
        const req=Readable.from([Buffer.from('photo')]);req.method='POST';req.headers={'content-type':'image/jpeg'};
        return call('jobs?name=photo.jpg&defer=1'+suffix,null,req);
    };
    assert.deepEqual((await upload('')).reconstruction,{enabled:false});
    const job=await upload('&photogrammetry=1&building_model=1&nodeodm_url='+encodeURIComponent(config.url));
    assert.deepEqual(job.reconstruction,config);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory,'intake',job.id,'job.json'))).reconstruction,config);
    await assert.rejects(call('jobs/'+job.id+'/start'), /three overlapping photographs/);
    assert.equal((await call('reconstruction-check',config)).ready,true);
});

test('existing-flyover setup rebuilds imagery, clears calibration, and survives reopening', async t=>{
    t.mock.method(global,'fetch',engine);
    const {directory,call}=fixture(t),id='abc123abc123',folder=path.join(directory,'intake',id);
    fs.mkdirSync(folder,{recursive:true});
    fs.writeFileSync(path.join(folder,'job.json'),JSON.stringify({id,media:'photos',sceneMode:'stitched',started:false,
        originals:[{},{},{}],calibration:{markers:[],references:[{id:'old'}]},review:{features:{old:{status:'accepted'}}},
        stages:Object.fromEntries(S.STAGES.map(s=>[s.id,{status:'complete'}]))}));
    const job=await call('jobs/'+id+'/reconstruction',config);
    assert.equal(job.stages.probe.status,'complete');
    assert.equal(job.stages.frames.status,'queued');
    assert.deepEqual(job.calibration.references,[]);
    assert.equal(job.reviewCount,0);
    const saved=JSON.parse(fs.readFileSync(path.join(folder,'job.json')));
    assert.deepEqual(saved.reconstruction,config);
    await assert.rejects(call('jobs/'+id+'/reconstruction',{...config,url:'bad'}),{status:400});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder,'job.json'))),saved);
});
