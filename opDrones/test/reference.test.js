const {test}=require('node:test');
const assert=require('node:assert/strict');
const R=require('../erfmap-intake/reference');
const mx=111319.49*Math.cos(40*Math.PI/180),my=111319.49;
const origin=[-74,40],coordinate=(east,south)=>[origin[0]+east/mx,origin[1]-south/my];
const anchors=[{pixel:[100,100],coordinate:coordinate(0,0)},{pixel:[200,100],coordinate:coordinate(0,20)},{pixel:[100,200],coordinate:coordinate(-20,0)}];

test('matched ground points recover rotated scale and imported geometry',()=>{
 const r=R.prepare({anchors,source:'Google Earth user export',features:[{kind:'building',coordinates:[coordinate(-4,4),coordinate(-4,8),coordinate(-8,8)]},{kind:'path',width_m:4,coordinates:[coordinate(0,0),coordinate(0,20)]}]},[1000,1000]);
 assert.ok(Math.abs(r.transform.metresPerPixel-.2)<1e-7);
 assert.ok(r.transform.rms_m<1e-7);
 assert.equal(r.source,'Google Earth user export');
 assert.ok(Math.abs(r.features[0].points[0][0]-120)<1e-6);
 assert.ok(Math.abs(r.features[0].points[0][1]-120)<1e-6);
 assert.ok(Math.abs(r.features[1].width_px-20)<1e-6);
});

test('one coordinate is position only and cannot silently align map shapes',()=>{
 assert.equal(R.prepare({anchors:anchors.slice(0,1)},[1000,1000]).status,'position-only');
 assert.throws(()=>R.prepare({anchors:anchors.slice(0,1),features:[{kind:'path',coordinates:[coordinate(0,0),coordinate(0,20)]}]},[1000,1000]),/two points/);
});

test('elevation checks require explicit heights and datum; ordinary map shapes carry no terrain',()=>{
 const base={anchors,features:[{kind:'ground',coordinates:[coordinate(0,0)],elevation_m:100}]};
 assert.throws(()=>R.prepare(base,[1000,1000]),/vertical datum/);
 const r=R.prepare({...base,verticalDatum:'Supplier datum'},[1000,1000]);
 assert.equal(r.features[0].elevation_m,100);
 const features=R.geojson({type:'FeatureCollection',features:[{properties:{kind:'ground'},geometry:{type:'Point',coordinates:[-74,40,100]}}]});
 assert.equal(features[0].elevation_m,100);
});

test('invalid controls, distant references, unsupported geometry and large misalignment are rejected',()=>{
 assert.throws(()=>R.prepare({anchors:[{pixel:[-1,0],coordinate:origin}]},[100,100]),/image point/);
 assert.throws(()=>R.prepare({anchors,features:[{kind:'path',coordinates:[[0,0],[1,1]]}]},[1000,1000]),/20 km/);
 assert.throws(()=>R.prepare({anchors:[...anchors.slice(0,2),{pixel:[100,200],coordinate:coordinate(100,200)}]},[1000,1000]),/disagree/);
 assert.throws(()=>R.geojson({type:'FeatureCollection',features:[{properties:{kind:'building'},geometry:{type:'Polygon',coordinates:[[],[]]}}]}),/holes/);
});

const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createIntake}=require('../intake/jobs');
const S=require('../erfmap-intake/shared');

test('reference route persists priors, supplies optional coordinate scale, and invalidates stale geometry',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erf-reference-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const id='cafecafecafe',folder=path.join(directory,'intake',id);
 fs.mkdirSync(path.join(folder,'stages/correction'),{recursive:true});
 fs.writeFileSync(path.join(folder,'stages/correction/result.json'),JSON.stringify({mosaic:{width:1000,height:1000}}));
 const stages=Object.fromEntries(S.STAGES.map(s=>[s.id,{status:'complete',attempts:1}]));
 fs.writeFileSync(path.join(folder,'job.json'),JSON.stringify({id,started:false,sceneMode:'stitched',stages,calibration:{references:[],markers:[]},review:{features:{old:{status:'accepted'}}}}));
 const service=createIntake({directory,createProject:()=>{},readBody:async req=>req.body});
 t.after(()=>service.stopWorkers());
 async function call(action,body){let result;await service.route({method:'POST',body},{writeHead(){},end(s){result=JSON.parse(s);}},new URL('http://localhost/api/intake/jobs/'+id+'/'+action));return result;}
 let job=await call('map-reference',{anchors,source:'Test reference',features:[{kind:'path',coordinates:[coordinate(0,0),coordinate(0,20)]}]});
 assert.equal(job.mapReference.source,'Test reference');
 assert.equal(job.stages.regions.status,'queued');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder,'reference.json'))).features,job.mapReference.features);
 assert.ok(Math.abs(job.calibration.references[0].metres-20)<1e-7);
 assert.equal(job.calibration.references[0].id,'MAPREF');
 job=await call('map-reference',{clear:true});
 assert.equal(job.mapReference,null);
 assert.equal(job.calibration.references.length,0);
});
