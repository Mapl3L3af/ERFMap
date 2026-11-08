// Geometry is stored in local metres, x east and y south.
const trashCanPathTolerance = 5;
const defaultWarningRadius=8;
function warningRadius(feature) {
    const radius=Number(feature.tagProperties?.radius ?? defaultWarningRadius);
    return Number.isFinite(radius)?Math.max(1,Math.min(50,radius)):defaultWarningRadius;
}
const kinds = {
    dangerSign: ['Danger sign', '#e6ac38', 'point'],
    grass: ['Grass', '#b1c990', 'area'], shrub: ['Shrubs', '#82ab75', 'area'], bush: ['Bush', '#70936a', 'point'], soil: ['Bare soil', '#c9b296', 'area'], water: ['Water', '#91c6c7', 'area'], pavement: ['Pavement', '#c9c9b9', 'area'], road: ['Road', '#808080', 'area'], roadLine: ['Road', '#808080', 'line'], building: ['Building', '#d9ba96', 'area'], canopy: ['Tree canopy', '#739b70', 'area'], tree: ['Tree', '#72966a', 'point'], path: ['Footpath', '#00bfff', 'line'], crossing: ['Crossing', '#eee0b6', 'line'], entrance: ['Entrance', '#37785e', 'point'], destination: ['Destination', '#9f6741', 'point'], bin: ['Trash bin', '#496958', 'point'], bench: ['Bench', '#9e7956', 'point'], light: ['Light', '#8c8871', 'point'], fence: ['Fence', '#948374', 'line'], unknown: ['Unknown', '#bcb6c4', 'area'], unknownLine: ['Unknown line', '#bd7180', 'line'], unknownPoint: ['Unknown item', '#bd7180', 'point'], fountain: ['Water fountain', '#4f93a8', 'point'], drainage: ['Drainage vent', '#737d81', 'point'], birdhouse: ['Bird / bat house', '#8d7155', 'point'], solar: ['Solar panels', '#496b89', 'area'], greenroof: ['Green roof', '#71966d', 'area']
};
const featureTypes = {
    grassField: { category: 'Continuous Items', label: 'Grass Field', kind: 'grass', color: '#8da86d', fields: [{ key: 'surface', label: 'Finish', type: 'select', options: ['Real', 'Sod'], default: 'Real', colors: { Real: '#8da86d', Sod: '#76ad57' } }] },
    dirtPatch: { category: 'Continuous Items', label: 'Dirt Patch', kind: 'soil', color: '#ad8b68', fields: [{ key: 'surface', label: 'Surface', type: 'select', options: ['Dirt patch', 'Stone patch'], default: 'Dirt patch', colors: { 'Dirt patch': '#ad8b68', 'Stone patch': '#92999a' } }] },
    lake: { category: 'Continuous Items', label: 'Lake', kind: 'water', color: '#76aeb9', fields: [] },
    garden: { category: 'Continuous Items', label: 'Garden', kind: 'grass', color: '#7f9f6b', fields: [{ key: 'plantType', label: 'Plant type', type: 'select', options: ['Native plants', 'Pollinator garden', 'Edible garden', 'Ornamental planting', 'Other'], default: 'Native plants', colors: { 'Native plants': '#7f9f6b', 'Pollinator garden': '#9ba85f', 'Edible garden': '#679454', 'Ornamental planting': '#9d83a3', Other: '#829c70' } }] },
    road: { category: 'Virtibred Items', label: 'Road', kind: 'roadLine', color: '#808080', fields: [{ key: 'width', label: 'Width (m)', type: 'number', min: 0.2, max: 100, step: 0.1, default: 6 }, { key: 'surface', label: 'Surface', type: 'select', options: ['Asphalt', 'Cobble', 'Sidewalk'], default: 'Asphalt', colors: { Asphalt: '#808080', Cobble: '#999999', Sidewalk: '#c1c1c1' } }] },
    roadSurface: { category: 'Legacy', label: 'Road', kind: 'road', color: '#808080', fields: [{ key: 'width', label: 'Width (m)', type: 'number', min: 0.2, max: 100, step: 0.1, default: 6 }, { key: 'surface', label: 'Surface', type: 'select', options: ['Asphalt', 'Cobble', 'Sidewalk'], default: 'Asphalt', colors: { Asphalt: '#808080', Cobble: '#999999', Sidewalk: '#c1c1c1' } }] },
    path: { category: 'Virtibred Items', label: 'Path', kind: 'path', color: '#00bfff', fields: [{ key: 'width', label: 'Width (m)', type: 'number', min: 0.2, max: 30, step: 0.1, default: 1.8 }, { key: 'surface', label: 'Surface', type: 'select', options: ['Concrete', 'Dirt', 'Cobble', 'Man-made', 'Desire path'], default: 'Concrete', colors: { Concrete: '#00bfff', Dirt: '#00bfff', Cobble: '#00bfff', 'Man-made': '#00bfff', 'Desire path': '#00bfff' } }] },
    shrubPatch: { category: 'Legacy', label: 'Shrub area', kind: 'shrub', color: '#82ab75', fields: [] },
    largeTree: { category: 'Single Items · Foliage · Tree', label: 'Large Tree', kind: 'tree', color: '#648957', fields: [{ key: 'maxGrowth', label: 'Maximum growth (m)', type: 'number', min: 1, max: 60, step: 0.5, default: 18 }, { key: 'species', label: 'Species', type: 'select', options: ['Oak', 'Maple', 'Pine', 'Birch', 'Other'], default: 'Oak', colors: { Oak: '#648957', Maple: '#bd8051', Pine: '#486d57', Birch: '#a0a75c', Other: '#748b60' } }] },
    smallTree: { category: 'Single Items · Foliage · Tree', label: 'Small Tree', kind: 'tree', color: '#748f60', fields: [{ key: 'maxGrowth', label: 'Maximum growth (m)', type: 'number', min: 1, max: 30, step: 0.5, default: 5 }, { key: 'species', label: 'Species', type: 'select', options: ['Oak', 'Maple', 'Pine', 'Birch', 'Other'], default: 'Maple', colors: { Oak: '#648957', Maple: '#bd8051', Pine: '#486d57', Birch: '#a0a75c', Other: '#748b60' } }] },
    bushes: { category: 'Single Items · Foliage', label: 'Bushes', kind: 'bush', color: '#70936a', fields: [{ key: 'species', label: 'Species', type: 'select', options: ['Native mix', 'Boxwood', 'Hydrangea', 'Other'], default: 'Native mix', colors: { 'Native mix': '#70936a', Boxwood: '#4e805e', Hydrangea: '#8d83a8', Other: '#829970' } }] },
    treeCanopy: { category: 'Single Items · Foliage · Tree', label: 'Tree Canopy', kind: 'canopy', color: '#739b70', fields: [{ key: 'maxGrowth', label: 'Maximum growth (m)', type: 'number', min: 1, max: 60, step: 0.5, default: 18 }, { key: 'species', label: 'Species', type: 'select', options: ['Oak', 'Maple', 'Pine', 'Birch', 'Other'], default: 'Oak', colors: { Oak: '#648957', Maple: '#bd8051', Pine: '#486d57', Birch: '#a0a75c', Other: '#748b60' } }] },
    garbageCan: { category: 'Single Items · EcoItems', label: 'Garbage Can', kind: 'bin', color: '#526b5d', fields: [{ key: 'wasteType', label: 'Collection type', type: 'select', options: ['Recycling', 'Garbage', 'Compost'], default: 'Garbage', colors: { Recycling: '#4a8ba5', Garbage: '#68736e', Compost: '#6e9256' } }] },
    waterFountain: { category: 'Single Items · EcoItems', label: 'Water Fountain', kind: 'fountain', color: '#4f93a8', fields: [] },
    drainageVent: { category: 'Single Items · EcoItems', label: 'Drainage Vent', kind: 'drainage', color: '#737d81', fields: [] },
    birdBatHouse: { category: 'Single Items · EcoItems', label: 'Bird / Bat House', kind: 'birdhouse', color: '#8d7155', fields: [] },
    bench: { category: 'Single Items · Decoration', label: 'Bench', kind: 'bench', color: '#9e7956', fields: [{ key: 'length', label: 'Length (m)', type: 'number', min: 0.3, max: 20, step: 0.1, default: 1.8 }] },
    lamppost: { category: 'Single Items · Decoration', label: 'Lamppost', kind: 'light', color: '#c2a64f', fields: [{ key: 'brightness', label: 'Lumen brightness (lm)', type: 'number', min: 0, max: 100000, step: 100, default: 1800 }] },
    employeeShed: {
        category: 'Building Blocks', label: 'Employee Shed', kind: 'building', color: '#72857a',
        fields: [{key:'clearance', label:'Preferred clearance (m)', type:'number', min:0, max:20, step:.5, default:4}]
    },
    building: { category: 'Building Blocks', label: 'Building', addLabel: 'New Building', kind: 'building', color: '#b99875', fields: [{ key: 'roofShape', label: 'Roof shape', type: 'select', options: ['Flat', 'Pointed', 'Curved'], default: 'Flat', colors: { Flat: '#b99875', Pointed: '#c48e69', Curved: '#a98572' } }] },
    solarPanels: { category: 'Building Blocks · Roof only Items', label: 'Solar Panels', kind: 'solar', color: '#496b89', fields: [] },
    greenRoof: { category: 'Building Blocks · Roof only Items', label: 'Green Roof', kind: 'greenroof', color: '#71966d', fields: [] },
    fence: { category: 'Building Blocks', label: 'Fence', kind: 'fence', color: '#948374', fields: [{ key: 'visibility', label: 'Visibility', type: 'select', options: ['Visible', 'Invisible'], default: 'Visible', colors: { Visible: '#8c7968', Invisible: '#9da7a8' } }] },
    unknown: { category: 'Unknown', label: 'Unknown item', kind: 'unknown', color: '#bd7180', fields: [{ key: 'geometry', label: 'Geometry', type: 'select', options: ['Area', 'Line', 'Point'], default: 'Area' }] },
    dangerSign: {
        category: 'NPC Pathing', label: 'Danger Sign', kind: 'dangerSign', color: '#e6ac38',
        fields: [{key:'radius', label:'Warning radius (m)', type:'number', min:1, max:50, step:1, default:defaultWarningRadius}]
    },
    npcEntry: { category: 'NPC Pathing · Optional access markers', label: 'Access marker', kind: 'entrance', color: '#37785e', fields: [] },
    npcExit: { category: 'NPC Pathing · Optional access markers', label: 'Legacy exit marker', kind: 'destination', color: '#9f6741', fields: [] },
    crossing: { category: 'NPC Pathing', label: 'Crossing', kind: 'crossing', color: '#ad9665', fields: [] }
};
function defaultItemTypeForKind(kind) {
    return ({ dangerSign:'dangerSign', grass: 'grassField', shrub: 'shrubPatch', bush: 'bushes', soil: 'dirtPatch', water: 'lake', pavement: 'roadSurface', road: 'roadSurface', roadLine: 'road', building: 'building', canopy: 'treeCanopy', tree: 'smallTree', path: 'path', crossing: 'crossing', entrance: 'npcEntry', destination: 'npcExit', bin: 'garbageCan', bench: 'bench', light: 'lamppost', fence: 'fence', unknown: 'unknown', unknownLine: 'unknown', unknownPoint: 'unknown', fountain: 'waterFountain', drainage: 'drainageVent', birdhouse: 'birdBatHouse', solar: 'solarPanels', greenroof: 'greenRoof' })[kind] || 'unknown';
}
function featureKindForType(typeKey, properties = {}) {
    if (typeKey === 'unknown')
        return ({ Area: 'unknown', Line: 'unknownLine', Point: 'unknownPoint' })[properties.geometry] || 'unknown';
    return featureTypes[typeKey].kind;
}
function featureColor(feature) {
    if (/^#[\da-f]{6}$/i.test(feature.color || ''))
        return feature.color;
    const type = featureTypes[feature.itemType] || featureTypes[defaultItemTypeForKind(feature.kind)];
    const values = feature.tagProperties || {};
    for (const field of type.fields || [])
        if (field.colors?.[values[field.key] ?? field.default])
            return field.colors[values[field.key] ?? field.default];
    return type.color || kinds[feature.kind][1];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const edges = (p, closed = false) => p.slice(closed ? 0 : 1).map((_, i) => [p[i], p[(i + 1) % p.length]]);
const area = p => Math.abs(edges(p, true).reduce((s, [a, b]) => s + a[0] * b[1] - a[1] * b[0], 0)) / 2;
function inside(p, poly) { let hit = false; for (const [a, b] of edges(poly, true))
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0])
        hit = !hit; return hit; }
const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
function blocked(a, b, poly) { return inside(a, poly) || inside(b, poly) || inside([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], poly) || edges(poly, true).some(([c, d]) => cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0); }
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
function demo() {
    const features = [];
    function add(kind, p, name, extra = {}) { features.push({ kind, p, name: name || kinds[kind][0], source: 'Demo', ...extra }); }
    add('grass', [[4, 5], [118, 5], [118, 73], [84, 76], [50, 72], [3, 76]], 'Common lawn');
    add('road', rect(0, 80, 124, 9), 'South avenue');
    add('pavement', rect(12, 12, 35, 22), 'West courtyard');
    add('building', [[14, 14], [43, 14], [43, 24], [31, 24], [31, 30], [14, 30]], 'Field house', { height: 7 });
    add('building', rect(82, 13, 23, 16), 'East pavilion', { height: 5 });
    add('water', [[78, 57], [84, 51], [96, 50], [104, 55], [103, 63], [96, 68], [85, 67], [78, 62]], 'Garden pond');
    add('path', [[4, 44], [29, 44], [59, 44], [92, 44], [116, 44]], 'Central walk');
    add('path', [[29, 44], [29, 33]], 'Field house walk');
    add('path', [[92, 44], [92, 32]], 'Pavilion walk');
    add('path', [[59, 76], [59, 63], [59, 44], [59, 10]], 'Garden walk');
    add('entrance', [[4, 44]], 'West gate');
    add('entrance', [[59, 76]], 'South gate');
    add('destination', [[92, 32]], 'East pavilion entry');
    add('destination', [[29, 33]], 'Field house entry');
    add('destination', [[59, 10]], 'North garden');
    add('bin', [[59, 44]], 'Central bin');
    add('bench', [[65, 48]]);
    add('light', [[35, 42]]);
    for (const p of [[8, 13], [10, 35], [18, 55], [25, 60], [12, 65], [35, 64], [45, 57], [51, 13], [69, 15], [73, 22], [110, 17], [113, 30], [70, 65], [107, 72], [40, 37]])
        add('tree', [p]);
    const samples = [];
    for (let y = 0; y <= 90; y += 15)
        for (let x = 0; x <= 125; x += 25)
            samples.push([x, y, 2 + 4 * Math.sin(x / 34) * Math.cos(y / 40)]);
    return { name: 'Willow Creek Commons', demo: true, w: 124, h: 90, features, samples };
}
function graph(site) {
    const nodes = [], links = [], adj = [], pathFeatures = [];
    function node(p) { let i = nodes.findIndex(q => dist(p, q) < .02); if (i < 0) {
        i = nodes.length;
        nodes.push(p);
        adj.push([]);
    } return i; }
    const barriers = site.features.filter(f => ['road', 'building', 'water'].includes(f.kind));
    for (const f of site.features.filter(f => ['path', 'crossing'].includes(f.kind) && f.confirmed !== false))
        for (const [a, b] of edges(f.p)) {
            if (barriers.some(o => !(o.kind === 'road' && f.kind === 'crossing') && blocked(a, b, o.p)))
                continue;
            const i = node(a), j = node(b), d = dist(a, b);
            if (i === j || adj[i].some(e => e[0] === j))
                continue;
            links.push([i, j, d]);
            pathFeatures.push(f);
            adj[i].push([j, d]);
            adj[j].push([i, d]);
        }
    // Bin access belongs to a single eligible edge. Keep intersections between
    // unrelated paths disconnected, even if a bin sits on the intersection.
    const attachments = new Map(), binNodes = [];
    const allBins = site.features.filter(f => f.kind === 'bin');
    for (const bin of allBins) {
        let best = null;
        links.forEach(([i, j], index) => {
            const a = nodes[i], b = nodes[j], q = bin.p[0];
            const t = Math.max(0, Math.min(1, ((q[0]-a[0])*(b[0]-a[0])+(q[1]-a[1])*(b[1]-a[1])) / dist(a,b)**2));
            const p = a.map((v,k) => v+(b[k]-v)*t), gap = dist(p,q);
            if (gap <= trashCanPathTolerance && (!best || gap < best.gap)) best = {index,t,p,gap};
        });
        if (!best) continue;
        if (!attachments.has(best.index)) attachments.set(best.index, []);
        attachments.get(best.index).push(best);
    }
    const walkingNetwork = {nodes:nodes.slice(), links, pathFeatures};
    const split = [];
    links.forEach(([a,b,d], index) => {
        let last = a, t = 0;
        for (const bin of (attachments.get(index)||[]).sort((x,y)=>x.t-y.t)) {
            if (bin.t >= 1-1e-9) { binNodes.push(b); continue; }
            if (bin.t > t+1e-9) {
                const j = nodes.push(bin.p)-1;
                split.push([last,j,(bin.t-t)*d]); last=j; t=bin.t;
            }
            binNodes.push(last);
        }
        split.push([last,b,(1-t)*d]);
    });
    const neighbors = nodes.map(()=>[]);
    for (const [i,j,d] of split) {neighbors[i].push([j,d]); neighbors[j].push([i,d]);}
    const bins = nodes.map(()=>Infinity), open = new Set(binNodes);
    for (const i of open) bins[i]=0;
    while (open.size) {
        let i = -1;
        for (const j of open) if (i<0 || bins[j]<bins[i]) i=j;
        open.delete(i);
        for (const [j,d] of neighbors[i]) if (bins[i]+d<bins[j]) {bins[j]=bins[i]+d;open.add(j);}
    }
    return {walkingNetwork,nodes, links:split, bins, connectedBins:binNodes.length, totalBins:allBins.length};
}
// Registered ground grids preserve observation gaps; no extrapolated heights.
function validateGroundGrid(g) {
    if (!g || !['origin','step'].every(k => Array.isArray(g[k]) && g[k].length===2 && g[k].every(Number.isFinite)) || g.step.some(v=>v<=0)
        || !Array.isArray(g.heights) || g.heights.length<2 || g.heights.length>256 || !Array.isArray(g.heights[0]) || g.heights[0].length<2 || g.heights[0].length>256
        || !g.heights.every(r=>Array.isArray(r)&&r.length===g.heights[0].length&&r.every(z=>z===null||Number.isFinite(z)))) throw Error('Invalid ground grid: use 2–256 rows and columns, metre origin/spacing, and null for missing observations.');
    return g;
}
function groundGridHeight(g,x,y) {
    const u=(x-g.origin[0])/g.step[0],v=(y-g.origin[1])/g.step[1],w=g.heights[0].length,h=g.heights.length;
    if(u<0||v<0||u>w-1||v>h-1)return null;
    const i=Math.min(w-2,Math.floor(u)),j=Math.min(h-2,Math.floor(v)),a=u-i,b=v-j;
    const [tl,tr,br,bl]=[g.heights[j][i],g.heights[j][i+1],g.heights[j+1][i+1],g.heights[j+1][i]];
    if([tl,tr,br,bl].includes(null))return null;
    return a>b?tl*(1-a)+tr*(a-b)+br*b:tl*(1-b)+bl*(b-a)+br*a;
}
function groundGridFaces(g) {
    const faces=[];
    for(let y=0;y<g.heights.length-1;y++)for(let x=0;x<g.heights[0].length-1;x++){
        const p=[[x,y],[x+1,y],[x+1,y+1],[x,y+1]].map(([i,j])=>[g.origin[0]+i*g.step[0],g.origin[1]+j*g.step[1],g.heights[j][i]]);
        if(p.every(q=>q[2]!==null))faces.push([p[0],p[1],p[2]],[p[0],p[2],p[3]]);
    }return faces;
}
function terrain(site, x, y) { if(site.groundGrid)return groundGridHeight(site.groundGrid,x,y) ?? 0; let s = 0, w = 0; for (const p of site.samples) {
    const d = (x - p[0]) ** 2 + (y - p[1]) ** 2;
    if (d < 1e-8)
        return p[2];
    s += p[2] / d;
    w += 1 / d;
} return w ? s / w : 0; }
function importSurvey(data) {
    if (data.type !== 'FeatureCollection' || !Array.isArray(data.features) || data.crs)
        throw Error('Choose a WGS84 GeoJSON FeatureCollection.');
    const groups = [], ground = [], all = [];
    const check = p => { if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 85)
        throw Error('Invalid longitude or latitude.'); all.push(p); return p; };
    for (const f of data.features) {
        const { type, coordinates: c } = f.geometry || {}, props = f.properties || {}, k = props.kind ?? props.class;
        if (k === 'ground') {
            if (type !== 'Point' || !Number.isFinite(c[2]))
                throw Error('Ground samples need Point coordinates with elevation in metres.');
            ground.push(check(c));
            continue;
        }
        if (!Object.hasOwn(kinds, k))
            throw Error('Unknown feature class: ' + String(k) + '. Use properties.kind from the import guide.');
        const geom = { point: 'Point', line: 'LineString', area: 'Polygon' }[kinds[k][2]];
        if (type !== geom && type !== 'Multi' + geom)
            throw Error('Expected ' + geom + ' geometry for ' + k + '.');
        for (let part of type === geom ? [c] : c) {
            if (geom === 'Polygon') {
                if (part.length !== 1)
                    throw Error('Polygons with holes are not supported yet.');
                part = part[0];
                if (part.length < 4 || dist(part[0], part.at(-1)) !== 0)
                    throw Error('A polygon ring must be closed.');
                part = part.slice(0, -1);
            }
            else if (geom === 'Point')
                part = [part];
            else if (part.length < 2)
                throw Error('A line needs at least two points.');
            groups.push({ ...props, kind: k, name: String(props.name || kinds[k][0]), source: String(props.source || 'Survey'), confirmed: props.confirmed === true, p: part.map(check) });
        }
    }
    if (!groups.length)
        throw Error('The survey needs at least one site feature.');
    const west = all.reduce((a, p) => Math.min(a, p[0]), 180), north = all.reduce((a, p) => Math.max(a, p[1]), -90), mx = 111319.49 * Math.cos(north * Math.PI / 180), my = 111319.49;
    const local = p => [(p[0] - west) * mx, (north - p[1]) * my];
    const xy = all.map(local);
    const w = xy.reduce((a, p) => Math.max(a, p[0]), 1), h = xy.reduce((a, p) => Math.max(a, p[1]), 1);
    if (Math.max(w, h) > 10000)
        throw Error('Import a local site under 10 km across.');
    return { name: String(data.name || 'Imported survey'), w, h, origin: [west, north, mx, my], features: groups.map(f => ({ ...f, p: f.p.map(local) })), samples: ground.map(p => [...local(p), p[2]]) };
}
// Clip surface patches to terrain cells before projecting their corners.
function surfaceCells(poly, w, h) {
    const result = [], xs = poly.map(p => p[0]), ys = poly.map(p => p[1]), dx = w / 24, dy = h / 18;
    for (let i = Math.max(0, Math.floor(Math.min(...xs) / dx)); i < Math.min(24, Math.ceil(Math.max(...xs) / dx)); i++)
        for (let j = Math.max(0, Math.floor(Math.min(...ys) / dy)); j < Math.min(18, Math.ceil(Math.max(...ys) / dy)); j++) {
            let patch = poly;
            for (const [axis, edge, sign] of [[0, i * dx, 1], [0, (i + 1) * dx, -1], [1, j * dy, 1], [1, (j + 1) * dy, -1]]) {
                let clipped = [];
                for (const [a, b] of edges(patch, true)) {
                    let da = (a[axis] - edge) * sign, db = (b[axis] - edge) * sign;
                    if (da >= 0)
                        clipped.push(a);
                    if ((da >= 0) !== (db >= 0)) {
                        const t = da / (da - db);
                        clipped.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
                    }
                }
                patch = clipped;
            }
            if (patch.length >= 3)
                result.push(patch);
        }
    return result;
}

function restore(s) { if (!s || ![s.w, s.h].every(v => Number.isFinite(v) && v > 0) || !Array.isArray(s.samples) || !s.samples.every(p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) || !Array.isArray(s.features) || !s.features.every(f => f && Object.hasOwn(kinds, f.kind) && (f.height == null || (Number.isFinite(f.height) && f.height >= 0)) && Array.isArray(f.p) && f.p.length >= (kinds[f.kind][2] === 'area' ? 3 : kinds[f.kind][2] === 'point' ? 1 : 2) && f.p.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) || (s.showContours !== undefined && typeof s.showContours !== 'boolean') || (s.contours !== undefined && (!Array.isArray(s.contours) || !s.contours.every(c => c && Number.isFinite(c.height) && Array.isArray(c.points) && c.points.length === 2 && c.points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))))))
    throw Error('Invalid saved scenario.'); if(s.groundGrid){validateGroundGrid(s.groundGrid);if(!groundGridFaces(s.groundGrid).length)throw Error('Ground grid has no observed cells.');} if(s.contourInterval !== undefined && (!Number.isFinite(s.contourInterval)||s.contourInterval<=0))throw Error('Invalid contour interval.'); if(s.contourInterval){let lo=Infinity,hi=-Infinity;for(const p of s.samples){lo=Math.min(lo,p[2]);hi=Math.max(hi,p[2]);}if((hi-lo)/s.contourInterval>200)throw Error('Contour interval produces more than 200 levels.');} return s; }

if (typeof module !== 'undefined') module.exports = {demo, restore, importSurvey, kinds, terrain, validateGroundGrid, groundGridHeight, groundGridFaces};
