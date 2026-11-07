// Ground and path edges share a graph, so an amenity detour obeys the same
// crossings and obstacles as a direct trip. Costs are in equivalent metres.
function segmentGap(p, a, b) {
    const dx = b[0]-a[0], dy = b[1]-a[1];
    const t = Math.max(0, Math.min(1, ((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy || 1)));
    return Math.hypot(p[0]-a[0]-t*dx, p[1]-a[1]-t*dy);
}

const populationLimit=100;
const walkingHabits={
    usual:'Follows their usual route and stopping preferences.',
    explorer:'Sometimes tries an alternate route, up to 12% longer.',
    lingerer:'Likes a longer break at a bench or a wildlife stop.',
    focused:'Usually skips optional stops to reach the destination sooner.'
};

function walkingRoutes(site, network, env) {
    const features = site.features;
    const wet = env.weather === 'rain', snow = env.weather === 'snow';
    const darkness = 1 - environmentLighting(env).daylight * (env.weather==='clear'?1:.82);
    const areas = features.filter(f => kinds[f.kind][2] === 'area');
    const walls = areas.filter(f => ['building','water','road'].includes(f.kind));
    const barriers = features.filter(f => ['roadLine','fence'].includes(f.kind))
        .flatMap(f => edges(f.p).map(([a,b]) => ({a,b,road:f.kind==='roadLine', radius:f.kind==='fence'?.08:Number(f.tagProperties?.width || 6)/2})));
    function clear(a,b,crossing=false) {
        if (walls.some(f => !(crossing && f.kind==='road') && blocked(a,b,f.p))) return false;
        return !barriers.some(s => !(crossing && s.road) && (
            (cross(a,b,s.a)*cross(a,b,s.b)<0 && cross(s.a,s.b,a)*cross(s.a,s.b,b)<0)
            || Math.min(segmentGap(a,s.a,s.b),segmentGap(b,s.a,s.b),segmentGap(s.a,a,b),segmentGap(s.b,a,b))<=s.radius));
    }
    const points = features.filter(f => kinds[f.kind][2]==='point');
    const unknownLines = features.filter(f=>f.kind==='unknownLine').flatMap(f=>edges(f.p));
    const warnings=points.filter(f=>f.kind==='dangerSign').map(f=>({p:f.p[0],radius:warningRadius(f)}));
    // Charge only for the portion inside the warning circle. An edge may cross
    // the whole circle even when both endpoints are outside it.
    function warningCost(a,b,length) {
        if(!length)return 0;
        let cost=0;
        for(const {p,radius} of warnings){
            const dx=(b[0]-a[0])/length, dy=(b[1]-a[1])/length;
            const x=p[0]-a[0], y=p[1]-a[1];
            const across=Math.abs(x*dy-y*dx);
            if(across>=radius)continue;
            const along=x*dx+y*dy;
            const halfChord=Math.sqrt(radius*radius-across*across);
            const start=Math.max(0,along-halfChord),end=Math.min(length,along+halfChord);
            if(end>start){
                const depth=1-Math.hypot(across,(start+end)/2-along)/radius;
                cost+=(end-start)*(4+12*depth);
            }
        }
        return cost;
    }
    const staffAreas=areas.filter(f=>f.itemType==='employeeShed').map(f=>{
        const value=Number(f.tagProperties?.clearance??4);
        return {outline:edges(f.p,true), clearance:Number.isFinite(value)?Math.max(0,Math.min(20,value)):4};
    });
    function groundAt(p) {
        let rough=1.18, shelter=0, light=0;
        for (const f of areas) {
            if (!inside(p,f.p)) continue;
            switch (f.kind) {
                case 'grass': rough=f.itemType==='garden'?2.6:1.18; break;
                case 'soil': rough=f.tagProperties?.surface==='Stone patch'?1.08:1.28; break;
                case 'pavement': rough=1.01; break;
                case 'shrub': rough=3.6; break;
                case 'unknown': rough=2; break;
                case 'canopy': shelter=1; break;
            }
        }
        let clutter=0;
        for (const f of points) {
            const d=dist(p,f.p[0]);
            if (f.kind==='light') light+=Number(f.tagProperties?.brightness??1800)/1800*Math.exp(-d*d/578);
            if (f.kind==='tree') shelter=Math.max(shelter,Math.max(0,1-d/Math.max(3,Number(f.tagProperties?.maxGrowth||12)*.5)));
            if (f.kind==='bush'||f.kind==='tree'||f.kind==='unknownPoint') clutter+=Math.max(0,1-d/2)*1.8;
            if (wet && f.kind==='drainage') clutter+=Math.max(0,1-d/3)*1.1;
        }
        if (unknownLines.some(([a,b])=>segmentGap(p,a,b)<1.5)) clutter+=.65;
        let staffProximity=0;
        for(const {outline,clearance} of staffAreas){
            if(!clearance)continue;
            for(const [a,b] of outline)
                staffProximity=Math.max(staffProximity,1-segmentGap(p,a,b)/clearance);
        }
        return {rough,shelter,clutter,staffProximity,unlit:Math.max(0,1-light),z:terrain(site,...p)};
    }
    const step=Math.max(site.w,site.h)/46, nx=Math.ceil(site.w/step), ny=Math.ceil(site.h/step);
    const nodes=[], links=[], ground=[], grid=new Map();
    function add(p) {
        links.push([]); ground.push(groundAt(p)); nodes.push(p); return nodes.length-1;
    }
    function connect(a,b,path=null) {
        const ga=ground[a], gb=ground[b], length=dist(nodes[a],nodes[b]);
        let surface=(ga.rough+gb.rough)/2;
        if (path) surface=['Dirt','Desire path'].includes(path.tagProperties?.surface)?1.17:1;
        const mud=(wet?5:snow?2:0)*Math.max(0,surface-1.06);
        const dark=(darkness**2+(env.weather==='fog'?.4:0))*(ga.unlit+gb.unlit)*.8;
        const cover=wet?(ga.shelter+gb.shelter)*.09:0;
        // A marked public path beside a staff building remains a reasonable choice.
        const staffCost=(ga.staffProximity+gb.staffProximity)*(path ? 0.35 : 1.5);
        const inconvenience=warningCost(nodes[a],nodes[b],length)+length*(surface-1+mud+dark-cover+staffCost+(ga.clutter+gb.clutter)/2)+Math.abs(ga.z-gb.z)*1.8;
        links[a].push([b,length,inconvenience]); links[b].push([a,length,inconvenience]);
    }
    for (let y=0;y<ny;y++) for (let x=0;x<nx;x++) {
        const p=[(x+.5)*site.w/nx,(y+.5)*site.h/ny];
        if (!clear(p,p)) continue;
        const i=add(p); grid.set(x+','+y,i);
        for (const [dx,dy] of [[-1,0],[0,-1],[-1,-1],[1,-1]]) {
            const j=grid.get((x+dx)+','+(y+dy));
            if (j!==undefined && clear(p,nodes[j])) connect(i,j);
        }
    }
    function attach(p) {
        const i=add(p), col=Math.floor(p[0]*nx/site.w), row=Math.floor(p[1]*ny/site.h);
        for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) {
            const j=grid.get((col+dx)+','+(row+dy));
            if (j!==undefined && clear(p,nodes[j])) connect(i,j);
        }
        return i;
    }
    const junctions=network.nodes.map(attach);
    network.links.forEach(([a,b,length],idx)=>{
        const path=network.pathFeatures[idx];
        if (!clear(nodes[junctions[a]],nodes[junctions[b]],path.kind==='crossing')) return;
        let previous=junctions[a];
        const count=Math.ceil(length/step);
        for (let k=1;k<=count;k++) {
            const next=k===count?junctions[b]:attach(network.nodes[a].map((v,i)=>v+(network.nodes[b][i]-v)*k/count));
            connect(previous,next,path); previous=next;
        }
    });
    function anchor(f) {
        const match=network.nodes.findIndex(p=>dist(p,f.p[0])<.02);
        return {feature:f,node:match<0?attach(f.p[0]):junctions[match]};
    }
    const buildings=areas.filter(f=>f.kind==='building' && f.itemType!=='employeeShed');
    // A route reaching the survey edge, or ending at a building, is a two-way
    // access point. Legacy entry/exit markers remain usable in either direction.
    const access=[];
    function addAccess(p,name,kind='entrance',feature=null) {
        if(p[0]<0 || p[0]>site.w || p[1]<0 || p[1]>site.h) return;
        if(access.some(a=>dist(a.feature.p[0],p)<.05)) return;
        access.push(anchor(feature || {kind,name,p:[p]}));
    }
    for(const f of features.filter(f=>['entrance','destination'].includes(f.kind)))
        addAccess(f.p[0],f.name||kinds[f.kind][0],f.kind,f);
    const onEdge=p=>p[0]<=.05 || p[0]>=site.w-.05 || p[1]<=.05 || p[1]>=site.h-.05;
    for(const [a,b] of network.links) {
        const start=network.nodes[a],end=network.nodes[b];
        for(const p of [start,end]) if(onEdge(p)) addAccess(p,'Map boundary');
        for(const axis of [0,1]) for(const edge of [0,axis?site.h:site.w]) {
            const delta=end[axis]-start[axis];
            if(Math.abs(delta)<1e-9) continue;
            const t=(edge-start[axis])/delta;
            if(t>=0 && t<=1) addAccess(start.map((v,i)=>v+t*(end[i]-v)),'Map boundary');
        }
    }
    const degree=new Int32Array(network.nodes.length);
    for(const [a,b] of network.links){degree[a]++;degree[b]++;}
    for(let i=0;i<network.nodes.length;i++) {
        if(degree[i]!==1) continue;
        const p=network.nodes[i];
        const building=buildings.find(f=>edges(f.p,true).some(([a,b])=>segmentGap(p,a,b)<=6));
        if(building) addAccess(p,building.name+' entrance');
    }
    const origins=access, goals=access;
    const sheltered=g=>buildings.some(f=>edges(f.p,true).some(([a,b])=>segmentGap(nodes[g.node],a,b)<=6));
    const activities={bench:['Sit and rest',9],bin:['Dispose of litter',3],fountain:['Get a drink',5],birdhouse:['Watch for birds',8],solar:['Look at solar panels',5],greenroof:['Look at the roof garden',6],garden:['Look at the planting',6]};
    const stops=[];
    for (const f of features) {
        const activity=activities[f.itemType] || activities[f.kind];
        if (!activity) continue;
        if (kinds[f.kind][2]==='point') {
            const [x,y]=f.p[0];
            const approach=f.kind==='bench' ? f.p[0] : [[0,.8],[.8,0],[0,-.8],[-.8,0]]
                .map(([dx,dy])=>[x+dx,y+dy])
                .find(p=>p[0]>=0 && p[0]<=site.w && p[1]>=0 && p[1]<=site.h && clear(p,f.p[0]));
            if (approach) stops.push({node:attach(approach),feature:f,activity});
        }
        else {
            // Observe roof and garden features from nearby accessible ground.
            let best=-1, gap=Infinity;
            const outline=edges(f.p,true);
            for (const i of grid.values()) {
                if (!links[i].length || inside(nodes[i],f.p)) continue;
                const d=Math.min(...outline.map(([a,b])=>segmentGap(nodes[i],a,b)));
                if (d<gap) {best=i;gap=d;}
            }
            if(best>=0 && gap<=15) stops.push({node:best,feature:f,activity});
        }
    }
    function search(start,sensitivity,avoid=null) {
        const cost=new Float64Array(nodes.length).fill(Infinity), prev=new Int32Array(nodes.length).fill(-1);
        cost[start]=0;
        const open=new Set([start]);
        while(open.size) {
            let i=-1;
            for(const j of open) if(i<0 || cost[j]<cost[i]) i=j;
            open.delete(i);
            for(const [j,len,extra] of links[i]) {
                const weight=len+sensitivity*extra;
                const repeated=avoid && (avoid.get(i)===j || avoid.get(j)===i);
                const next=cost[i]+weight*(repeated?1.12:1);
                if(next<cost[j]){cost[j]=next;prev[j]=i;open.add(j);}
            }
        }
        return {cost,prev};
    }
    const names=['Robin','Maya','Alex','Finn','Sam','Jules','Riley','Noor','Casey','Iris','Lee','Quinn'];
    // Allocate only reachable pairs, so increasing the population also works
    // on a site with just one entrance or several disconnected walkways.
    const component=new Int32Array(nodes.length).fill(-1);
    function labelComponent(start) {
        if(component[start]!==-1)return;
        const pending=[start]; component[start]=start;
        while(pending.length){
            const node=pending.pop();
            for(const [next] of links[node]) if(component[next]===-1){
                component[next]=start;pending.push(next);
            }
        }
    }
    const pairs=[];let missed=0;
    for(const origin of origins){
        labelComponent(origin.node);
        for(const goal of goals){
            if(origin===goal) continue;
            if(component[origin.node]===component[goal.node] && dist(nodes[origin.node],nodes[goal.node])>.001)
                pairs.push({origin,goal});
            else missed++;
        }
    }
    const configured=site.pedestrians?.count;
    const requested=Number.isInteger(configured)?Math.max(0,Math.min(populationLimit,configured)):Math.min(populationLimit,pairs.length);
    const populationSeed=Number(site.pedestrians?.seed)>>>0;
    const trips=[];
    for(let id=0;id<requested && pairs.length;id++){
        const {origin,goal}=pairs[id%pairs.length];
        let seed=(Math.imul(id+1,2654435761)^populationSeed)>>>0;
        const roll=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
        // Mix the identity separately so neighbors in the roster do not inherit
        // correlated habits and a habit draw does not shift the amenity draws.
        let hash=Math.imul(seed^(seed>>>16),0x85ebca6b);
        hash=Math.imul(hash^(hash>>>13),0xc2b2ae35);
        const draw=((hash^(hash>>>16))>>>0)/4294967296;
        const sensitivity=.65+roll()*.85, pace=1.12+roll()*.5;
        const habit=draw<.52?'usual':draw<.75?'explorer':draw<.89?'lingerer':'focused';
        let alternateLegs=0;
        const from=search(origin.node,sensitivity);
        let end=goal;
        if(snow && roll()<.85 && !sheltered(goal)) {
            const nearby=goals.filter(g=>sheltered(g)&&from.cost[g.node]>0&&Number.isFinite(from.cost[g.node]));
            nearby.sort((a,b)=>from.cost[a.node]-from.cost[b.node]);
            end=nearby[0]||goal;
        }
        const direct=from.cost[end.node];
        if (!Number.isFinite(direct)||!direct){missed++;continue;}
        const back=search(end.node,sensitivity);
        const urgency=snow?.14:wet?.55:1;
        const candidates=[];
        for (const stop of stops) {
            const [action,seconds]=stop.activity;
            const desire=roll(),priority=roll();
            const lingering=habit==='lingerer' && ['bench','birdhouse'].includes(stop.feature.kind);
            const preference=lingering?1.4:habit==='focused'?.4:1;
            const chance=preference*(stop.feature.kind==='bin'?.68:stop.feature.kind==='bench'?.57:.44)*urgency;
            const detour=from.cost[stop.node]+back.cost[stop.node]-direct;
            if(desire<chance && detour<Math.max(20,direct*.8)*urgency)
                candidates.push({...stop,action,seconds:lingering?seconds+5:seconds,priority});
        }
        candidates.sort((a,b)=>b.priority-a.priority);
        const chosen=candidates.slice(0,2);
        chosen.sort((a,b)=>from.cost[a.node]-from.cost[b.node]);
        const p=[nodes[origin.node]], tasks=[];
        let previous=origin.node, route=from, distance=0, duration=0;
        for(const stop of [...chosen,{...end,action:'Arrive',seconds:3}]) {
            if(!Number.isFinite(route.cost[stop.node])) continue;
            function trace(prev){
                const points=[];
                for(let j=stop.node;j!==previous;j=prev[j]) points.push(nodes[j]);
                return points.reverse();
            }
            let leg=trace(route.prev);
            if(habit==='explorer' && leg.length>2 && roll()<.8){
                const avoid=new Map();
                for(let j=stop.node;j!==previous;j=route.prev[j]) avoid.set(j,route.prev[j]);
                const alternate=trace(search(previous,sensitivity,avoid).prev);
                const length=points=>points.reduce((sum,q,i)=>sum+dist(i?points[i-1]:nodes[previous],q),0);
                if(alternate.some(q=>!leg.includes(q)) && length(alternate)<=length(leg)*1.12){
                    leg=alternate;alternateLegs++;
                }
            }
            const startDistance=distance, start=duration;
            for(const q of leg){distance+=dist(p.at(-1),q);p.push(q);}
            duration+=(distance-startDistance)/pace;
            tasks.push({action:stop.action,place:stop.feature.name||kinds[stop.feature.kind][0],kind:stop.feature.kind,start,arrival:duration,finish:duration+stop.seconds,startDistance,distance});
            duration+=stop.seconds;previous=stop.node;
            if(stop.node!==end.node) route=search(previous,sensitivity);
        }
        const name=names[id%names.length]+(id>=names.length?' '+(1+Math.floor(id/names.length)):'');
        trips.push({name,habit,alternateLegs,p,d:distance,tasks,pace,duration,origin:origin.feature.name,destination:end.feature.name,sensitivity});
    }
    return {trips,missed,requested};
}
