const isPath = feature => ['path','crossing'].includes(feature.kind);
function pathSnap(point, features, radius, excluded = -1) {
    let best = null;
    // Prefer existing junctions over adding another vertex beside them.
    features.forEach((feature,index)=>{
        if(index===excluded || !isPath(feature))return;
        for(const p of feature.p){
            const distance=dist(point,p);
            if(distance<=radius && (!best || distance<best.distance))best={p:[...p],distance};
        }
    });
    if(best)return best.p;
    features.forEach((feature,index)=>{
        if(index===excluded || !isPath(feature))return;
        for(const [a,b] of edges(feature.p)){
            const length=dist(a,b);
            if(length<.001)continue;
            const t=Math.max(0,Math.min(1,((point[0]-a[0])*(b[0]-a[0])+(point[1]-a[1])*(b[1]-a[1]))/(length*length)));
            const p=a.map((v,k)=>v+t*(b[k]-v)),distance=dist(point,p);
            if(distance<=radius && (!best || distance<best.distance))best={p,distance};
        }
    });
    return best?best.p:[...point];
}
function joinPathVertices(features, index) {
    const edited=features[index];
    if(!isPath(edited))return;
    features.forEach((feature,i)=>{
        if(i===index || !isPath(feature))return;
        const points=[];
        for(const [a,b] of edges(feature.p)){
            points.push(a);
            const length=dist(a,b);
            if(length<.001)continue;
            const inserts=edited.p.filter(p=>dist(p,a)>.001&&dist(p,b)>.001)
                .map(p=>({p,t:((p[0]-a[0])*(b[0]-a[0])+(p[1]-a[1])*(b[1]-a[1]))/(length*length)}))
                .filter(({p,t})=>t>0&&t<1&&dist(p,a.map((v,k)=>v+t*(b[k]-v)))<.001)
                .sort((a,b)=>a.t-b.t);
            for(const {p} of inserts)if(dist(points.at(-1),p)>.001)points.push([...p]);
        }
        points.push(feature.p.at(-1));
        if(points.length!==feature.p.length){feature.p=points;feature.source='Edited';}
    });
}
