const analysisImageCache = new Map();
const analysisHeatStops = ['#2875a2', '#52a98f', '#ecd56d', '#d85b47'];

function analysisClamp(value, low = 0, high = 1) { return Math.max(low, Math.min(high, value)); }
function analysisColor(value, stops = analysisHeatStops) {
    const t = analysisClamp(value) * (stops.length - 1), index = Math.floor(t), blend = t - index;
    const a = stops[index], b = stops[Math.min(index + 1, stops.length - 1)];
    return [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - blend) + parseInt(b.slice(i, i + 2), 16) * blend));
}
function analysisSignature(site, tool) {
    const features = site.features.map(f => [f.kind, f.itemType, f.p, f.tagProperties?.width, f.tagProperties?.brightness]);
    const samples = tool === 'Elevation map' ? site.samples : [];
    return tool + ':' + JSON.stringify([site.w, site.h, samples, features]);
}
function analysisHeatmapData(site, tool) {
    if (tool === 'Elevation map' && !site.samples.length) return null;
    const key = analysisSignature(site, tool);
    if (analysisImageCache.has(key)) return analysisImageCache.get(key);
    const longest = 150, width = site.w >= site.h ? longest : Math.max(32, Math.round(longest * site.w / site.h));
    const height = site.h >= site.w ? longest : Math.max(32, Math.round(longest * site.h / site.w));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'), image = context.createImageData(width, height);
    const mesh = tool === 'Elevation map' ? elevationMesh(site) : null;
    const lights = tool === 'Low visibility (lights)' ? site.features.filter(f => f.kind === 'light') : [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const index = y * width + x, offset = index * 4;
        const point = [(x + .5) * site.w / width, (y + .5) * site.h / height];
        let value = 0, alpha = 156, color;
        if (tool === 'Elevation map') {
            const range = mesh.max - mesh.min;
            value = range ? (mesh.at(point) - mesh.min) / range : .5;
            color = analysisColor(value);
        } else if (tool === 'Low visibility (lights)') {
            let lightLevel = 0;
            for (const lamp of lights) {
                const distance = dist(point, lamp.p[0]), strength = Number(lamp.tagProperties?.brightness ?? 1800) / 1800;
                lightLevel += strength * Math.exp(-(distance * distance) / (2 * 17 * 17));
            }
            value = 1 - analysisClamp(lightLevel);
            color = analysisColor(value);
        }
        image.data[offset] = color[0]; image.data[offset + 1] = color[1]; image.data[offset + 2] = color[2]; image.data[offset + 3] = alpha;
    }
    context.putImageData(image, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    analysisImageCache.clear();
    analysisImageCache.set(key, dataUrl);
    return dataUrl;
}
function analysisHeatmapMarkup(site, tool, scale, project) {
    if (!['Elevation map', 'Low visibility (lights)'].includes(tool)) return '';
    const data = analysisHeatmapData(site, tool);
    if (!data) return '';
    const [x, y] = project([0, 0]);
    return '<image x="' + x + '" y="' + y + '" width="' + site.w * scale + '" height="' + site.h * scale + '" preserveAspectRatio="none" opacity=".78" href="' + data + '" pointer-events="none"/>';
}
function analysisWalkablePaths(site) {
    return site.features.filter(f => ['path', 'crossing'].includes(f.kind) && f.confirmed !== false);
}
function analysisNearestPath(point, paths) {
    let best = { distance: Infinity, point: null };
    for (const path of paths) for (const [a, b] of edges(path.p)) {
        const length2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
        const t = length2 ? analysisClamp(((point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1])) / length2) : 0;
        const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], distance = dist(point, q);
        if (distance < best.distance) best = { distance, point: q };
    }
    return best;
}
function analysisTrashStats(site, maxSpacing, pathProximity = trashCanPathTolerance) {
    const paths = analysisWalkablePaths(site), bins = site.features.filter(f => f.kind === 'bin');
    const connected = bins.filter(bin => analysisNearestPath(bin.p[0], paths).distance <= pathProximity);
    let total = 0, covered = 0;
    for (const path of paths) for (const [a, b] of edges(path.p)) {
        const length = dist(a, b), parts = Math.max(1, Math.ceil(length / 1.5));
        for (let i = 0; i < parts; i++) {
            const p = a.map((v, axis) => v + (b[axis] - v) * (i + .5) / parts);
            const gap = connected.length ? Math.min(...connected.map(bin => dist(p, bin.p[0]))) : Infinity;
            const section = length / parts;
            total += section;
            if (gap <= maxSpacing) covered += section;
        }
    }
    return { bins: bins.length, connected: connected.length, offPath: bins.length - connected.length, pathLength: total, covered, percent: total ? 100 * covered / total : 0, paths, connectedBins: connected };
}
function analysisTrashOverlay(site, maxSpacing, scale, project, line, circle) {
    const stats = analysisTrashStats(site, maxSpacing), output = [];
    for (const path of stats.paths) for (const [a, b] of edges(path.p)) {
        const length = dist(a, b), parts = Math.max(1, Math.ceil(length / 1.8)), width = Math.max(3, Math.min(18, scale * Number(path.tagProperties?.width || 1.8)));
        for (let i = 0; i < parts; i++) {
            const p0 = a.map((v, axis) => v + (b[axis] - v) * i / parts), p1 = a.map((v, axis) => v + (b[axis] - v) * (i + 1) / parts);
            const mid = p0.map((v, axis) => (v + p1[axis]) / 2);
            const gap = stats.connectedBins.length ? Math.min(...stats.connectedBins.map(bin => dist(mid, bin.p[0]))) : maxSpacing * 1.5;
            const color = '#' + analysisColor(gap / maxSpacing).map(v => v.toString(16).padStart(2, '0')).join('');
            output.push(line([project(p0), project(p1)], color, width, 'pointer-events="none"'));
        }
    }
    for (const bin of site.features.filter(f => f.kind === 'bin')) {
        const connected = stats.connectedBins.includes(bin), color = connected ? '#227f61' : '#bf3f4b', p = project(bin.p[0]);
        output.push(circle(p, Math.max(6, trashCanPathTolerance * scale), 'none', color, 'stroke-width="2" stroke-dasharray="3 2" pointer-events="none"'));
        const nearest = analysisNearestPath(bin.p[0], stats.paths);
        if (connected && nearest.point) output.push(line([p, project(nearest.point)], color, 1.2, 'stroke-dasharray="3 3" pointer-events="none"'));
    }
    return output.join('');
}
function analysisDetailsMarkup(tool, site, spacing) {
    const design = designAnalysisDetails(tool, site);
    if (design !== null) return design;
    if (tool === 'Real Paths (Desire Paths)') return realPathPanel();
    if (tool === 'Elevation map') {
        if (!site.samples.length) return '<p class="note">No elevation samples are available. Import ground elevations to build the heat map and profile graph.</p>';
        const mesh = elevationMesh(site);
        return '<p class="analysis-explainer">Interpolated elevation heat map · ' + mesh.min.toFixed(1) + '–' + mesh.max.toFixed(1) + ' m.</p><div class="analysis-legend"><span>Low</span><i class="analysis-gradient"></i><span>High</span></div>' + elevationControls();
    }
    if (tool === 'Low visibility (lights)') {
        const count = site.features.filter(f => f.kind === 'light').length;
        return '<p class="analysis-explainer">Visibility is estimated from lamppost locations and brightness. Areas farther from lights show higher low-visibility scores.</p><div class="analysis-legend"><span>Lit</span><i class="analysis-gradient"></i><span>Low visibility</span></div><p class="note">' + count + ' lamppost' + (count === 1 ? '' : 's') + ' mapped · assumed light reach about 17 m.</p>';
    }
    if (tool === 'Trash Can') {
        const stats = analysisTrashStats(site, spacing);
        const percentage = stats.pathLength ? stats.percent.toFixed(0) + '% of mapped walkways are within range.' : 'Add confirmed paths to measure walkway coverage.';
        return '<label class="analysis-slider">Maximum walkway distance to a trash can · ' + spacing + ' m<input id="trashSpacing" type="range" min="5" max="100" step="5" value="' + spacing + '"></label><p class="note">' + stats.connected + ' of ' + stats.bins + ' cans count. Cans within ' + trashCanPathTolerance + ' m of a confirmed path count, even when they are not on the path.</p><p class="analysis-summary">' + (stats.bins ? percentage : 'Add trash cans to map their coverage.') + '</p><div class="analysis-legend"><span>Covered</span><i class="analysis-gradient"></i><span>Gap</span></div>';
    }
    return '<p class="note">This analysis is still a placeholder.</p>';
}

let realPathMode='planned', realPathCache=null;
function realPaths() {
    const elapsed=realPathMode==='walked'?time:null;
    if(realPathCache?.trips===net.trips && realPathCache.elapsed===elapsed) return realPathCache;
    const segments=new Map(), corridors=analysisWalkablePaths(site).flatMap(f=>
        edges(f.p).map(([a,b])=>({a,b,radius:Number(f.tagProperties?.width||1.8)/2})));
    let total=0,offPath=0,walkers=0,visits=0;
    function addSegment(a,b,passes) {
        const length=dist(a,b);
        if(!length || !passes)return;
        // Partition long links so the map can distinguish leaving a path mid-link.
        const pieces=Math.max(1,Math.min(100,Math.ceil(length)));
        for(let i=0;i<pieces;i++){
            const t=i/pieces,u=(i+1)/pieces;
            const point=v=>a.map((x,k)=>x+(b[k]-x)*v);
            const p=point(t),q=point(u),mid=point((t+u)/2);
            const ends=[p,q].map(v=>v.map(x=>x.toFixed(3)).join(',')).sort();
            const key=ends.join('|');
            let segment=segments.get(key);
            if(!segment){
                const off=!corridors.some(c=>segmentGap(mid,c.a,c.b)<=c.radius);
                segment={p:[p,q],passes:0,off};segments.set(key,segment);
            }
            segment.passes+=passes;total+=length/pieces*passes;
            if(segment.off)offPath+=length/pieces*passes;
        }
    }
    net.trips.forEach((trip,i)=>{
        const age=elapsed===null?trip.duration:Math.max(0,elapsed-i*2);
        const loops=Math.floor(age/trip.duration), remainder=age%trip.duration;
        if(age<=0)return;
        walkers++;
        const state=pedestrianState(trip,i);
        visits+=loops*(trip.tasks.length-1)+trip.tasks.slice(0,-1).filter(t=>t.arrival<=remainder).length;
        let remaining=elapsed===null?0:state.distance;
        for(const [a,b] of edges(trip.p)){
            const length=dist(a,b);
            if(length===0)continue;
            const full=remaining>=length-1e-8;
            addSegment(a,b,loops+(full?1:0));
            if(!full && remaining>0)addSegment(a,a.map((v,k)=>v+(b[k]-v)*remaining/length),1);
            remaining=Math.max(0,remaining-length);
        }
    });
    realPathCache={trips:net.trips,elapsed,segments:[...segments.values()],total,offPath,walkers,visits};
    return realPathCache;
}
function realPathOverlay(){
    return realPaths().segments.map(s=>line(s.p.map(project),s.off?'#bf5026':'#167485',
        Math.min(10,2+Math.log2(s.passes)*1.8),'opacity=".85" pointer-events="none"')).join('');
}
function realPathPanel(){
    const r=realPaths(), conditions=scenarioConditions();
    return '<h3>Pedestrian traffic</h3><label>Routes to display<select id="realPathMode"><option value="planned">Planned · one trip per person</option><option value="walked" '+(realPathMode==='walked'?'selected':'')+'>Walked · current playback</option></select></label>'
        +'<p>'+weatherNames[conditions.weather]+' · '+clockLabel(conditions.hour)+' · '+r.walkers+' pedestrians</p>'
        +'<p class="note">'+r.total.toFixed(1)+' m walked'+(realPathMode==='planned'?' per planned circuit':' in playback')+'<br>'+r.offPath.toFixed(1)+' m outside confirmed paths ('+(r.total?Math.round(100*r.offPath/r.total):0)+'%)<br>'+r.visits+ (r.visits===1?' amenity visit':' amenity visits')+'</p>'
        +'<p><b style="color:#167485">Teal</b> follows confirmed paths. <b style="color:#bf5026">Orange</b> shows shortcuts outside them. Thicker lines mark repeated passages.</p>'
        +(realPathMode==='walked'&&!r.total?'<p>Run the pedestrian simulation to record walking.</p>':'')
        +environmentControls();
}

function designAnalysisDetails(tool, site) {
    const metric = (label, value) => '<div class="row"><span>' + label + '</span><b>' + value + '</b></div>';
    const fmt = n => n.toLocaleString(undefined, {maximumFractionDigits: 1});
    const sumArea = kinds => site.features.filter(f => kinds.includes(f.kind) && f.p.length >= 3).reduce((n, f) => n + area(f.p), 0);
    if (tool === 'Land-use quantities' || tool === 'Green space') {
        const total = site.w * site.h;
        const quantity = (label, value) => metric(label, fmt(value) + ' m²' + (total ? ' · ' + fmt(100 * value / total) + '%' : ''));
        let h = '<h3>' + tool + '</h3>' + quantity('Site area', total);
        if (tool === 'Land-use quantities') {
            h += quantity('Building footprints', sumArea(['building'])) + quantity('Road and pavement polygons', sumArea(['road', 'pavement'])) + quantity('Water', sumArea(['water'])) + quantity('Planted ground', sumArea(['grass', 'shrub']));
            const length = kind => site.features.filter(f => kind.includes(f.kind)).reduce((n, f) => n + edges(f.p).reduce((v, [a,b]) => v + dist(a,b), 0), 0);
            h += metric('Confirmed walkways', fmt(lengthForPaths(site)) + ' m') + metric('Fence length', fmt(length(['fence'])) + ' m');
        } else {
            const trees = site.features.filter(f => f.kind === 'tree').length;
            h += quantity('Planted ground', sumArea(['grass', 'shrub'])) + quantity('Mapped canopy', sumArea(['canopy'])) + quantity('Green roofs', sumArea(['greenroof'])) + metric('Trees', trees) + metric('Trees per hectare', total ? fmt(trees * 10000 / total) : '—');
        }
        return h + '<p class="note">Areas are sums of mapped polygons; overlapping features are counted separately. Percentages use the rectangular site extent. Tree points do not imply canopy area.</p>';
    }
    return null;
}

function lengthForPaths(site) {
    return analysisWalkablePaths(site).reduce((n,f)=>n+edges(f.p).reduce((v,[a,b])=>v+dist(a,b),0),0);
}
