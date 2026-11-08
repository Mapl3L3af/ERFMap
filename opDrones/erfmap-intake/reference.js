// Small-site WGS84 control points and imported reference geometry. No network calls.
(function(root,factory){const api=factory();if(typeof module!=='undefined')module.exports=api;else root.mapReference=api;})(typeof self!=='undefined'?self:this,()=>{
'use strict';
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const point=p=>Array.isArray(p)&&p.length===2&&p.every(finite);
const geo=p=>point(p)&&Math.abs(p[0])<=180&&Math.abs(p[1])<=85;
function prepare(input, size){
 if(!input||!Array.isArray(input.anchors)||input.anchors.length<1||input.anchors.length>20)throw Error('Add one or more matched coordinate points.');
 const anchors=input.anchors.map(a=>{if(!point(a.pixel)||!geo(a.coordinate)||a.pixel[0]<0||a.pixel[1]<0||a.pixel[0]>=size[0]||a.pixel[1]>=size[1])throw Error('Each control point needs an image point and longitude/latitude.');return {pixel:[...a.pixel],coordinate:[...a.coordinate]};});
 const source=String(input.source||'User map reference').slice(0,200), datum=String(input.verticalDatum||'').slice(0,100);
 const origin=anchors[0].coordinate, mx=111319.49*Math.cos(origin[1]*Math.PI/180), my=111319.49;
 const local=p=>{const q=[(p[0]-origin[0])*mx,(origin[1]-p[1])*my];if(Math.max(...q.map(Math.abs))>20000)throw Error('Keep reference points and shapes within 20 km of the first control point.');return q;};
 const pairs=anchors.map(a=>({p:a.pixel,q:local(a.coordinate)}));
 const mean=key=>[0,1].map(k=>pairs.reduce((s,a)=>s+a[key][k],0)/pairs.length);
 const pc=mean('p'),qc=mean('q');let den=0,aa=0,bb=0;
 for(const {p,q} of pairs){const x=p[0]-pc[0],y=p[1]-pc[1],e=q[0]-qc[0],s=q[1]-qc[1];den+=x*x+y*y;aa+=x*e+y*s;bb+=x*s-y*e;}
 let transform=null;
 if(anchors.length>=2){
  if(den<4)throw Error('Spread the matched image points farther apart.');
  const a=aa/den,b=bb/den,scale=Math.hypot(a,b);
  if(!finite(scale)||scale<=0||Math.hypot(...local(anchors[1].coordinate))<1)throw Error('Coordinate points must be at least one metre apart.');
  const tx=qc[0]-a*pc[0]+b*pc[1],ty=qc[1]-b*pc[0]-a*pc[1];
  const rms=Math.sqrt(pairs.reduce((sum,{p,q})=>sum+(a*p[0]-b*p[1]+tx-q[0])**2+(b*p[0]+a*p[1]+ty-q[1])**2,0)/pairs.length);
  if(rms>Math.max(3,scale*10))throw Error('Matched points disagree. Check coordinates and click positions.');
  transform={a,b,tx,ty,metresPerPixel:scale,rms_m:rms,origin:[...origin]};
 }
 const features=input.features||[];
 if(!Array.isArray(features)||features.length>2000)throw Error('Reference supports up to 2000 features.');
 if(features.length&&!transform)throw Error('Match at least two points before importing shapes. One point anchors position only.');
 let vertices=0;
 const projected=features.map((f,index)=>{
  if(!['building','path','ground'].includes(f.kind)||!Array.isArray(f.coordinates))throw Error('Reference kind must be building, path or ground.');
  const min=f.kind==='building'?3:f.kind==='path'?2:1;
  if(f.coordinates.length<min||f.coordinates.length>10000||!f.coordinates.every(geo)||(vertices+=f.coordinates.length)>100000)throw Error('Invalid reference geometry.');
  if(f.kind==='ground'&&f.coordinates.length!==1)throw Error('Each ground reference needs exactly one coordinate.');
  if(f.kind==='ground'&&(!finite(f.elevation_m)||!datum))throw Error('Ground checks need explicit elevation in metres and a vertical datum.');
  const width=f.width_m??3;
  if(f.kind==='path'&&(!finite(width)||width<=0||width>100))throw Error('Path reference width must be between zero and 100 metres.');
  const {a,b,tx,ty}=transform,d=a*a+b*b;
  const pixels=f.coordinates.map(p=>{const [e,s]=local(p),x=e-tx,y=s-ty;return [(a*x+b*y)/d,(-b*x+a*y)/d];});
  return {id:String(f.id||'reference-'+index).slice(0,80),kind:f.kind,points:pixels,...(f.kind==='path'?{width_px:width/transform.metresPerPixel,width_m:width,width_source:f.width_m==null?'assumed':'supplied'}:{}),...(f.kind==='ground'?{elevation_m:f.elevation_m}:{})};
 });
 return {version:1,source,verticalDatum:datum,anchors,transform,features:projected,inputFeatures:features,status:transform?'aligned':'position-only',note:'User map reference; approximate alignment. Reference-assisted agreement is not independent model accuracy.'};
}
function geojson(data){
 if(data?.type!=='FeatureCollection'||!Array.isArray(data.features)||data.crs)throw Error('Choose a WGS84 GeoJSON FeatureCollection.');
 return data.features.map((f,i)=>{const g=f.geometry||{},p=f.properties||{},kind=p.kind||p.class;
  if(kind==='building'&&g.type==='Polygon'&&g.coordinates.length===1)return {id:p.name||String(i),kind,coordinates:g.coordinates[0].map(p=>p.slice(0,2))};
  if(kind==='path'&&g.type==='LineString')return {id:p.name||String(i),kind,coordinates:g.coordinates.map(p=>p.slice(0,2)),...(p.width_m!=null?{width_m:p.width_m}:{})};
  if(kind==='ground'&&g.type==='Point'&&finite(g.coordinates[2]))return {id:p.name||String(i),kind,coordinates:[g.coordinates.slice(0,2)],elevation_m:g.coordinates[2]};
  throw Error('Use building Polygon, path LineString, or ground Point with elevation, and properties.kind. Polygon holes are not supported.');
 });
}
return {prepare,geojson};
});
