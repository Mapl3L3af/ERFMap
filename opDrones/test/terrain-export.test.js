const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const model=require('../erfmap-survey/model'),shared=require('../erfmap-intake/shared'),changes=require('../erfmap-survey/changes');
const grid={origin:[0,0],step:[10,10],heights:[[0,2,null],[0,2,4]]};
const site={name:'Ground test',w:20,h:10,samples:[[0,0,0],[10,0,2],[0,10,0],[10,10,2],[20,10,4]],groundGrid:grid,features:[],terrain:{source:'Measured test plane'}};
function elevation(expression){return vm.runInNewContext(['model.js','elevation.js'].map(f=>fs.readFileSync(path.join(__dirname,'../erfmap-survey',f),'utf8')).join('\n')+'\nconst s='+JSON.stringify(site)+';\n'+expression);}
test('registered ground interpolates the plane and does not bridge missing cells',()=>{
 assert.equal(model.groundGridHeight(grid,5,5),1);assert.equal(model.groundGridHeight(grid,15,5),null);assert.equal(model.groundGridHeight(grid,-1,5),null);
 assert.equal(model.groundGridFaces(grid).length,2);
 assert.equal(elevation('elevationMesh(s).at([15,5])'),null);
 assert.equal(elevation('terrainProfile(s,[1,5],[19,5]).incomplete'),true);
});
test('contour spacing respects observed cells and rejects unbounded workloads',()=>{
 const lines=elevation('contourSegments(s,1)');assert.ok(lines.length);assert.ok(lines.every(c=>c.points.every(p=>p[0]<=10)));
 assert.ok(lines.filter(c=>c.height===1).every(c=>c.points.every(p=>p[0]===5)));
 assert.throws(()=>elevation('contourSegments(s,0)'),/interval/);assert.throws(()=>elevation('contourSegments(s,.000001)'),/interval/);
});
test('GLB ground includes real elevations and round-trips the editable survey',()=>{
 const bytes=shared.buildGlb(site,[]),v=new DataView(bytes.buffer),gltf=JSON.parse(new TextDecoder().decode(bytes.slice(20,20+v.getUint32(12,true))));
 const pos=gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];assert.equal(pos.count,6);assert.equal(pos.max[1],2);assert.equal(pos.max[0],10);
 assert.deepEqual(model.restore(shared.readGlb(bytes).site),site);assert.match(gltf.asset.extras.elevation,/Terrain/);
 assert.throws(()=>shared.readGlb(bytes.slice(0,21)),/Invalid/);
});
test('ground topology and contour preferences synchronize with collaborators',()=>{
 const previous={...site,groundGrid:undefined,terrain:undefined,contourInterval:undefined};
 const next={...site,contourInterval:.5};const patch=changes.diff(previous,next);assert.deepEqual(changes.apply(previous,patch),next);
});
test('restoring a corrupt terrain or grid is rejected',()=>{
 assert.throws(()=>model.restore({...site,groundGrid:{...grid,step:[0,1]}}),/grid/);
 assert.throws(()=>model.restore({...site,samples:[null]}),/Invalid/);
 assert.throws(()=>model.restore({...site,contours:[null]}),/Invalid/);
});
test('intake conversion shifts the ground grid together with feature coordinates',()=>{
 const terrain={groundGrid:grid,samples:site.samples,contours:[],source:'test'};
 const result=shared.buildSite({job:{id:'test',name:'test',original:{name:'test.jpg'}},geometry:{scale:{},terrain},features:[{id:'a',status:'accepted',kind:'grass',geometry:'area',p:[[5,5],[10,5],[10,10]],frames:[]}],labels:[]});
 assert.deepEqual(result.groundGrid.origin,[-3,-3]);assert.deepEqual(result.samples[0],[-3,-3,0]);
});
test('GLB exports visible contours as elevated line geometry',()=>{
 const bytes=shared.buildGlb({...site,contours:[{height:1,points:[[5,0],[5,10]]}]},[]),v=new DataView(bytes.buffer);
 const gltf=JSON.parse(new TextDecoder().decode(bytes.slice(20,20+v.getUint32(12,true))));
 const line=gltf.meshes.find(m=>m.name==='Relative ground contours').primitives[0];assert.equal(line.mode,1);assert.equal(gltf.accessors[line.attributes.POSITION].count,2);
 assert.equal(gltf.accessors[line.attributes.POSITION].min[1],1.025);
});
