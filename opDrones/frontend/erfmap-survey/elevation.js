// All survey views sample the same triangulated terrain used by the walkthrough.
// Source samples remain separate from interpolated readings.
const elevationMeshes = new WeakMap();
function elevationMesh(site) {
    const cached=elevationMeshes.get(site);
    if(cached && cached.samples===site.samples && cached.w===site.w && cached.h===site.h && cached.groundGrid===site.groundGrid)return cached;
    if(site.groundGrid){
        const g=site.groundGrid,faces=groundGridFaces(g),heights=g.heights.flat().filter(z=>z!==null);
        const mesh={samples:site.samples,groundGrid:site.groundGrid,w:site.w,h:site.h,faces,at:p=>groundGridHeight(g,...p),min:Math.min(...heights),max:Math.max(...heights)};
        elevationMeshes.set(site,mesh);return mesh;
    }
    const steps=48, grid=[];
    for(let y=0;y<=steps;y++){
        grid[y]=[];
        for(let x=0;x<=steps;x++){
            const p=[x*site.w/steps,y*site.h/steps];
            grid[y][x]=[...p,terrain(site,...p)];
        }
    }
    const faces=[];
    for(let y=0;y<steps;y++)for(let x=0;x<steps;x++){
        const a=grid[y][x],b=grid[y][x+1],c=grid[y+1][x+1],d=grid[y+1][x];
        faces.push([a,b,c],[a,c,d]);
    }
    function at(p) {
        const u=Math.max(0,Math.min(steps-.0000001,p[0]*steps/site.w));
        const v=Math.max(0,Math.min(steps-.0000001,p[1]*steps/site.h));
        const x=Math.floor(u),y=Math.floor(v),a=u-x,b=v-y;
        const z=grid[y][x][2],r=grid[y][x+1][2],d=grid[y+1][x][2],e=grid[y+1][x+1][2];
        return a>b?z*(1-a)+r*(a-b)+e*b:z*(1-b)+d*(b-a)+e*a;
    }
    const heights=grid.flat().map(p=>p[2]);
    const mesh={samples:site.samples,w:site.w,h:site.h,steps,grid,faces,at,min:Math.min(...heights),max:Math.max(...heights)};
    elevationMeshes.set(site,mesh);return mesh;
}
function contourSegments(site,interval) {
    const mesh=elevationMesh(site);
    if(!Number.isFinite(interval)||interval<=0||(mesh.max-mesh.min)/interval>200)throw Error('Choose a contour interval with at most 200 elevation levels.');
    const segments=[];
    for(const triangle of elevationMesh(site).faces){
        const low=Math.min(...triangle.map(p=>p[2])),high=Math.max(...triangle.map(p=>p[2]));
        for(let level=Math.ceil(low/interval);level<Math.ceil(high/interval);level++){
            const height=level*interval;
            const points=[];
            for(const [a,b] of edges(triangle,true)){
                if((a[2]<=height&&b[2]>height)||(b[2]<=height&&a[2]>height)){
                    const t=(height-a[2])/(b[2]-a[2]);points.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);
                }
            }
            if(points.length===2 && dist(...points)>1e-9)segments.push({height,points});
            if(segments.length>100000)throw Error('Too many contour segments. Increase the interval.');
        }
    }
    return segments;
}
function contourInterval(site) {
    const mesh=elevationMesh(site),range=mesh.max-mesh.min;
    return range<=5?.5:range<=20?1:10**Math.floor(Math.log10(range/10));
}
function scenarioContours(site) {
    return site.contourInterval ? contourSegments(site,site.contourInterval) : site.contours ?? (site.samples.length ? contourSegments(site,contourInterval(site)) : []);
}
function terrainProfile(site,a,b) {
    const mesh=elevationMesh(site),distance=dist(a,b),samples=[];
    let rise=0,fall=0;
    for(let i=0;i<=100;i++){
        const z=mesh.at(a.map((v,k)=>v+(b[k]-v)*i/100));samples.push(z);
        if(i){const d=z-samples[i-1];rise+=Math.max(0,d);fall+=Math.max(0,-d);}
    }
    if(samples.some(z=>z===null))return {samples,distance,incomplete:true};
    return {samples,distance,rise,fall,change:samples.at(-1)-samples[0],grade:distance?(samples.at(-1)-samples[0])/distance*100:0};
}
let profilePoints=[],contours=true,contourCache=new WeakMap();
function elevationPlan(showProfile=false) {
    if(!site.samples.length && !site.contours?.length)return '';
    const mesh=elevationMesh(site);
    let cached=contourCache.get(mesh);
    if(!cached){cached=scenarioContours(site);contourCache.set(mesh,cached);}
    let output='';
    if(contours){
        const labelled=new Set();
        for(const segment of cached){
            const p=segment.points.map(project);output+=line(p,'#4c4a48',.7,'opacity=".65" pointer-events="none"');
            if(!labelled.has(segment.height)&&dist(...p)>8){output+=label(p[0],segment.height.toFixed(1)+' m',9);labelled.add(segment.height);}
        }
    }
    if(!showProfile)return output;
    profilePoints.forEach((p,i)=>{output+=circle(project(p),5,'#fff','#233c4e')+label([project(p)[0],project(p)[1]-10],(i?'B':'A')+' · '+(mesh.at(p)===null?'No ground data':mesh.at(p).toFixed(2)+' m'));});
    if(profilePoints.length===2)output+=line(profilePoints.map(project),'#233c4e',2,'stroke-dasharray="5 4" pointer-events="none"');
    return output;
}
function elevationControls(){
    if(!site.samples.length)return '';
    let h='';
    if(view3)return h+'<p class="note">Return to the plan to measure a terrain profile.</p>';
    h+='<h3>Elevation profile</h3><p>Click A and B on the plan. A third click starts a new profile.</p>';
    if(profilePoints.length===1)h+='<p class="note">A · '+(elevationMesh(site).at(profilePoints[0])?.toFixed(2) ?? 'No ground data')+' m. Choose B.</p>';
    if(profilePoints.length!==2)return h;
    const p=terrainProfile(site,...profilePoints);
    if(p.incomplete)return h+'<p class="note">This profile crosses missing ground observations. Choose endpoints within continuous measured coverage.</p>';
    const min=Math.min(...p.samples),max=Math.max(...p.samples),range=max-min;
    const graph=p.samples.map((z,i)=>[25+i*2,95-(range?(z-min)/range:.5)*65]);
    h+='<svg class="profile-chart" viewBox="0 0 250 125" role="img" aria-label="Interpolated terrain elevation profile">'+line(graph,'#315c70',2)+label([125,14],min.toFixed(2)+' to '+max.toFixed(2)+' m',11)+label([125,116],'A — '+p.distance.toFixed(1)+' m horizontal — B',10)+'</svg>';
    h+='<p>'+p.change.toFixed(2)+' m change · '+p.grade.toFixed(1)+'% average grade<br>'+p.rise.toFixed(2)+' m ascent · '+p.fall.toFixed(2)+' m descent</p><p class="note">Profile heights are interpolated. The chart scales height independently of distance.</p>';
    return h;
}
