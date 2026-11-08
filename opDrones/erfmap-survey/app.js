'use strict';
const $ = id => document.getElementById(id), svg = $('map'), esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let site = demo(), tab = 'Add', mode = 'Select', kind = 'building', itemType = 'building', analysisTool = 'Elevation map', view3 = false, sel = -1, vertexSel = -1, draft = [], pendingFeature = null, placementPointer = null, history = [], zoom = 1, playing = false, time = 0, speed = 3, showTrails = true, drag = null, frame = 0, net, msg = '', distanceMode = false, distancePoints = [], distancePointer = null, trashSpacing = 30;
try {
    const saved = JSON.parse(localStorage.getItem('erfmap-survey-v1'));
    if (saved?.features && saved.samples)
        site = restore(saved);
}
catch { }
contours=site.showContours!==false;
function persist() { try {
    localStorage.setItem('erfmap-survey-v1', JSON.stringify(site));
}
catch {
    msg = 'Browser storage unavailable. Use Save scenario.';
} }
let folded=true, panMode=false, panDrag=null, offset=[0,0];

let selectedPerson = -1;
function planPedestrians() {
    Object.assign(net, walkingRoutes(site, net.walkingNetwork, scenarioConditions()));
    selectedPerson = -1;
}
function refresh() { net = graph(site); planPedestrians(); walk.invalidate(); time = 0; playing = false; multiplayer.restoreSimulation(); render(); }
function checkpoint() { history.push(JSON.stringify(site.features)); if (history.length > 50)
    history.shift(); }
function commit() { persist(); refresh(); multiplayer.sendSite(); }
function beginFeaturePlacement(feature) {
    pendingFeature = feature;
    itemType = feature.itemType;
    kind = feature.kind;
    mode = 'Draw feature';
    tab = 'Add';
    view3 = false;
    folded = false;
    panMode = false;
    vertexSel = -1;
    draft = [];
    placementPointer = null;
    msg = 'Properties saved. Place the item on the map.';
    render();
}
const n = v => Number(v).toFixed(1), button = (s, attr = '', on = false) => '<button ' + attr + ' class="' + (on ? 'active' : '') + '">' + s + '</button>';
function featureCatalogMarkup() {
    const root = { children: {}, entries: [] };
    Object.entries(featureTypes).filter(([key]) => !['crossing', 'treeCanopy', 'roadSurface', 'shrubPatch', 'unknown'].includes(key)).forEach(([key, type]) => {
        let branch = root;
        for (const part of type.category.split(' · ')) {
            if (!branch.children[part]) {
                branch.children[part] = { children: {}, entries: [] };
                branch.entries.push({ category: part, branch: branch.children[part] });
            }
            branch = branch.children[part];
        }
        branch.entries.push({ item: [key, type] });
    });
    const renderBranch = (branch, depth) => {
        let output = '', buttons = '';
        const flushButtons = () => {
            if (buttons) output += '<div class="feature-grid">' + buttons + '</div>';
            buttons = '';
        };
        for (const entry of branch.entries) {
            if (entry.item) {
                const [key, type] = entry.item;
                buttons += button(esc(type.addLabel || type.label), 'data-add-type="' + key + '"');
            } else {
                flushButtons();
                output += '<section class="catalog-subgroup catalog-depth-' + depth + '"><h4>' + esc(entry.category) + '</h4>' + renderBranch(entry.branch, depth + 1) + '</section>';
            }
        }
        flushButtons();
        return output;
    };
    return '<div class="feature-catalog">' + root.entries.map(entry => '<section class="catalog-category"><h3>' + esc(entry.category) + '</h3>' + renderBranch(entry.branch, 1) + '</section>').join('') + '</div>';
}
const isArea = f => kinds[f.kind][2] === 'area', isPoint = f => kinds[f.kind][2] === 'point';
let scale, cx, cy;
function project(p) { return [cx+(p[0]-site.w/2)*scale,cy+(p[1]-site.h/2)*scale]; }
function world(e) { const r = svg.getBoundingClientRect(); return [(e.clientX - r.left - cx) / scale + site.w / 2, (e.clientY - r.top - cy) / scale + site.h / 2]; }
const points = p => p.map(q => q.join(',')).join(' ');
const poly = (p, fill, stroke = '#647660', extra = '') => '<polygon points="' + points(p) + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1" ' + extra + '/>';
const line = (p, c, w = 1, extra = '') => '<polyline points="' + points(p) + '" fill="none" stroke="' + c + '" stroke-width="' + w + '" stroke-linejoin="round" stroke-linecap="round" ' + extra + '/>';
const circle = (p, r, c, s = 'none', extra = '') => '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + r + '" fill="' + c + '" stroke="' + s + '" ' + extra + '/>';
const chrome = () => document.body.classList.contains('theme-light')
    ? { ground:'#f6f8f8', edge:'#798c96', hatch:'#e1e6e9', hatchLine:'#93a2ad', labelInk:'#354638', labelHalo:'#f5f5e9' }
    : { ground:'#1f2622', edge:'#6f8580', hatch:'#2b3330', hatchLine:'#56645f', labelInk:'#eef3e6', labelHalo:'#141816' };
const label = (p, s, size = 10) => '<text x="' + p[0] + '" y="' + p[1] + '" text-anchor="middle" font-size="' + size + '" fill="'+chrome().labelInk+'" stroke="'+chrome().labelHalo+'" stroke-width="3" paint-order="stroke">' + esc(s) + '</text>';
function feature(f, i) {
    const p = f.p.map(q => project(q)), c = featureColor(f), selected = i === sel && !view3;
    let s = '';
    if (isArea(f)) {
        const fill = f.kind === 'building' && !f.itemType ? 'url(#hatch)' : c;
        s += poly(p,fill,selected?'#155d76':'#647780');
        if (!view3 && f.kind === 'building' && ($('measure').checked || selected)) {
            let m = p.reduce((v, q) => [v[0] + q[0] / p.length, v[1] + q[1] / p.length], [0, 0]);
            s += label(m, n(area(f.p)) + ' m²');
        }
    }
    else if (!isPoint(f)) {
        const invisible = f.itemType === 'fence' && f.tagProperties?.visibility === 'Invisible';
        const width = ['path', 'road'].includes(f.itemType) ? Math.max(3, Math.min(60, scale * Number(f.tagProperties?.width || (f.itemType === 'road' ? 6 : 1.8)))) : Math.max(4, scale * 1.6);
        if (f.kind === 'path' && f.tagProperties?.widthProfile) {
            const widths = featureSegmentWidths(f).map(v => Math.max(3, Math.min(60, scale*v)));
            for (let j=0;j<widths.length;j++) s += line(p.slice(j,j+2), '#938d77', widths[j]+2);
            for (let j=0;j<widths.length;j++) s += line(p.slice(j,j+2), c, widths[j]);
        } else s += line(p, '#938d77', width + 2) + line(p, c, width, invisible ? 'stroke-dasharray="3 4" opacity=".38"' : '');
        if (selected && ['path', 'road'].includes(f.itemType))
            s += label(p[Math.floor(p.length / 2)], Number(f.tagProperties?.width || (f.itemType === 'road' ? 6 : 1.8)).toFixed(1) + ' m · ' + (f.tagProperties?.surface || (f.itemType === 'road' ? 'Road' : 'Path')), 9);
    }
    else {
        const q = p[0], growth = Number(f.tagProperties?.maxGrowth || (f.itemType === 'largeTree' ? 18 : f.itemType === 'smallTree' ? 5 : 16)), r = Math.max(4, scale * (f.kind === 'tree' ? Math.min(6, growth / 7) : 0.9));
        if (f.kind === 'dangerSign') {
            const [x,y]=q;
            s+=circle(q,warningRadius(f)*scale,c,'#9e6727','fill-opacity=".09" stroke-dasharray="5 4" pointer-events="none"');
            s+=poly([[x,y-9],[x+9,y+7],[x-9,y+7]],c,'#493421');
            s+=line([[x,y-3],[x,y+1]],'#34291a',2)+circle([x,y+4],1.1,'#34291a');
        }
        else if (f.kind === 'tree') {
            s += circle(q,r,c,'#6f8777') + line([[q[0]-3,q[1]],[q[0]+3,q[1]]],'#647c6f') + line([[q[0],q[1]-3],[q[0],q[1]+3]],'#647c6f');
        }
        else if (f.kind === 'bush') {
            s += circle(q, Math.max(5, r * 1.5), c, '#557b58') + circle([q[0] - 2, q[1] - 1], Math.max(2, r * .48), c, 'none') + circle([q[0] + 2, q[1] + 1], Math.max(2, r * .42), c, 'none');
        }
        else if (f.kind === 'bench') {
            const length = Math.max(0.8, Math.min(8, Number(f.tagProperties?.length || 1.8))) * Math.max(1, scale * .65);
            s += line([[q[0] - length / 2, q[1]], [q[0] + length / 2, q[1]]], c, Math.max(4, scale * .55));
        }
        else if (f.kind === 'light') {
            const lumens = Math.max(0, Number(f.tagProperties?.brightness ?? 1800)), glow = Math.max(4, Math.min(15, 3 + Math.log10(lumens + 1) * 2));
            s += circle(q, glow, c, '#8a773e', 'opacity=".78"') + circle(q, 2.5, '#fff4c2');
        }
        else {
            s += circle(q, r, c, '#fff');
            if (!view3)
                s += label([q[0], q[1] - 8], f.name, 9);
        }
    }
    if (['unknown', 'unknownLine', 'unknownPoint'].includes(f.kind)) {
        const center = p.reduce((sum, point) => [sum[0] + point[0] / p.length, sum[1] + point[1] / p.length], [0, 0]);
        s += '<text x="' + center[0] + '" y="' + center[1] + '" text-anchor="middle" font-size="16" font-weight="700" fill="#b43f56" stroke="#fff" stroke-width="3" paint-order="stroke">!</text>';
    }
    if (selected && ['road', 'roadSurface'].includes(f.itemType)) {
        const center = p.reduce((sum, point) => [sum[0] + point[0] / p.length, sum[1] + point[1] / p.length], [0, 0]);
        s += label(center, Number(f.tagProperties?.width || 6).toFixed(1) + ' m · ' + (f.tagProperties?.surface || 'Road'), 9);
    }
    const type = featureTypes[f.itemType] || featureTypes[defaultItemTypeForKind(f.kind)];
    const side = f.tagProperties?.side && f.tagProperties.side !== 'Entire feature' ? ' · ' + f.tagProperties.side : '';
    return '<g data-i="' + i + '"><title>' + esc(f.name + ' · ' + type.label + side) + '</title>' + s + '</g>';
}
function sampleTrip(trip, d) { let path = [trip.p[0]]; for (const [a, b] of edges(trip.p)) {
    let l = dist(a, b);
    if (d <= l) {
        path.push([a[0] + (b[0] - a[0]) * d / l, a[1] + (b[1] - a[1]) * d / l]);
        break;
    }
    path.push(b);
    d -= l;
} return path; }
function pedestrianState(trip,index) {
    const elapsed=time-index*2, local=Math.max(0,elapsed)%trip.duration;
    const taskIndex=trip.tasks.findIndex(task=>local<task.finish);
    const task=trip.tasks[taskIndex], stopped=local>=task.arrival;
    const distance=stopped?task.distance:task.startDistance+(local-task.start)*trip.pace;
    const trail=sampleTrip(trip,distance);
    return {waiting:elapsed<0, taskIndex, stopped, task, distance, trail, position:trail.at(-1)};
}
function inspectPedestrian(index) {
    selectedPerson=index;
    folded=false;
    render();
}
function inspectorText(trip,index) {
    const state=pedestrianState(trip,index);
    const phase=state.waiting?'Waiting at '+trip.origin:state.stopped?state.task.action+' · '+state.task.place:'Walking to '+state.task.place;
    return phase+' · Task '+(state.taskIndex+1)+' of '+trip.tasks.length;
}
function pedestrianInspector() {
    const options=net.trips.map((t,i)=>'<option value="'+i+'" '+(i===selectedPerson?'selected':'')+'>'+esc(t.name)+'</option>').join('');
    let html='<label>Inspect pedestrian<select id="personSelect"><option value="-1">All pedestrians</option>'+options+'</select></label>';
    const t=net.trips[selectedPerson];
    if(!t)return html;
    return html+'<section class="person-card"><h3>'+esc(t.name)+'</h3><p>'+walkingHabits[t.habit]+(t.alternateLegs?' Alternate route chosen on this trip.':'')+'</p><p>'+esc(t.origin)+' → '+esc(t.destination)+'</p><p>'+t.pace.toFixed(2)+' m/s · '+t.d.toFixed(0)+' m route</p><strong id="personPhase">'+esc(inspectorText(t,selectedPerson))+'</strong><ol>'
        +t.tasks.map(task=>'<li>'+esc(task.action)+' · '+esc(task.place)+' <small>'+Math.round(task.finish-task.arrival)+' s</small></li>').join('')
        +'</ol>'+button('Show all paths','id="clearPerson"')+'</section>';
}
function actors() {
    let trails='', agents='';
    net.trips.forEach((t,i)=>{
        const state=pedestrianState(t,i), selected=i===selectedPerson;
        if(selected || (selectedPerson<0 && showTrails && !state.waiting)) {
            const path=selected?t.p:state.trail;
            trails+=line(path.map(project),selected?'#176b88':'#dd731f',selected?4:2,'opacity=".85" pointer-events="none"');
        }
        if(state.waiting)return;
        const q=project(state.position);
        agents+='<g data-person="'+i+'" style="cursor:pointer"><title>'+esc(t.name)+'</title>'
            +circle(q,11,'transparent')+circle(q,selected?7:5,selected?'#176b88':'url(#orb)',selected?'white':'#623f24')+'</g>';
    });
    return trails+agents;
}
function draw() {
    svg.classList.toggle('analysis-map', tab === 'Analyse');
    if (view3) { walk.draw(); return; }
    const W = svg.clientWidth, H = svg.clientHeight;
    if (!W)
        return;
    const compact=W<750, sidebar=folded||compact?0:352;
    const sheet=Math.min(innerHeight*.52,440)+12;
    const topInset=compact?120:84, bottomInset=compact&&!folded?sheet:compact?84:112;
    cx=(W+sidebar)/2+offset[0];cy=(H+topInset-bottomInset)/2+offset[1];
    scale=zoom*Math.min(Math.max(80,W-sidebar-66)/site.w,Math.max(80,H-topInset-bottomInset)/site.h);
    let s='<defs><pattern id="hatch" patternUnits="userSpaceOnUse" width="6" height="6"><rect width="6" height="6" fill="'+chrome().hatch+'"/><path d="M-1 1L1 -1M0 6L6 0M5 7L7 5" stroke="'+chrome().hatchLine+'" stroke-width=".8"/></pattern><radialGradient id="orb"><stop stop-color="#ffd88a"/><stop offset="1" stop-color="#e07c39"/></radialGradient></defs>';
    s += poly(rect(0,0,site.w,site.h).map(q=>project(q)),chrome().ground,chrome().edge,'stroke-dasharray="5 3"');
    const top=project([site.w/2,0]);
    s+=label([top[0],top[1]-10],n(site.w)+' m  ·  E–W');
    s+=label(project([site.w/2,site.h+15/scale]),n(site.h)+' m  ·  N–S');
    const rank = f => f.kind === 'grass' ? -1 : isPoint(f) ? 3 : f.kind === 'building' ? 2 : isArea(f) ? 0 : 1;
    site.features.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f) - rank(b.f) || (view3 ? project(a.f.p[0])[1] - project(b.f.p[0])[1] : 0)).forEach(({ f, i }) => s += feature(f, i));
    if (tab === 'Analyse') s += analysisHeatmapMarkup(site, analysisTool, scale, project);
    if (tab === 'Analyse' && analysisTool === 'Trash Can') s += analysisTrashOverlay(site, trashSpacing, scale, project, line, circle);
    if (distancePoints.length) {
        const projected = distancePoints.map(project);
        if (distanceMode && distancePointer) s += line([projected[0], project(distancePointer)], '#7752bd', 2, 'stroke-dasharray="5 4" pointer-events="none"');
        if (projected.length === 2) {
            s += line(projected, '#7752bd', 2.5, 'pointer-events="none"');
            s += label([(projected[0][0] + projected[1][0]) / 2, (projected[0][1] + projected[1][1]) / 2 - 9], n(dist(distancePoints[0], distancePoints[1])) + ' m', 12);
        } else s += label([projected[0][0], projected[0][1] - 9], 'A', 11);
        projected.forEach(p => s += circle(p, 5, '#fff', '#7752bd', 'stroke-width="2" pointer-events="none"'));
        if (distanceMode && distancePointer) s += circle(project(distancePointer), 4, '#7752bd', '#fff', 'pointer-events="none"');
    }
    if (!view3 && $('measure').checked && tab === 'Add') {
        for (const [i, f] of site.features.entries()) {
            if (i === sel || isPoint(f))
                continue;
            if (isArea(f) && f.kind !== 'building') {
                const center = f.p.reduce((v, p) => [v[0] + p[0] / f.p.length, v[1] + p[1] / f.p.length], [0, 0]);
                const q = project(center);
                if (f.kind === 'grass')
                    q[1] += 18;
                s += label(q, n(area(f.p)) + ' m²', 9);
            }
            if (!isArea(f))
                for (const [a, b] of edges(f.p)) {
                    const q = project([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
                    if (dist(a, b) * scale > 34)
                        s += label([q[0] + (Math.abs(a[0] - b[0]) < 1 ? 16 : 0), q[1] - 5], n(dist(a, b)) + ' m', 9);
                }
        }
    }
    s+='<g id="terrain-contours" pointer-events="none">'+elevationPlan(tab === 'Analyse' && analysisTool === 'Elevation map')+'</g>';
    if (tab === 'Analyse' && analysisTool==='Real Paths (Desire Paths)') s+=realPathOverlay();
    if (tab === 'Simulate')
        s += '<g id="actors">' + actors() + '</g>';
    if (!view3 && tab === 'Add' && sel >= 0) {
        let f = site.features[sel];
        edges(f.p, isArea(f)).forEach(([a, b]) => { const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], q = project(mid); s += label([q[0], q[1] - 6], n(dist(a, b)) + ' m'); });
        f.p.forEach((p, j) => s += circle(project(p), 5, 'white', '#236046', 'data-v="' + j + '" stroke-width="2"'));
    }
    if (!view3 && tab === 'Add' && mode === 'Draw feature' && ['bin', 'entrance', 'destination', 'path', 'crossing'].includes(kind)) {
        for (const f of site.features.filter(f => ['path', 'crossing'].includes(f.kind)))
            for (const p of f.p)
                s += circle(project(p), 3, '#fff', '#386c47');
    }
    if(snapPreview&&tab==='Add'&&mode==='Draw feature'){
        s+=circle(project(snapPreview),8,'none','#25816a','stroke-width="2" pointer-events="none"');
    }
    if (pendingFeature && placementPointer && tab === 'Add' && mode === 'Draw feature') {
        const cursorPoint = project(placementPointer), previewPoints = [...draft, placementPointer].map(project), color = featureColor(pendingFeature);
        if (isArea(pendingFeature) && draft.length >= 2)
            s += poly(previewPoints, color, color, 'fill-opacity=".18" stroke-dasharray="4 3" pointer-events="none"');
        else if (!isPoint(pendingFeature) && draft.length)
            s += line(previewPoints, color, Math.max(3, scale * Number(pendingFeature.tagProperties?.width || 1.8)), 'stroke-dasharray="4 3" pointer-events="none"');
        s += circle(cursorPoint, isPoint(pendingFeature) ? 8 : 5, color, '#315a62', 'opacity=".76" pointer-events="none"');
    }
    if (draft.length) {
        s += line(draft.map(q => project(q)), '#155636', 2, 'stroke-dasharray="4 3"');
        draft.forEach(p => s += circle(project(p), 4, '#397654'));
    }
    const target=70/scale, magnitude=10**Math.floor(Math.log10(target)), unit=([5,2,1].find(v=>v*magnitude<=target)||1)*magnitude;
    const barY=H-18;
    s+=line([[18,barY-4],[18,barY],[18+unit*scale,barY],[18+unit*scale,barY-4]],'#344a59',1.5)+label([18+unit*scale/2,barY-5],unit+' m',9);
    multiplayer.paintPlan();
    svg.innerHTML = s;
}
const hints = { 'Select': 'Select and drag vertices or standalone items. Backspace removes the selected vertex, or the feature if no vertex is selected.', 'Draw feature': 'Click to place points. Paths snap to nearby junctions and segments. Finish the shape below.', 'Move vertex': 'Select a feature, then drag a white handle.' };
function render() {
    $('name').textContent = site.name;
    $('subtitle').textContent = (site.demo ? 'Demonstration survey' : 'Imported survey') + '   •   ' + site.features.length + ' mapped features   •   Local metres';
    document.body.classList.toggle('walking',view3);
    document.body.classList.toggle('pedestrian-tools',!folded && (tab==='Simulate' || (tab==='Analyse' && analysisTool==='Real Paths (Desire Paths)')));
    $('walk').hidden=!view3; $('pad').hidden=!view3; svg.toggleAttribute('hidden',view3);
    $('toolBody').hidden=folded;
    $('fold').textContent='Close panel';
    $('fold').closest('aside').hidden=folded;
    $('panelTitle').textContent=tab==='Add'?'Add features':tab==='Analyse'?'Analysis':tab==='Properties'?'Properties & tagging':'Simulation';
    $('toolbarUndo').disabled=!history.length;
    $('contours').checked=contours;
    $('contours').disabled=!site.samples.length && !site.contours?.length;
    $('contourInterval').disabled=!site.samples.length;
    if(document.activeElement!==$('contourInterval'))$('contourInterval').value=site.contourInterval??'';
    $('fold').setAttribute('aria-expanded',String(!folded));document.body.classList.toggle('folded',folded);
    $('pan').setAttribute('aria-pressed',String(panMode));svg.style.cursor=panMode?'grab':'';
    $('distanceTool').setAttribute('aria-pressed',String(distanceMode));
    $('distanceTool').classList.toggle('active',distanceMode);
    if (distanceMode) svg.style.cursor='crosshair';
    $('pan').classList.toggle('active',panMode);
    $('toolbarSelect').setAttribute('aria-pressed',String(tab==='Add'&&mode==='Select'&&!panMode&&!distanceMode));
    $('toolbarSelect').classList.toggle('active',tab==='Add'&&mode==='Select'&&!panMode&&!distanceMode);
    if(!view3){walk.stop();$('surface').style.background='';}
    $('flat').classList.toggle('active', !view3);
    $('styleControl').hidden=!view3;
    $('walker').hidden=view3; $('flat').hidden=!view3;
    $('badge').textContent = view3 ? 'FIELD TRIP   //   FIRST PERSON' : '↑ N    │    S–01   SITE PLAN';
    $('tabs').innerHTML = ['Add', 'Analyse', 'Simulate', 'Properties'].map(t => button(t, 'data-tab="' + t + '"' + (t === 'Properties' ? ' title="' + (sel >= 0 ? 'Edit selected item properties and tags' : 'Select an item to view its properties and tags') + '"' : '') + ' aria-expanded="'+String(!folded&&t===tab)+'"', t === tab&&!folded)).join('');
    let h = '';
    if (tab === 'Add') {
        if (view3)
            h = '<div class="note">Walk with WASD or arrows. Hold Shift to run, press Space to jump, and drag to look around. Return to the plan to use map analysis tools.</div>' + button('Edit in 2D Plan', 'id="editplan"');
        else {
            h = '<p class="note">Choose an item to set its name, color, and specifications before placing it.</p>' + featureCatalogMarkup();
            if (pendingFeature)
                h += '<div class="placement-ready"><strong>Ready to place: ' + esc(pendingFeature.name) + '</strong><p>' + (isPoint(pendingFeature) ? 'Click the map to place this item.' : 'Click the map to add vertices, then finish the shape.') + '</p>' + button('Cancel placement', 'id="cancel"') + '</div>';
            if (draft.length)
                h += button('Finish shape (' + draft.length + ')', 'id="finish"') + ' ' + button('Cancel placement', 'id="cancel"');
            if (sel >= 0) {
                const f = site.features[sel];
                h += '<h3>' + esc(f.name) + '</h3><p>' + esc(f.source) + ' · ' + (isArea(f) ? n(area(f.p)) + ' m²' : isPoint(f) ? f.p[0].map(n).join(', ') + ' m' : n(edges(f.p).reduce((s, [a, b]) => s + dist(a, b), 0)) + ' m') + '</p>';
                if (vertexSel >= 0) h += '<p class="note">Vertex ' + (vertexSel + 1) + ' selected · Backspace removes it.</p>';
                h += button('Properties / Tagging…', 'data-command="properties"');
                if (['path', 'crossing'].includes(f.kind))
                    h += '<label><input type="checkbox" id="confirm" ' + (f.confirmed !== false ? 'checked' : '') + '> Confirm walkable route</label>';
            }
            h += '<h3>Scenario history</h3>' + button('↶ Undo edit', 'id="undo" ' + (history.length ? '' : 'disabled'));
        }
    }
    if (tab === 'Analyse') {
        const tools=['Land-use quantities','Green space','Elevation map','Real Paths (Desire Paths)','Low visibility (lights)','Trash Can'];
        const picker=analysisTool==='Real Paths (Desire Paths)'
            ? '<label>Analysis layer<select id="analysisLayer">'+tools.map(t=>'<option '+(t===analysisTool?'selected':'')+'>'+esc(t)+'</option>').join('')+'</select></label>'
            : '<h3>Analysis tools</h3>'+tools.map(t=>'<button class="wide '+(analysisTool===t?'active':'')+'" data-analysis-tool="'+esc(t)+'">'+esc(t)+'</button>').join('');
        h=picker+analysisDetailsMarkup(analysisTool,site,trashSpacing);

    }
    if (tab === 'Properties') {
        h = sel >= 0 && site.features[sel]
            ? '<section id="propertiesPanel"><p class="property-intro">Edit the selected item’s name, color, specifications, and location.</p><p id="propertiesPanelMessage" role="status"></p><div id="propertiesPanelFields"></div><div class="property-actions"><button type="button" id="applyPanelProperties" class="active">Save properties</button></div></section>'
            : '<section id="propertiesPanelEmpty" title="Select an item on the map to load its properties"><h3>Select an item</h3><p class="note">Choose an item on the map. Its properties and tagging options will appear here.</p></section>';
    }
    if (tab === 'Simulate')
        h = '<h3>Pedestrians</h3><div class="population-controls"><label>Population <input id="populationCount" type="number" min="0" max="'+populationLimit+'" step="1" value="'+net.requested+'"></label>'+button('Shuffle habits','id="shuffleHabits"')+'</div>'+pedestrianInspector()+'<p class="note">' + net.trips.length + ' pedestrians · ' + net.missed + ' unreachable access pairs'+(net.requested && !net.trips.length?' · Add two connected map-edge paths, building approaches, or access markers.':'')+'</p><label class="trail-toggle"><input type="checkbox" id="showTrails" ' + (showTrails ? 'checked' : '') + '> Show lines following characters</label><label>Playback speed · ' + speed + '×<input id="speed" type="range" min="1" max="16" value="' + speed + '"></label>' + button(playing ? 'Pause' : '▶ Run simulation', 'id="run" ' + (net.trips.length ? '' : 'disabled')) + ' ' + button('Reset', 'id="reset"')+environmentControls();
    $('panel').innerHTML = h;
    if (tab === 'Properties' && typeof renderPropertiesPanel === 'function') renderPropertiesPanel();
    const distanceStatus = distanceMode ? (distancePoints.length ? 'Click the second point to complete the measurement.' : 'Click two points on the map to measure their distance.') : distancePoints.length === 2 ? 'Measured distance: ' + n(dist(distancePoints[0], distancePoints[1])) + ' m. Click Distance to start another measurement.' : '';
    const analysisStatus = analysisTool === 'Elevation map' ? 'Click two map points to graph the elevation profile.' : analysisTool === 'Real Paths (Desire Paths)' ? 'Real Paths shows the routes generated by the pedestrian simulation.' : 'Analysis heat map is shown on the site plan.';
    $('status').textContent = distanceStatus || msg || (view3 ? (site.samples.length ? 'Terrain interpolated from ' + site.samples.length + ' ground samples.' : 'No ground samples supplied. Flat terrain preview.') : (tab === 'Add' ? hints[mode] : tab === 'Analyse' ? analysisStatus : tab === 'Properties' ? (sel >= 0 ? 'Editing selected item properties.' : 'Select an item on the map to view its properties.') : 'Select a pedestrian to inspect their tasks and isolate their route.'));
    $('legend').innerHTML = ['building', 'grass', 'tree', 'road', 'path', 'water', 'bin'].map(k => '<span><i style="background:' + kinds[k][1] + '"></i>' + kinds[k][0] + '</span>').join('');
    draw();
}
let snapPreview=null;
function snap(q) {
    if(['path','crossing'].includes(kind))return pathSnap(q,site.features,12/scale);

    if(kind==='bin'){
        let nearest=q, best=8/scale;
        for(const [i,j,d] of net.links){
            const a=net.nodes[i],b=net.nodes[j], t=Math.max(0,Math.min(1,((q[0]-a[0])*(b[0]-a[0])+(q[1]-a[1])*(b[1]-a[1]))/(d*d)));
            const p=a.map((v,k)=>v+t*(b[k]-v)),gap=dist(p,q);
            if(gap<best){nearest=p;best=gap;}
        }
        return [...nearest];
    }
    let best = 8 / scale, out = q; const anchor = ['entrance', 'destination', 'bin'].includes(kind); for (const f of site.features.filter(f => !anchor || ['path', 'crossing'].includes(f.kind)))
    for (const p of f.p) {
        let d = dist(q, p);
        if (d < best) {
            best = d;
            out = p;
        }
    } return [...out]; }
function finish() {
    const type = kinds[kind][2], min = { area: 3, line: 2, point: 1 }[type];
    if (draft.length < min) {
        msg = 'Place at least ' + min + ' points.';
        render();
        return;
    }
    if (type === 'area' && area(draft) < .01) {
        msg = 'Draw a polygon with measurable area.';
        render();
        return;
    }
    checkpoint();
    const newFeature = pendingFeature ? { ...pendingFeature, tagProperties: { ...pendingFeature.tagProperties } } : { kind, itemType, tagProperties: Object.fromEntries((featureTypes[itemType].fields || []).map(field => [field.key, field.default])), name: featureTypes[itemType].label };
    if (kinds[kind][2] !== 'point' && !newFeature.tagProperties.side) newFeature.tagProperties.side = 'Entire feature';
    site.features.push({ ...newFeature, p: draft, source: 'Proposed', confirmed: true });
    sel = site.features.length - 1;
    vertexSel = -1;
    joinPathVertices(site.features,sel);snapPreview=null;
    draft = [];
    pendingFeature = null;
    placementPointer = null;
    mode = 'Select';
    msg = 'Feature added to scenario.';

    commit();
}
let simulationFrame = 0;
function wakeSimulation() {
    if (!simulationFrame && playing) simulationFrame = requestAnimationFrame(tick);
}
function tick(now) {
    simulationFrame = 0;
    if (!playing) return;
    time = multiplayer.simulationTime();
    frame = now;
    const phase=$('personPhase');
    if(phase && net.trips[selectedPerson]) phase.textContent=inspectorText(net.trips[selectedPerson],selectedPerson);
    const group = $('actors'); if (view3) walk.draw(); else if (group)
    group.innerHTML = actors(); wakeSimulation(); }
document.addEventListener('click', e => {
    let b = e.target.closest('button');
    if (!b || b.id==='walker' || b.hasAttribute('data-walk'))
        return;
    if (['applyProperties', 'applyPanelProperties', 'cancelProperties', 'closeProperties'].includes(b.id)) return;
    msg = '';
    if (b.dataset.addType) {
        distanceMode = false; distancePoints = []; distancePointer = null;
        itemType = b.dataset.addType;
        kind = featureTypes[itemType].kind;
        pendingFeature = null;
        placementPointer = null;
        draft = [];
        mode = 'Select';
        panMode = false;
        folded = false;
        tab = 'Add';
        openNewFeatureProperties(itemType);
        return;
    }
    if (b.dataset.tab === 'Properties') {
        openProperties();
        return;
    }
    if (b.dataset.tab) {
        if (distanceMode) { distanceMode = false; distancePoints = []; distancePointer = null; }
        if (b.dataset.tab !== 'Add') {
            pendingFeature = null;
            placementPointer = null;
            draft = [];
            mode = 'Select';
        }
        folded=false;tab = b.dataset.tab;
        panMode = false;
        if (tab === 'Analyse') view3 = false;
        draft = [];
        vertexSel = -1;
    }
    if (b.dataset.analysisTool) {
        analysisTool = b.dataset.analysisTool;
        if (analysisTool !== 'Elevation map') profilePoints = [];
    }
    switch (b.id) {
        case 'pan':
            view3=false;folded=true;mode='Select';panMode=!panMode;distanceMode=false;distancePoints=[];distancePointer=null;vertexSel=-1;draft=[];pendingFeature=null;placementPointer=null;
            break;
        case 'toolbarSelect':
            view3=false;tab='Add';folded=false;mode='Select';panMode=false;distanceMode=false;distancePoints=[];distancePointer=null;vertexSel=-1;draft=[];pendingFeature=null;placementPointer=null;
            break;
        case 'distanceTool':
            distanceMode = !distanceMode;
            mode = 'Select';
            panMode = false;
            distancePoints = [];
            distancePointer = null;
            view3 = false;
            panMode = false;
            msg = distanceMode ? 'Click two points on the map to measure their distance.' : '';
            break;
        case 'clearPerson': selectedPerson=-1;break;
        case 'fold': folded=!folded;break;
        case 'editplan':
            view3 = false;
            tab = 'Add';
            break;
        case 'flat':
            view3 = false;
            break;
        case 'fit':
            zoom = 1; offset=[0,0];
            folded = true;
            break;
        case 'plus':
            zoom = Math.min(5, zoom * 1.25);
            break;
        case 'minus':
            zoom = Math.max(.5, zoom / 1.25);
            break;
        case 'finish':
            finish();
            return;
        case 'cancel':
            draft = [];
            pendingFeature = null;
            placementPointer = null;
            mode = 'Select';
            break;
        case 'undo':
            if (history.length) {
                site.features = JSON.parse(history.pop());
                sel = -1;
                vertexSel = -1;
                draft = [];
                commit();
            }
            return;
        case 'run':
            multiplayer.simulationCommand(playing ? 'pause' : 'run');
            return;
        case 'shuffleHabits':
            updatePopulation({seed:crypto.getRandomValues(new Uint32Array(1))[0]});
            return;
        case 'reset':
            multiplayer.simulationCommand('reset');
            return;
        case 'properties':
            openProperties();
            return;
        case 'import':
            $('file').click();
            return;
        case 'save': {
            const savedSite={...site,showContours:contours,contours:scenarioContours(site)};
            const blob = new Blob([JSON.stringify({ format: 'fieldform-site-v1', site:savedSite }, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a');
            a.href = url;
            a.download = 'fieldform-scenario.json';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            return;
        }
    }
    render();
});
function updatePopulation(settings){
    site.pedestrians={...site.pedestrians,...settings};
    persist();planPedestrians();time=0;playing=false;render();multiplayer.sendSite();
}
document.addEventListener('change', async (e) => {
    let el = e.target;
    if (el.id === 'file') {
        try {
            if(!el.files[0])return;
            const file=el.files[0];
            let data = /\.glb$/i.test(file.name) ? intakeShared.readGlb(new Uint8Array(await file.arrayBuffer())) : JSON.parse(await file.text());
            let next = data.type === 'FeatureCollection' ? importSurvey(data) : restore(data.site || data);
            site = next;contours=site.showContours!==false;profilePoints=[];
            sel = -1;
            history = [];
            draft = [];
            zoom = 1; offset=[0,0];
            msg = 'Survey loaded.';
            commit();
        }
        catch (err) {
            msg = err.message;
            render();
        }
        el.value = '';
        return;
    }
    if (el.closest('#propertiesPanelFields') || ['contourInterval','groundFile'].includes(el.id)) return;
    if(el.id==='contours'){contours=el.checked;site.showContours=contours;persist();multiplayer.sendSite();}
    if(el.id==='analysisLayer'){analysisTool=el.value;profilePoints=[];}
    if(el.id==='populationCount'){
        const count=el.valueAsNumber;
        if(!Number.isInteger(count) || count<0 || count>populationLimit){
            el.value=net.requested;
            msg='Choose a whole number from 0 to '+populationLimit+'.';
            render();return;
        }
        if(count!==net.requested)updatePopulation({count});
        return;
    }
    if(el.id==='realPathMode')realPathMode=el.value;
    if(el.id==='personSelect')selectedPerson=Number(el.value);
    if(el.id==='showTrails'){multiplayer.simulationCommand('trails',el.checked);return;}
    if(el.id==='trashSpacing')trashSpacing=Number(el.value);

    if (el.id === 'speed'){multiplayer.simulationCommand('speed',+el.value);return;}
    if (el.id === 'confirm' && !view3 && sel >= 0) {
        checkpoint();
        site.features[sel].confirmed = el.checked;
        site.features[sel].source = 'Edited';
        commit();
        return;
    }
    render();
});
svg.addEventListener('pointerdown', e => {
    const person=e.target.closest('[data-person]');
    if(tab==='Simulate' && person && e.button===0) { inspectPedestrian(Number(person.dataset.person));return; }
    if (!view3 && (e.button===1 || (e.button===0&&panMode))) {
        e.preventDefault();panDrag=[e.clientX-offset[0],e.clientY-offset[1]];svg.setPointerCapture(e.pointerId);return;
    }
    if (e.button !== 0)
        return;
    msg = '';
    if (view3) return;
    let target = e.target, vi = target.dataset.v, hit = target.closest('[data-i]'), i = hit ? +hit.dataset.i : -1, q = world(e);
    if (distanceMode) {
        if (q[0] < 0 || q[0] > site.w || q[1] < 0 || q[1] > site.h) return;
        if (distancePoints.length >= 2) distancePoints = [];
        distancePoints.push(q);
        distancePointer = null;
        if (distancePoints.length === 2) distanceMode = false;
        render();
        return;
    }
    if (tab === 'Analyse') {
        if (analysisTool === 'Elevation map' && site.samples.length && q[0] >= 0 && q[0] <= site.w && q[1] >= 0 && q[1] <= site.h) {
            if (profilePoints.length >= 2) profilePoints = [];
            profilePoints.push(q);
            render();
        }
        return;
    }
    if (tab === 'Properties') {
        sel = i;
        vertexSel = -1;
        render();
        return;
    }
    if (tab !== 'Add') return;
    if (mode === 'Draw feature') {
        if (q[0] < 0 || q[0] > site.w || q[1] < 0 || q[1] > site.h)
            return;
        q = snap(q);
        if (!draft.length || dist(q, draft.at(-1)) > .01)
            draft.push(q);
        if (kinds[kind][2] === 'point')
            finish();
        else
            render();
        return;
    }
    if (mode === 'Select' && vi === undefined && i >= 0 && isPoint(site.features[i])) {
        sel = i;
        vertexSel = 0;
        drag = { v: 0, old: JSON.stringify(site.features), moved: false };
        svg.setPointerCapture(e.pointerId);
        render();
        return;
    }
    if (sel >= 0 && vi !== undefined) {
        const f = site.features[sel];
        if (mode === 'Move vertex' || mode === 'Select') {
            vertexSel = +vi;
            drag = { v: +vi, old: JSON.stringify(site.features), moved: false };
            svg.setPointerCapture(e.pointerId);
            return;
        }
        return;
    }
    sel = i;
    vertexSel = -1;
    render();
});
svg.addEventListener('pointermove', e => {
    if (!view3) multiplayer.updatePresence(world(e), false);
    if(panDrag){offset=[e.clientX-panDrag[0],e.clientY-panDrag[1]];draw();return;}
    if(!drag){
        if (distanceMode) {
            const point = world(e);
            distancePointer = point[0] >= 0 && point[0] <= site.w && point[1] >= 0 && point[1] <= site.h ? point : null;
            draw();
            return;
        }
        if (pendingFeature && tab === 'Add' && mode === 'Draw feature') {
            const point = world(e);
            placementPointer = point[0] >= 0 && point[0] <= site.w && point[1] >= 0 && point[1] <= site.h ? snap(point) : null;
            draw();
            return;
        }
        if(!view3&&tab==='Add'&&mode==='Draw feature'&&['path','crossing'].includes(kind)){
            const p=world(e),q=pathSnap(p,site.features,12/scale);
            snapPreview=dist(p,q)>.00001?q:null;draw();
        }
        return;
    }
    const p=world(e),feature=site.features[sel];
    let q=[Math.max(0,Math.min(site.w,p[0])),Math.max(0,Math.min(site.h,p[1]))];
    if(isPath(feature))q=pathSnap(q,site.features,12/scale,sel);
    if(feature.p.some((v,i)=>i!==drag.v&&dist(v,q)<.01))return;
    feature.p[drag.v]=q;drag.moved=true;draw();
});
svg.addEventListener('pointerleave',()=>{snapPreview=null;placementPointer=null;distancePointer=null;if(!view3)draw();});
svg.addEventListener('pointerup', () => {
    panDrag=null;
    if (drag?.moved) {
        history.push(drag.old);
        joinPathVertices(site.features,sel);
        site.features[sel].source = 'Edited';
        commit();
    } else if (drag) render();
    drag = null;
});
svg.addEventListener('pointercancel', () => { panDrag=null; if (drag?.old) {
    site.features = JSON.parse(drag.old);
    render();
} drag = null; });
window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        if (distanceMode || distancePoints.length) {
            distanceMode = false;
            distancePoints = [];
            distancePointer = null;
            render();
            return;
        }
        draft = [];
        pendingFeature = null;
        placementPointer = null;
        mode = 'Select';
        render();
    }
    if (e.key === 'Enter' && draft.length)
        finish();
    if (e.key !== 'Backspace' || e.defaultPrevented || view3 || tab !== 'Add' || document.querySelector('#propertiesDialog[open]') || (e.target instanceof Element && e.target.closest('input,textarea,select,[contenteditable="true"]')))
        return;
    e.preventDefault();
    if (sel < 0) {
        msg = 'Select a feature or one of its vertices first.';
        render();
        return;
    }
    const feature = site.features[sel];
    if (!feature) return;
    if (vertexSel >= 0 && !isPoint(feature)) {
        const minimum = isArea(feature) ? 3 : 2;
        if (feature.p.length <= minimum) {
            msg = 'Keep at least ' + minimum + ' vertices, or select the feature itself to remove it.';
            render();
            return;
        }
        checkpoint();
        feature.p.splice(vertexSel, 1);
        vertexSel = -1;
        feature.source = 'Edited';
        commit();
        return;
    }
    checkpoint();
    site.features.splice(sel, 1);
    sel = -1;
    vertexSel = -1;
    commit();
});
svg.addEventListener('wheel',e=>{
    e.preventDefault();const factor=Math.exp(-Math.sign(e.deltaY)*.13), next=Math.min(7,Math.max(.4,zoom*factor));
    const r=svg.getBoundingClientRect(),ratio=next/zoom;
    offset[0]+=(e.clientX-r.left-cx)*(1-ratio);offset[1]+=(e.clientY-r.top-cy)*(1-ratio);zoom=next;draw();
},{passive:false});
window.addEventListener('resize', draw);
refresh();
