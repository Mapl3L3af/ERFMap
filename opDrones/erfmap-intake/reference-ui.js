'use strict';
function mountMapReference(host, {job, mosaic, fileUrl, save}) {
 const detail=document.createElement('details');detail.className='map-details map-reference';detail.open=true;
 detail.innerHTML='<summary>Coordinates</summary><div class="reference-viewer"></div><div class="reference-points"></div><button type="button" data-add>Add point</button><details><summary>Additional fields</summary><p><label>Source <input data-source type="text" maxlength="200"></label></p><p><label>Import shapes <input data-file type="file" accept=".kml,.json,.geojson"></label> <label>Line class <select data-kind><option value="path">Path</option><option value="building">Building</option></select></label></p><p><label>Vertical datum <input data-datum type="text" maxlength="100"></label></p></details><p class="reference-summary"></p><div class="row"><button type="button" data-save class="primary">Save coordinates</button><button type="button" data-clear>Clear coordinates</button></div><p class="reference-status" role="status"></p>';
 host.append(detail);
 const q=s=>detail.querySelector(s),state=JSON.parse(JSON.stringify(job.mapReference||{}));
 let anchors=state.anchors||[{pixel:null,coordinate:null},{pixel:null,coordinate:null}],features=state.inputFeatures||[],picking=null,v=null;
 q('[data-source]').value=state.source||'';q('[data-datum]').value=state.verticalDatum||'';
 const status=s=>q('.reference-status').textContent=s;
 function read(){return anchors.filter(a=>a.pixel||a.coordinate).map(a=>{if(!a.pixel||!a.coordinate)throw Error('Each used control point needs both a click and latitude/longitude.');return a;});}
 function input(){return {anchors:read(),features,source:q('[data-source]').value,verticalDatum:q('[data-datum]').value};}
 function draw(){
  if(!v)return;let svg='';const k=v.scale;
  for(let i=0;i<anchors.length;i++){const p=anchors[i].pixel;if(!p)continue;svg+='<circle cx="'+p[0]+'" cy="'+p[1]+'" r="'+6*k+'" fill="#fff" stroke="#155d76" stroke-width="2" vector-effect="non-scaling-stroke"/><text x="'+(p[0]+9*k)+'" y="'+p[1]+'" font-size="'+14*k+'" fill="#fff" stroke="#111" stroke-width="'+.3*k+'">'+(i+1)+'</text>';}
  try{const r=mapReference.prepare(input(),[mosaic.width,mosaic.height]);for(const f of r.features){if(f.kind==='ground')continue;svg+='<'+(f.kind==='building'?'polygon':'polyline')+' points="'+f.points.map(p=>p.join(',')).join(' ')+'" fill="'+(f.kind==='building'?'#6699ff33':'none')+'" stroke="'+(f.kind==='building'?'#88aaff':'#f4ca63')+'" stroke-width="'+(f.width_px||2*k)+'" opacity="0.55"/>';}
   q('.reference-summary').textContent='';
  }catch{q('.reference-summary').textContent='';}
  v.draw(svg);
 }
 function rows(){
  const list=q('.reference-points');list.replaceChildren();
  anchors.forEach((a,i)=>{const row=document.createElement('div');row.className='row';row.innerHTML='<button type="button">Pick image point '+(i+1)+'</button><label>Latitude <input type="number" step="any" min="-85" max="85" aria-label="Latitude for point '+(i+1)+'"></label><label>Longitude <input type="number" step="any" min="-180" max="180" aria-label="Longitude for point '+(i+1)+'"></label><button type="button" aria-label="Remove point '+(i+1)+'">Remove</button>';
   const fields=row.querySelectorAll('input'),buttons=row.querySelectorAll('button');fields[0].value=a.coordinate?.[1]??'';fields[1].value=a.coordinate?.[0]??'';
   for(const field of fields)field.oninput=()=>{a.coordinate=fields[0].value!==''&&fields[1].value!==''?[Number(fields[1].value),Number(fields[0].value)]:null;draw();};
   buttons[0].onclick=()=>{picking=i;status('Click the matching ground location for point '+(i+1)+'.');};
   buttons[1].onclick=()=>{anchors.splice(i,1);picking=null;rows();draw();};list.append(row);
  });
 }
 detail.ontoggle=()=>{if(detail.open&&!v){v=createViewer(q('.reference-viewer'),{image:fileUrl(mosaic.image),width:mosaic.width,height:mosaic.height,hint:'Choose a control-point button, then click its ground position.'});v.redraw=draw;v.onClick=p=>{if(picking==null)return;if(p[0]<0||p[1]<0||p[0]>=mosaic.width||p[1]>=mosaic.height)return;anchors[picking].pixel=p;picking=null;status('Image point set. Enter its latitude and longitude.');draw();};draw();}};
 q('[data-add]').onclick=()=>{if(anchors.length>=20)return;anchors.push({pixel:null,coordinate:null});rows();};
 q('[data-datum]').oninput=draw;
 q('[data-file]').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>8*1024*1024)throw Error('Reference file is too large (maximum 8 MB).');const text=await file.text();features=/\.kml$/i.test(file.name)?readReferenceKml(text,q('[data-kind]').value):mapReference.geojson(JSON.parse(text));status('Imported '+features.length+' reference features. Check the alignment preview before saving.');draw();}catch(error){status(error.message);}e.target.value='';};
 async function submit(clear){try{const data=clear?{clear:true}:input();if(!clear)mapReference.prepare(data,[mosaic.width,mosaic.height]);q('[data-save]').disabled=q('[data-clear]').disabled=true;status('Saving reference…');await save(data);status('Reference saved. Reprocessing…');}catch(error){status(error.message);}finally{q('[data-save]').disabled=q('[data-clear]').disabled=false;}}
 q('[data-save]').onclick=()=>submit(false);q('[data-clear]').onclick=()=>submit(true);rows();
}
function readReferenceKml(text, lineKind) {
 const xml=new DOMParser().parseFromString(text,'application/xml');
 if(xml.getElementsByTagName('parsererror').length)throw Error('Invalid KML.');
 const tags=(e,name)=>Array.from(e.getElementsByTagNameNS('*',name)),first=(e,name)=>tags(e,name)[0];
 const coordinates=e=>{const value=first(e,'coordinates')?.textContent.trim();if(!value)throw Error('KML shape has no coordinates.');return value.split(/\s+/).map(p=>p.split(',').map(Number));};
 const features=[];
 for(const placemark of tags(xml,'Placemark')){
  const name=first(placemark,'name')?.textContent||'Reference';
  for(const polygon of tags(placemark,'Polygon')){if(tags(polygon,'innerBoundaryIs').length)throw Error('KML polygons with holes are not supported.');features.push({id:name,kind:'building',coordinates:coordinates(polygon).map(p=>p.slice(0,2))});}
  for(const line of tags(placemark,'LineString')){if(lineKind!=='path')throw Error('Building references need polygons.');features.push({id:name,kind:'path',coordinates:coordinates(line).map(p=>p.slice(0,2))});}
  for(const point of tags(placemark,'Point')){if(first(point,'altitudeMode')?.textContent.trim()!=='absolute')throw Error('KML point elevation must explicitly use absolute altitude. Clamp-to-ground points cannot check contours.');const p=coordinates(point)[0];features.push({id:name,kind:'ground',coordinates:[p.slice(0,2)],elevation_m:p[2]});}
 }
 if(!features.length)throw Error('No supported building polygons, path lines or explicit elevation points in this KML.');
 return features;
}
