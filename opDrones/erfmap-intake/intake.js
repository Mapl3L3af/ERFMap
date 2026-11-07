'use strict';
// Video intake page: upload, live stage timeline, per-stage previews, marker
// confirmation, feature review and export. Model output stays a proposal until
// the reviewer accepts it here.
const S = intakeShared;
const app = document.getElementById('app');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const params = new URLSearchParams(location.search);
const STATUS = {queued: 'Queued', processing: 'Processing', complete: 'Complete', needs_review: 'Needs review', failed: 'Failed', unavailable: 'Unavailable', blocked: 'Waiting'};
let job = null, labels = [], selected = null, results = {}, shown = {}, viewer = null, view = {};

async function api(path, options = {}) {
    const response = await fetch(path, options);
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
    if (!response.ok) throw Error(data?.error || response.statusText);
    return data;
}
const fileUrl = rel => '/api/intake/jobs/' + job.id + '/files/' + rel.split('/').map(encodeURIComponent).join('/');
const chip = status => '<span class="chip s-' + status + '">' + (STATUS[status] || status) + '</span>';
const flags = (list, bad = []) => (list || []).map(f => '<span class="flag ' + (bad.some(b => f.includes(b)) ? 'bad' : '') + '">' + esc(f) + '</span>').join('');
const label = kind => labels.find(l => l.kind === kind) || {label: kind || 'Unlabelled', color: '#bcb6c4', geometry: 'area'};
const pts = p => p.map(q => q.map(v => +v.toFixed(2)).join(',')).join(' ');
const pct = v => v == null ? '—' : Math.round(v * 100) + '%';

// ---------------------------------------------------------------- home
async function home() {
    document.getElementById('newJob').hidden = true;
    app.innerHTML = '<div class="home"><section class="card"><small class="cap">Step 1 · Video intake</small><h2>Upload drone video</h2>'
        + '<p>Fly a steady, mostly straight-down pass with plenty of overlap. Place several high-contrast <b>1 ft × 1 ft</b> square boards around the site before flying; the outer edge of each board is the 1 ft square. GPS is not needed and not used.</p>'
        + '<div class="drop" id="drop"><p><b>Drop a video here</b> or</p><label class="button primary">Choose video<input type="file" id="video" accept="video/*,.mp4,.mov,.mkv,.avi,.webm,.mts" hidden></label><p class="cap" id="uploadName"></p><div class="bar" id="uploadBar" hidden><i style="width:0"></i></div></div>'
        + '<p id="uploadStatus" role="status"></p>'
        + '<div class="note warn">The result is a <b>locally scaled, unreferenced</b> map: metres from an arbitrary origin, with no north and no world coordinates. Perspective, terrain, camera tilt and blur can still distort it. It is not survey-grade.</div></section>'
        + '<section class="card"><small class="cap">Processing worker</small><h2>What can run here</h2><div id="caps"><p>Checking the worker…</p></div><h3>Recent intake jobs</h3><ul class="jobs" id="jobs"><li>Loading…</li></ul></section></div>';
    const input = document.getElementById('video'), drop = document.getElementById('drop');
    input.onchange = () => input.files[0] && upload(input.files[0]);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); };
    api('/api/intake/capabilities').then(renderCaps).catch(e => document.getElementById('caps').innerHTML = '<p class="no">' + esc(e.message) + '</p>');
    api('/api/intake/jobs').then(list => {
        document.getElementById('jobs').innerHTML = list.length ? list.map(j => {
            const states = Object.values(j.stages);
            const status = states.includes('processing') ? 'processing' : states.includes('failed') ? 'failed' : j.stages.review === 'complete' ? 'complete' : states.includes('needs_review') ? 'needs_review' : 'queued';
            return '<li>' + chip(status) + '<a href="?job=' + j.id + '">' + esc(j.name) + '</a><span class="cap">' + new Date(j.createdAt).toLocaleString() + '</span></li>';
        }).join('') : '<li>No intake jobs yet.</li>';
    });
}
function renderCaps(c) {
    const row = (name, ok, text, optional) => '<li><b>' + name + '</b><span class="' + (ok ? 'ok' : optional ? 'opt' : 'no') + '">' + (ok ? '✓ ' : optional ? '○ ' : '✗ ') + esc(text) + '</span></li>';
    if (!c.python) {
        document.getElementById('caps').innerHTML = '<div class="note err">' + esc(c.error) + '</div><p>Uploads are still kept, but no stage can run until the worker is set up. See <code>worker/README.md</code>.</p>';
        return;
    }
    document.getElementById('caps').innerHTML = '<ul class="caps">'
        + row('Python', true, c.python + ' (' + c.command + ')')
        + row('FFmpeg', c.ffmpeg && c.ffprobe, c.ffmpeg && c.ffprobe ? 'metadata and frame extraction (' + c.ffmpeg_path + ')'
            : (c.ffmpeg ? 'ffprobe' : c.ffprobe ? 'ffmpeg' : 'ffmpeg and ffprobe') + ' not found. Install FFmpeg, or set ERFMAP_FFMPEG to its bin folder and restart the server.')
        + row('OpenCV', Boolean(c.opencv), c.opencv ? c.opencv + ': cleanup, alignment, markers, regions' : 'missing: pip install -r worker/requirements.txt')
        + row('Segmenter', Boolean(c.segmenter), c.segmenter ? c.segmenter : 'not configured; colour-clustering baseline is used', true)
        + row('Classifier', Boolean(c.classifier), c.classifier ? c.classifier : 'not configured; regions stay unlabelled for manual review', true)
        + row('Elevation', false, 'no elevation model connected; exports are flat and contours are unavailable', true)
        + '</ul>';
}
function upload(file) {
    document.getElementById('uploadName').textContent = file.name + ' · ' + (file.size / 1048576).toFixed(1) + ' MB';
    const bar = document.getElementById('uploadBar'), status = document.getElementById('uploadStatus');
    bar.hidden = false;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/intake/jobs?name=' + encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = e => { if (e.lengthComputable) bar.firstElementChild.style.width = (100 * e.loaded / e.total) + '%'; status.textContent = 'Uploading… the original file is kept unchanged.'; };
    xhr.onload = () => {
        let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status >= 300) { status.textContent = data.error || 'Upload failed.'; return; }
        location.assign('?job=' + data.id);
    };
    xhr.onerror = () => { status.textContent = 'Upload failed. Is the erfMap server still running?'; };
    xhr.send(file);
}

// ---------------------------------------------------------------- job page
async function openJob(id) {
    document.getElementById('newJob').hidden = false;
    labels = (await api('/api/intake/labels')).labels;
    app.innerHTML = '<div class="layout"><aside><ol class="stages" id="stages"></ol><section class="card" style="margin-top:12px" id="original"></section></aside><section class="card" id="panel"><p>Loading…</p></section></div>';
    const events = new EventSource('/api/intake/jobs/' + id + '/events');
    events.addEventListener('job', e => update(JSON.parse(e.data)));
    events.onerror = () => { if (!job) app.innerHTML = '<div class="note err">That intake job could not be opened.</div>'; };
}
function update(next) {
    const first = !job;
    job = next;
    document.getElementById('jobName').textContent = job.name;
    document.title = 'erfMap · ' + job.name;
    if (first) {
        const order = S.STAGES.map(s => s.id);
        selected = params.get('stage') && order.includes(params.get('stage')) ? params.get('stage')
            : order.find(s => ['processing', 'failed', 'needs_review'].includes(job.stages[s].status) && s !== 'review') || order.find(s => job.stages[s].status === 'needs_review') || order[0];
        document.getElementById('original').innerHTML = '<small class="cap">Original video (kept unchanged)</small><p>' + esc(job.original.name) + '<br><span class="cap">' + (job.original.size / 1048576).toFixed(1) + ' MB · uploaded ' + new Date(job.createdAt).toLocaleString() + '</span></p><a class="button" href="' + fileUrl(job.original.path) + '" download>Download original</a>';
    }
    renderStages();
    const state = job.stages[selected];
    const key = [state.status, state.attempts, state.finishedAt, selected === 'review' ? job.imports?.length : ''].join('|');
    if (shown[selected] !== key) { shown[selected] = key; delete results[selected]; renderPanel(); }
    else if (state.status === 'processing') renderHead();
}
function renderStages() {
    document.getElementById('stages').innerHTML = S.STAGES.map(s => {
        const st = job.stages[s.id];
        return '<li><button type="button" data-stage="' + s.id + '" aria-current="' + (s.id === selected) + '"><span class="num">' + (s.step || (s.id === 'markers' ? '⌗' : '▶')) + '</span><span class="name">' + s.title + '</span>' + chip(st.status)
            + (st.status === 'processing' ? '<div class="bar"><i style="width:' + Math.round(100 * (st.progress || 0)) + '%"></i></div>' : '')
            + '<span class="sum">' + esc(st.status === 'processing' ? st.message : st.error || st.summary || '') + '</span></button></li>';
    }).join('');
}
document.addEventListener('click', e => {
    const b = e.target.closest('[data-stage]');
    if (b && job) { selected = b.dataset.stage; history.replaceState(null, '', '?job=' + job.id + '&stage=' + selected); renderStages(); shown[selected] = null; update(job); }
});

function guidance(stage) {
    return {
        classification: 'To connect a trained model, set <code>ERFMAP_CLASSIFIER</code> to a command that reads regions as JSON and prints labels with confidences (see <code>worker/README.md</code>). Without one, every region is a proposal with no label; you choose labels in Review.',
        regions: 'Set <code>ERFMAP_SEGMENTER</code> to connect a learned segmenter such as SAM 2.',
        probe: 'Install FFmpeg so <code>ffprobe</code> is on PATH, or set <code>ERFMAP_FFPROBE</code>.',
        frames: 'Install FFmpeg and the worker requirements (<code>pip install -r worker/requirements.txt</code>).',
    }[stage] || 'Install the worker requirements (<code>pip install -r worker/requirements.txt</code>), then retry.';
}
function headMarkup() {
    const meta = S.STAGES.find(s => s.id === selected), st = job.stages[selected];
    let h = '<div class="panelhead"><div><small class="cap">' + (meta.step ? 'Stage ' + meta.step + ' of 7' : meta.id === 'markers' ? 'Scale calibration' : 'Intake') + '</small><h2>' + meta.title + ' ' + chip(st.status) + '</h2><p>' + esc(st.summary || (st.status === 'blocked' ? 'Waiting for an earlier stage.' : st.status === 'queued' ? 'Queued.' : '')) + '</p></div>';
    if (meta.worker && ['failed', 'unavailable'].includes(st.status)) h += '<button type="button" class="primary" data-retry="' + selected + '">Retry this stage</button>';
    else if (meta.worker && ['complete', 'needs_review'].includes(st.status)) h += '<button type="button" data-retry="' + selected + '" title="Earlier stages are kept. This stage and the ones after it run again.">Run again from here</button>';
    h += '</div>';
    if (st.status === 'processing') h += '<div class="bar"><i style="width:' + Math.round(100 * (st.progress || 0)) + '%"></i></div><p class="cap">' + esc(st.message || '') + '</p>';
    if (st.status === 'failed') h += '<div class="note err"><b>This stage failed.</b> ' + esc(st.error) + (st.log ? '<details><summary>Worker log</summary><pre>' + esc(st.log) + '</pre></details>' : '') + '<p>Earlier stages are kept; retrying runs this stage and the ones after it.</p></div>';
    if (st.status === 'unavailable') h += '<div class="note off"><b>Unavailable in this setup.</b> ' + esc(st.reason || st.summary) + '<p>' + guidance(selected) + '</p></div>';
    for (const w of st.warnings || []) h += '<div class="note warn">' + esc(w) + '</div>';
    if (st.attempts > 1) h += '<p class="cap">Attempt ' + st.attempts + (st.finishedAt ? ' · finished ' + new Date(st.finishedAt).toLocaleTimeString() : '') + '</p>';
    return h;
}
function renderHead() { const head = document.getElementById('head'); if (head) head.innerHTML = headMarkup(); }
async function renderPanel() {
    const panel = document.getElementById('panel'), st = job.stages[selected];
    viewer = null; view = {};
    panel.innerHTML = '<div id="head">' + headMarkup() + '</div><div id="body"></div>';
    const ready = ['complete', 'needs_review', 'unavailable'].includes(st.status);
    if (!ready && !(selected === 'review' && st.status !== 'blocked')) return;
    try {
        const data = results[selected] || await api('/api/intake/jobs/' + job.id + '/stages/' + selected);
        results[selected] = data;
        const body = document.getElementById('body');
        if (!body) return;
        await ({probe: viewProbe, frames: viewFrames, correction: viewCorrection, markers: viewMarkers, regions: viewRegions, classification: viewClassification, merging: viewMerging, geometry: viewGeometry, review: viewReview}[selected])(body, data);
    } catch (e) {
        document.getElementById('body').innerHTML = '<div class="note err">' + esc(e.message) + '</div>';
    }
}
document.addEventListener('click', async e => {
    const b = e.target.closest('[data-retry]');
    if (!b) return;
    b.disabled = true;
    try { await api('/api/intake/jobs/' + job.id + '/stages/' + b.dataset.retry + '/retry', {method: 'POST'}); }
    catch (err) { alert(err.message); b.disabled = false; }
});
const say = (text, html) => { const el = document.getElementById('rstatus'); if (el) el.innerHTML = html ? text : esc(text); };
const stageData = async id => results[id] || (results[id] = await api('/api/intake/jobs/' + job.id + '/stages/' + id));

// ---------------------------------------------------------------- stage views
function viewProbe(body, data) {
    const m = data.metadata || {};
    const rows = [['Container', m.container], ['Duration', m.duration_s?.toFixed(2) + ' s'], ['Resolution', m.width + ' × ' + m.height], ['Frame rate', m.fps?.toFixed(3) + ' fps'], ['Frames', m.frame_count], ['Codec', m.codec], ['Pixel format', m.pixel_format], ['Rotation', m.rotation ?? 'none'], ['Recorded', m.creation_time || 'not recorded'], ['Telemetry streams', (m.data_streams || []).join(', ') || 'none']];
    body.innerHTML = '<div class="split"><div><video controls preload="metadata" style="width:100%;border-radius:8px;background:#000" src="' + fileUrl(job.original.path) + '"></video><p class="cap">Browsers cannot play every drone codec; the original file is kept either way.</p></div><div><h3>Video</h3><table class="kv">' + rows.map(([k, v]) => '<tr><td>' + k + '</td><td>' + esc(v ?? '—') + '</td></tr>').join('') + '</table>'
        + '<h3>Camera tags</h3><table class="kv">' + (Object.entries(m.camera_tags || {}).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + esc(v) + '</td></tr>').join('') || '<tr><td colspan=2>None in this file.</td></tr>') + '</table>'
        + '<details><summary>All container tags</summary><pre>' + esc(JSON.stringify(m.all_tags, null, 1)) + '</pre></details></div></div>';
}

function viewFrames(body, data) {
    let filter = 'all', current = data.frames.find(f => !f.usable) || data.frames[0];
    const draw = () => {
        const list = data.frames.filter(f => filter === 'all' || (filter === 'usable') === f.usable);
        const m = current.metrics;
        body.innerHTML = '<p>Frames sampled at ' + data.sample_fps.toFixed(2) + ' per second. Blur limit: sharpness below ' + data.blur_limit + '. Flagged frames are left out of later stages.</p>'
            + '<div class="split"><figure style="margin:0"><img style="width:100%;border-radius:8px" src="' + fileUrl(current.image) + '" alt="Frame ' + current.id + '"><figcaption>' + current.id + ' · ' + current.time_s + ' s</figcaption></figure>'
            + '<div><h3>' + current.id + ' ' + (current.usable ? '<span class="flag good">usable</span>' : flags(current.flags, [''])) + '</h3><table class="kv"><tr><td>Sharpness</td><td>' + m.sharpness + '</td></tr><tr><td>Brightness</td><td>' + m.brightness + '</td></tr><tr><td>Contrast</td><td>' + m.contrast + '</td></tr><tr><td>Edge texture</td><td>' + m.texture + '</td></tr><tr><td>Sky band (tilt)</td><td>' + (m.sky_band ? 'yes' : 'no') + '</td></tr></table></div></div>'
            + '<div class="row" style="margin:12px 0">' + ['all', 'usable', 'flagged'].map(f => '<button type="button" data-filter="' + f + '" class="' + (f === filter ? 'primary' : '') + '">' + f[0].toUpperCase() + f.slice(1) + ' (' + data.frames.filter(x => f === 'all' || (f === 'usable') === x.usable).length + ')</button>').join('') + '</div>'
            + '<div class="grid">' + list.map(f => '<button type="button" class="thumb ' + (f.usable ? '' : 'bad') + '" data-frame="' + f.id + '" aria-pressed="' + (f === current) + '"><img loading="lazy" src="' + fileUrl(f.image) + '" alt=""><div>' + f.id + ' · ' + f.time_s + ' s<br>' + (f.usable ? '<span class="flag good">usable</span>' : flags(f.flags, [''])) + '</div></button>').join('') + '</div>';
    };
    body.onclick = e => {
        const f = e.target.closest('[data-filter]'), t = e.target.closest('[data-frame]');
        if (f) filter = f.dataset.filter;
        if (t) current = data.frames.find(x => x.id === t.dataset.frame);
        if (f || t) draw();
    };
    draw();
}

function viewCorrection(body, data) {
    let current = data.frames[0];
    const okLinks = data.links.filter(l => l.ok).length;
    body.innerHTML = '<table class="kv"><tr><td>Cleanup</td><td>' + esc(data.cleanup) + ' <span class="flag good">applied</span></td></tr><tr><td>Lens correction</td><td>' + esc(data.lens.reason) + ' <span class="flag ' + (data.lens.status === 'applied' ? 'good' : 'bad') + '">' + data.lens.status + '</span></td></tr><tr><td>Alignment</td><td>' + okLinks + ' of ' + data.links.length + ' frame pairs matched (ORB features + RANSAC homography); reference frame ' + data.reference + '</td></tr></table>'
        + '<h3>Before and after cleanup</h3><div class="row" id="strip" style="overflow-x:auto;flex-wrap:nowrap;padding-bottom:6px">' + data.frames.map(f => '<button type="button" class="thumb" style="flex:0 0 110px" data-cframe="' + f.id + '"><img loading="lazy" src="' + fileUrl(f.after) + '" alt=""><div>' + f.id + (f.to_mosaic ? '' : ' <span class="flag bad">unaligned</span>') + '</div></button>').join('') + '</div><div class="compare" id="compare"></div>'
        + '<h3>Alignment preview</h3><p>Aligned frames stitched onto the reference frame with planar homographies. This is a preview for checking overlap, not an orthomosaic.</p><div id="mosaic"></div>'
        + '<details><summary>Frame-pair matches</summary><table><tr><th>From</th><th>To</th><th>Inliers</th><th></th></tr>' + data.links.map(l => '<tr><td>' + l.from + '</td><td>' + l.to + '</td><td>' + l.inliers + '</td><td>' + (l.ok ? '<span class="flag good">aligned</span>' : '<span class="flag bad">weak match</span>') + '</td></tr>').join('') + '</table></details>';
    const compare = () => {
        document.getElementById('compare').innerHTML = '<figure><img src="' + fileUrl(current.before) + '" alt="Before"><figcaption>Before · extracted frame ' + current.id + '</figcaption></figure><figure><img src="' + fileUrl(current.after) + '" alt="After"><figcaption>After · cleanup' + (data.lens.status === 'applied' ? ' and lens correction' : ' (lens correction unavailable)') + '</figcaption></figure>';
        document.querySelectorAll('[data-cframe]').forEach(b => b.setAttribute('aria-pressed', b.dataset.cframe === current.id));
    };
    document.getElementById('strip').onclick = e => { const b = e.target.closest('[data-cframe]'); if (b) { current = data.frames.find(f => f.id === b.dataset.cframe); compare(); } };
    compare();
    createViewer(document.getElementById('mosaic'), {image: fileUrl(data.mosaic.image), width: data.mosaic.width, height: data.mosaic.height, hint: 'Scroll to zoom, drag to pan'});
}

// ---- scale calibration
function markerScale(m) {
    const c = m.corners, side = [0, 1, 2, 3].reduce((s, i) => s + Math.hypot(c[i][0] - c[(i + 1) % 4][0], c[i][1] - c[(i + 1) % 4][1]), 0) / 4;
    return 0.3048 / side;
}
async function viewMarkers(body, data) {
    const markers = JSON.parse(JSON.stringify(job.calibration?.markers || []));
    const detected = Object.fromEntries((data.markers || []).map(m => [m.id, m]));
    let active = markers[0]?.id || null, adding = null, dirty = false;
    body.innerHTML = '<div class="note">Each confirmed 1 ft board sets the scale <b>near that board only</b>. Several boards spread across the site let erfMap use a median scale and show when boards disagree, which points to tilt, terrain relief or poor alignment. Results stay <b>locally scaled, unreferenced</b>.</div>'
        + '<div class="split"><div id="mviewer"></div><div><div class="row"><button type="button" id="addMarker">Add marker by hand</button><button type="button" class="primary" id="saveMarkers">Save calibration</button></div><p id="mstatus" class="cap"></p><div class="list" id="mlist"></div><div id="mscale"></div></div></div>';
    const v = viewer = createViewer(document.getElementById('mviewer'), {image: fileUrl(data.mosaic.image), width: data.mosaic.width, height: data.mosaic.height, hint: 'Select a marker, then drag its corners to correct them'});
    const draw = () => {
        const k = v.scale;
        let s = '';
        for (const m of markers) {
            const colour = m.confirmed ? '#8ec26a' : m.flags?.length ? '#e0705f' : '#e8b04f';
            s += '<polygon points="' + pts(m.corners) + '" fill="' + colour + '" fill-opacity=".18" stroke="' + colour + '" stroke-width="' + (m.id === active ? 2.5 : 1.5) + '" vector-effect="non-scaling-stroke" data-marker="' + m.id + '"/>';
            const c = m.corners.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
            s += '<text x="' + c[0] + '" y="' + (Math.min(...m.corners.map(p => p[1])) - 6 * k) + '" font-size="' + 12 * k + '" text-anchor="middle" fill="#fff" stroke="#000" stroke-width="' + 3 * k + '" paint-order="stroke">' + m.id + '</text>';
            if (m.id === active) m.corners.forEach((p, i) => s += '<circle data-handle="' + m.id + ':' + i + '" cx="' + p[0] + '" cy="' + p[1] + '" r="' + 5 * k + '" fill="#fff" stroke="#155d76" stroke-width="2" vector-effect="non-scaling-stroke" style="cursor:move"/>');
        }
        if (adding) adding.forEach(p => s += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + 4 * k + '" fill="#c2e69e"/>');
        v.draw(s);
    };
    v.redraw = draw;
    const list = () => {
        document.getElementById('mlist').innerHTML = markers.length ? markers.map(m => {
            const d = detected[m.id];
            return '<div data-pick="' + m.id + '" aria-selected="' + (m.id === active) + '"><b>' + m.id + '</b> ' + (m.confirmed ? '<span class="flag good">confirmed</span>' : '<span class="flag">unconfirmed</span>') + (m.manual ? ' <span class="flag">placed by hand</span>' : '')
                + '<br><span class="cap">' + (d ? d.frames.length + ' frames · ' + d.side_px_frame + ' px side in frame' : 'manual') + ' · ' + (markerScale(m) * 100).toFixed(2) + ' cm/px</span><br>' + flags(m.flags, ['blurry', 'small', 'few', 'obscured'])
                + '<div class="row" style="margin-top:6px"><button type="button" data-confirm="' + m.id + '">' + (m.confirmed ? 'Unconfirm' : 'Confirm corners') + '</button>' + (m.manual ? '<button type="button" data-remove="' + m.id + '">Remove</button>' : '') + '</div></div>';
        }).join('') : '<div>No markers yet. Use “Add marker by hand” and click the four corners of a board.</div>';
        const confirmed = markers.filter(m => m.confirmed).map(markerScale).sort((a, b) => a - b);
        const median = confirmed.length ? confirmed[Math.floor(confirmed.length / 2)] : null;
        const spread = confirmed.length > 1 ? Math.sqrt(confirmed.reduce((s, v) => s + (v - median) ** 2, 0) / confirmed.length) / median : null;
        document.getElementById('mscale').innerHTML = '<h3>Scale</h3>' + (median ? '<p>' + (median * 100).toFixed(3) + ' cm per preview pixel, from ' + confirmed.length + ' confirmed marker' + (confirmed.length > 1 ? 's' : '') + '.</p>' + (spread == null ? '<div class="note warn">One marker: scale is only reliable near it.</div>' : '<p>Markers disagree by ' + (spread * 100).toFixed(1) + '%.' + (spread > .1 ? '</p><div class="note warn">Over 10%: check for tilt, relief or misaligned frames.</div>' : '</p>')) : '<p>No confirmed markers. Map geometry waits until at least one is confirmed.</p>');
        document.getElementById('mstatus').textContent = adding ? 'Click corner ' + (adding.length + 1) + ' of 4 on the preview.' : dirty ? 'Unsaved changes. Saving reruns Map geometry only.' : '';
        draw();
    };
    const focus = id => { const m = markers.find(x => x.id === id); if (!m) return; const xs = m.corners.map(p => p[0]), ys = m.corners.map(p => p[1]); v.focus(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 6); };
    v.onDrag = (handle, p) => { const [id, i] = handle.split(':'); const m = markers.find(x => x.id === id); m.corners[+i] = p; m.confirmed = true; dirty = true; draw(); };
    v.onDragEnd = () => list();
    v.onClick = (p, target) => {
        if (adding) {
            adding.push(p);
            if (adding.length === 4) {
                let n = 1; while (markers.some(m => m.id === 'H' + n)) n++;
                const c = adding.reduce((a, q) => [a[0] + q[0] / 4, a[1] + q[1] / 4], [0, 0]);
                const corners = [...adding].sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
                markers.push({id: 'H' + n, corners, confirmed: true, manual: true, flags: []});
                active = 'H' + n; adding = null; dirty = true;
            }
            list(); return;
        }
        const hit = target.closest?.('[data-marker]');
        if (hit) { active = hit.dataset.marker; list(); }
    };
    body.querySelector('.list').onclick = e => {
        const c = e.target.closest('[data-confirm]'), r = e.target.closest('[data-remove]'), p = e.target.closest('[data-pick]');
        if (c) { const m = markers.find(x => x.id === c.dataset.confirm); m.confirmed = !m.confirmed; dirty = true; }
        else if (r) { markers.splice(markers.findIndex(x => x.id === r.dataset.remove), 1); dirty = true; }
        else if (p) { active = p.dataset.pick; focus(active); }
        list();
    };
    document.getElementById('addMarker').onclick = () => { adding = []; list(); };
    document.getElementById('saveMarkers').onclick = async () => {
        const note = text => { const el = document.getElementById('mstatus'); if (el) el.textContent = text; };
        try { await api('/api/intake/jobs/' + job.id + '/calibration', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({markers})}); dirty = false; note('Saved. Map geometry is being rebuilt.'); }
        catch (e) { note(e.message); }
    };
    list();
}

// ---- regions and classification (per keyframe)
async function keyframeView(body, regions, predictions, intro) {
    const byFrame = id => regions.regions.filter(r => r.frame === id);
    let frame = regions.keyframes[0];
    const preds = Object.fromEntries((predictions || []).map(p => [p.id, p]));
    body.innerHTML = intro + '<div class="row"><label>Keyframe <select id="kf">' + regions.keyframes.map(k => '<option value="' + k.id + '">' + k.id + ' (' + byFrame(k.id).length + ' regions)</option>').join('') + '</select></label></div><div id="kviewer" style="margin-top:10px"></div><div class="legend" id="klegend"></div>';
    const v = viewer = createViewer(document.getElementById('kviewer'), {image: fileUrl(frame.image), width: frame.width, height: frame.height, hint: 'Source frame under candidate regions'});
    const draw = () => {
        const k = v.scale, used = new Set();
        let s = '';
        for (const r of byFrame(frame.id)) {
            const p = preds[r.id];
            if (!predictions) { s += '<polygon points="' + pts(r.polygon) + '" fill="#ffffff" fill-opacity=".12" stroke="#ffffff" stroke-width="1.5" vector-effect="non-scaling-stroke"><title>' + r.id + '</title></polygon>'; continue; }
            const l = label(p?.kind); used.add(p?.kind || '');
            s += '<polygon points="' + pts(r.polygon) + '" fill="' + l.color + '" fill-opacity=".38" stroke="' + (p?.needs_review ? '#e0705f' : l.color) + '" stroke-width="2" ' + (p?.needs_review ? 'stroke-dasharray="6 4" ' : '') + 'vector-effect="non-scaling-stroke"><title>' + r.id + ' · ' + esc(l.label) + (p?.confidence != null ? ' · ' + pct(p.confidence) : '') + '</title></polygon>';
            const c = S.centroid(r.polygon);
            s += '<text x="' + c[0] + '" y="' + c[1] + '" font-size="' + 11 * k + '" text-anchor="middle" fill="#fff" stroke="#000" stroke-width="' + 3 * k + '" paint-order="stroke">' + esc(p?.kind ? l.label + ' ' + pct(p.confidence) : '?') + '</text>';
        }
        v.draw(s);
        if (predictions && document.getElementById('klegend')) document.getElementById('klegend').innerHTML = [...used].map(kd => '<span><i style="background:' + label(kd || null).color + '"></i>' + esc(kd ? label(kd).label : 'Unlabelled') + '</span>').join('') + '<span><i style="border:2px dashed #e0705f"></i>needs review (confidence below ' + pct(results.classification?.uncertain_below) + ' or no label)</span>';
    };
    v.redraw = draw;
    document.getElementById('kf').onchange = e => { frame = regions.keyframes.find(k => k.id === e.target.value); v.setImage(fileUrl(frame.image), frame.width, frame.height); v.fit(); };
}
function viewRegions(body, data) {
    return keyframeView(body, data, null, '<p>Method: <b>' + esc(data.method) + '</b>. Regions are outlined only; no labels are assigned at this stage.</p>');
}
async function viewClassification(body, data) {
    const regions = await stageData('regions');
    const model = data.model ? 'Model: <b>' + esc(data.model.name || 'unnamed') + '</b> ' + esc(data.model.version || '') + (data.model.heuristic ? ' <span class="flag bad">heuristic, not trained</span>' : '') : 'No classifier ran. Regions are shown as unlabelled proposals.';
    return keyframeView(body, regions, data.predictions, '<p>' + model + ' Colours follow erfMap feature kinds; predictions are proposals until accepted in Review.</p>');
}

// ---- merging
async function viewMerging(body, data) {
    let active = null;
    body.innerHTML = '<p>Regions from overlapping keyframes are projected onto the alignment preview and matched by overlap (IoU over 0.3). The merged outline keeps pixels that most matching detections agree on.</p><div class="split"><div id="gviewer"></div><div class="list" id="glist"></div></div>';
    const v = viewer = createViewer(document.getElementById('gviewer'), {image: fileUrl(data.mosaic.image), width: data.mosaic.width, height: data.mosaic.height, hint: 'Select a merged feature to see the detections behind it'});
    const conflict = g => g.flags.some(f => f.startsWith('conflicting') || f.startsWith('geometry'));
    const draw = () => {
        let s = '';
        for (const g of data.merged) {
            const l = label(g.kind), on = g.id === active;
            s += '<polygon data-g="' + g.id + '" points="' + pts(g.polygon) + '" fill="' + l.color + '" fill-opacity="' + (on ? .45 : .25) + '" stroke="' + (conflict(g) ? '#e0705f' : l.color) + '" stroke-width="' + (on ? 3 : 1.5) + '" vector-effect="non-scaling-stroke"><title>' + g.id + '</title></polygon>';
        }
        const g = data.merged.find(x => x.id === active);
        if (g) g.member_polygons.forEach((m, i) => s += '<polygon points="' + pts(m.polygon) + '" fill="none" stroke="hsl(' + (i * 67 % 360) + ' 80% 70%)" stroke-width="1.2" stroke-dasharray="5 3" vector-effect="non-scaling-stroke"><title>' + m.region + ' from ' + m.frame + '</title></polygon>');
        v.draw(s);
    };
    v.redraw = draw;
    const list = () => {
        document.getElementById('glist').innerHTML = data.merged.map(g => '<div data-pick="' + g.id + '" aria-selected="' + (g.id === active) + '"><b>' + g.id + '</b> ' + esc(label(g.kind).label) + (g.confidence != null ? ' · ' + pct(g.confidence) : '') + '<br><span class="cap">' + g.members.length + ' detections · ' + g.frames.length + ' frames' + (g.mean_iou != null ? ' · mean IoU ' + g.mean_iou : '') + '</span><br>' + flags(g.flags, ['conflicting', 'geometry'])).join('');
        draw();
    };
    document.getElementById('glist').onclick = e => { const p = e.target.closest('[data-pick]'); if (!p) return; active = p.dataset.pick; const g = data.merged.find(x => x.id === active); const xs = g.polygon.map(q => q[0]), ys = g.polygon.map(q => q[1]); v.focus(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 2); list(); };
    v.onClick = (p, target) => { const hit = target.closest?.('[data-g]'); if (hit) { active = hit.dataset.g; list(); } };
    list();
}

// ---- geometry and review share a map that can sit on the imagery or on a plain survey grid
function mapView(host, geometry, getFeatures, options = {}) {
    const sc = geometry.scale, toPx = p => [p[0] / sc.m_per_px + sc.origin_px[0], p[1] / sc.m_per_px + sc.origin_px[1]], toM = q => [(q[0] - sc.origin_px[0]) * sc.m_per_px, (q[1] - sc.origin_px[1]) * sc.m_per_px];
    host.innerHTML = '<div class="row"><button type="button" data-mode="imagery" class="primary">Over source imagery</button><button type="button" data-mode="map">Survey map</button><span class="cap">Metres from an arbitrary origin · north unknown</span></div><div class="mapv" style="margin-top:8px"></div>';
    const v = createViewer(host.querySelector('.mapv'), {image: fileUrl(geometry.mosaic.image), width: geometry.mosaic.width, height: geometry.mosaic.height, hint: options.hint || 'Proposed features. Nothing is accepted until reviewed.'});
    let mode = 'imagery';
    host.querySelector('.row').onclick = e => {
        const b = e.target.closest('[data-mode]'); if (!b) return;
        mode = b.dataset.mode; host.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('primary', x === b));
        v.setImage(mode === 'imagery' ? fileUrl(geometry.mosaic.image) : null, geometry.mosaic.width, geometry.mosaic.height); v.redraw();
    };
    v.redraw = () => {
        const k = v.scale;
        let s = '';
        if (mode === 'map') {
            const [w, h] = geometry.extent_m, step = w > 200 ? 20 : w > 60 ? 10 : 5;
            const a = toPx([0, 0]), b = toPx([w, h]);
            s += '<rect x="' + a[0] + '" y="' + a[1] + '" width="' + (b[0] - a[0]) + '" height="' + (b[1] - a[1]) + '" fill="#f6f8f8"/>';
            for (let x = 0; x <= w; x += step) { const p = toPx([x, 0]), q = toPx([x, h]); s += '<line x1="' + p[0] + '" y1="' + p[1] + '" x2="' + q[0] + '" y2="' + q[1] + '" stroke="#ccd5d8" vector-effect="non-scaling-stroke"/>'; }
            for (let y = 0; y <= h; y += step) { const p = toPx([0, y]), q = toPx([w, y]); s += '<line x1="' + p[0] + '" y1="' + p[1] + '" x2="' + q[0] + '" y2="' + q[1] + '" stroke="#ccd5d8" vector-effect="non-scaling-stroke"/>'; }
            s += '<text x="' + a[0] + '" y="' + (a[1] - 6 * k) + '" font-size="' + 11 * k + '" fill="#ddd">Grid ' + step + ' m</text>';
        }
        for (const f of getFeatures()) {
            const l = label(f.kind), p = f.p.map(toPx), on = f.id === options.active?.();
            const stroke = f.status === 'rejected' ? '#777' : f.status === 'accepted' ? l.color : '#e8b04f';
            const dash = f.status === 'accepted' ? '' : 'stroke-dasharray="6 4"';
            const opacity = f.status === 'rejected' ? .08 : .35;
            if (f.geometry === 'area') s += '<polygon data-f="' + f.id + '" points="' + pts(p) + '" fill="' + l.color + '" fill-opacity="' + opacity + '" stroke="' + stroke + '" stroke-width="' + (on ? 3 : 1.6) + '" ' + dash + ' vector-effect="non-scaling-stroke"/>';
            else if (f.geometry === 'line') s += '<polyline data-f="' + f.id + '" points="' + pts(p) + '" fill="none" stroke="' + l.color + '" stroke-opacity=".75" stroke-width="' + Math.max(2 * k, (f.width || .5) / sc.m_per_px) + '" stroke-linecap="round"/><polyline points="' + pts(p) + '" fill="none" stroke="' + stroke + '" stroke-width="' + (on ? 3 : 1.5) + '" ' + dash + ' vector-effect="non-scaling-stroke" pointer-events="none"/>';
            else s += '<circle data-f="' + f.id + '" cx="' + p[0][0] + '" cy="' + p[0][1] + '" r="' + 7 * k + '" fill="' + l.color + '" stroke="' + stroke + '" stroke-width="' + (on ? 3 : 2) + '" vector-effect="non-scaling-stroke"/>';
            const c = f.geometry === 'area' ? S.centroid(p) : p[Math.floor(p.length / 2)];
            s += '<text x="' + c[0] + '" y="' + (c[1] - (f.geometry === 'point' ? 10 * k : 0)) + '" font-size="' + 11 * k + '" text-anchor="middle" fill="#fff" stroke="#000" stroke-width="' + 3 * k + '" paint-order="stroke" pointer-events="none">' + esc(f.id + ' ' + l.label) + '</text>';
            if (on && options.editable) p.forEach((q, i) => s += '<circle data-handle="' + f.id + ':' + i + '" cx="' + q[0] + '" cy="' + q[1] + '" r="' + 5 * k + '" fill="#fff" stroke="#155d76" stroke-width="2" vector-effect="non-scaling-stroke" style="cursor:move"/>');
        }
        v.draw(s);
    };
    v.toPx = toPx; v.toM = toM;
    return v;
}
function viewGeometry(body, data) {
    if (!data.features?.length) {
        body.innerHTML = '<div class="note warn">' + esc(data.summary || 'No geometry yet.') + '</div><button type="button" data-stage="markers">Go to Scale calibration</button>';
        return;
    }
    const sc = data.scale;
    body.innerHTML = '<table class="kv"><tr><td>Scale</td><td>' + (sc.m_per_px * 100).toFixed(3) + ' cm per preview pixel, median of ' + sc.markers + ' confirmed marker(s)' + (sc.spread != null ? '; markers disagree by ' + (sc.spread * 100).toFixed(1) + '%' : '') + '</td></tr><tr><td>Extent</td><td>' + data.extent_m.map(v => v.toFixed(1)).join(' × ') + ' m (local)</td></tr><tr><td>Features</td><td>' + data.features.length + ' proposals: ' + ['area', 'line', 'point'].map(g => data.features.filter(f => f.geometry === g).length + ' ' + g + 's').join(', ') + '</td></tr></table><div id="geomap" style="margin-top:10px"></div>';
    const features = S.reviewedFeatures(data, {}, labels);
    viewer = mapView(document.getElementById('geomap'), data, () => features);
}

// ---- review & export
async function viewReview(body, payload) {
    const geometry = await stageData('geometry');
    if (!geometry.features?.length) { body.innerHTML = '<div class="note warn">Map geometry is not ready. Confirm a marker in Scale calibration first.</div>'; return; }
    let edits = payload.review?.features || {}, active = null;
    const kindOptions = kind => ['area', 'line', 'point'].map(g => '<optgroup label="' + g[0].toUpperCase() + g.slice(1) + 's">' + labels.filter(l => l.geometry === g).map(l => '<option value="' + l.kind + '"' + (l.kind === kind ? ' selected' : '') + '>' + esc(l.label) + ' (' + l.kind + ')</option>').join('') + '</optgroup>').join('');
    const features = () => S.reviewedFeatures(geometry, edits, labels);
    body.innerHTML = '<div class="note warn">Model and pipeline output are proposals. Only features you <b>accept</b> are imported. Dashed amber outlines are pending; solid outlines are accepted.</div><div id="rmap"></div>'
        + '<div class="row" style="margin-top:10px"><button type="button" id="acceptLabelled">Accept all with a model label</button><span class="cap" id="rstatus"></span></div><div class="review-table"><table><thead><tr><th>ID</th><th>Label</th><th>Name</th><th>Height (m)</th><th>Model</th><th>Flags</th><th>Decision</th></tr></thead><tbody id="rows"></tbody></table></div>'
        + '<div class="export"><section class="card" id="exportScenario"></section><section class="card" id="export3d"></section></div>';
    const v = viewer = mapView(document.getElementById('rmap'), geometry, features, {editable: true, active: () => active, hint: 'Select a feature to edit it. Drag white handles to move vertices.'});
    let saving = Promise.resolve();
    const save = (id, edit) => {
        edits = {...edits, [id]: {...edits[id], ...edit}};
        refresh();
        saving = saving.then(() => api('/api/intake/jobs/' + job.id + '/review', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({features: {[id]: edit}})}))
            .then(r => { say('Saved.'); edits = r.review.features; exports(); })
            .catch(e => { say(e.message); });
    };
    const rows = () => {
        document.getElementById('rows').innerHTML = features().map(f => '<tr data-row="' + f.id + '" aria-selected="' + (f.id === active) + '" class="' + f.status + '"><td><b>' + f.id + '</b></td>'
            + '<td><select data-edit="kind" data-id="' + f.id + '">' + kindOptions(f.kind) + '</select>' + (f.predictedKind ? '' : '<span class="cap">no model label</span>') + '</td>'
            + '<td><input data-edit="name" data-id="' + f.id + '" value="' + esc(f.name) + '"></td>'
            + '<td>' + (f.geometry === 'area' ? '<input data-edit="height" data-id="' + f.id + '" type="number" min="0" step="0.1" placeholder="estimate" value="' + (f.height ?? '') + '">' : '<span class="cap">—</span>') + '</td>'
            + '<td>' + (f.predictedKind ? esc(label(f.predictedKind).label) + ' · ' + pct(f.confidence) : '—') + '</td><td>' + flags(f.flags, ['conflict', 'label', 'geometry']) + (f.note ? '<br><span class="cap">' + esc(f.note) + '</span>' : '') + '</td>'
            + '<td><div class="row"><button type="button" data-status="accepted" data-id="' + f.id + '" class="' + (f.status === 'accepted' ? 'primary' : '') + '">Accept</button><button type="button" data-status="rejected" data-id="' + f.id + '"' + (f.status === 'rejected' ? ' style="border-color:#e0705f"' : '') + '>Reject</button></div></td></tr>').join('');
    };
    function refresh() { rows(); v.redraw(); }
    async function exports() {
        if (!document.getElementById('exportScenario')) return;   // panel was re-rendered
        const list = features(), accepted = list.filter(f => f.status === 'accepted');
        const pending = list.filter(f => f.status === 'proposed').length, rejected = list.filter(f => f.status === 'rejected').length;
        document.getElementById('exportScenario').innerHTML = '<small class="cap">Import into erfMap</small><h3>' + accepted.length + ' accepted · ' + pending + ' pending · ' + rejected + ' rejected</h3>'
            + '<p>Accepted features become an erfMap scenario (<code>fieldform-site-v1</code>) in local metres, the format Open Project already reads. GeoJSON is not used because erfMap’s GeoJSON import needs real longitude and latitude, which this video does not have.</p><p class="cap">Each feature keeps its job, source frames, model label, confidence and review status under <code>intake</code>.</p>'
            + '<div class="row"><button type="button" class="primary" id="importNow"' + (accepted.length ? '' : ' disabled') + '>Import into erfMap</button><a class="button" ' + (accepted.length ? 'href="/api/intake/jobs/' + job.id + '/scenario"' : 'aria-disabled="true" style="opacity:.45"') + '>Download scenario JSON</a></div>'
            + (payload.imports?.length ? '<h3>Imported</h3><ul>' + payload.imports.map(i => '<li><a href="/survey/?room=' + i.code + '">Project ' + i.code + '</a> · ' + i.features + ' features · ' + new Date(i.at).toLocaleString() + '</li>').join('') + '</ul>' : '');
        const panel = document.getElementById('export3d');
        if (!panel) return;
        if (!accepted.length) { panel.innerHTML = '<small class="cap">3D model export</small><h3>glTF binary (.glb)</h3><p>Accept features to see exactly what the 3D model will contain.</p>'; return; }
        try {
            const sum = await api('/api/intake/jobs/' + job.id + '/model-summary');
            if (!panel.isConnected) return;
            panel.innerHTML = '<small class="cap">3D model export</small><h3>glTF binary (.glb), metres, ' + esc(sum.label.toLowerCase()) + '</h3>'
                + '<div class="note warn"><b>Elevation: flat at 0 m.</b> ' + esc(sum.elevation.reason) + ' This is not a 3D reconstruction.</div>'
                + '<div class="note off"><b>Contours: unavailable.</b> ' + esc(sum.contours.reason) + '</div>'
                + '<table><tr><th>Feature</th><th>Exported as</th><th>Height</th></tr>' + sum.features.map(f => '<tr><td>' + esc(f.name) + ' <span class="cap">' + f.kind + '</span></td><td>' + esc(f.shape) + '</td><td>' + (f.height ? f.height + ' m <span class="flag">' + esc(f.heightSource) + '</span>' : '—') + '</td></tr>').join('') + '</table>'
                + '<p><a class="button primary" href="/api/intake/jobs/' + job.id + '/model.glb">Download .glb</a></p>';
        } catch (e) { panel.innerHTML = '<div class="note err">' + esc(e.message) + '</div>'; }
    }
    const focusFeature = id => { const f = features().find(x => x.id === id); const p = f.p.map(v.toPx); const xs = p.map(q => q[0]), ys = p.map(q => q[1]); v.focus(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), f.geometry === 'point' ? 20 : 2.5); };
    body.addEventListener('change', e => {
        const el = e.target.closest('[data-edit]'); if (!el) return;
        const id = el.dataset.id, field = el.dataset.edit;
        if (field === 'kind') save(id, {kind: el.value, p: null});
        if (field === 'name') save(id, {name: el.value.trim() || undefined});
        if (field === 'height') save(id, {height: el.value === '' ? null : Number(el.value)});
    });
    body.addEventListener('click', e => {
        const s = e.target.closest('[data-status]'), r = e.target.closest('[data-row]');
        if (s) { const f = features().find(x => x.id === s.dataset.id); save(s.dataset.id, {status: f.status === s.dataset.status ? 'proposed' : s.dataset.status}); return; }
        if (e.target.id === 'acceptLabelled') { for (const f of features()) if (f.predictedKind && f.status === 'proposed') save(f.id, {status: 'accepted'}); return; }
        if (e.target.id === 'importNow') {
            e.target.disabled = true;
            saving.then(() => api('/api/intake/jobs/' + job.id + '/import', {method: 'POST'})).then(r => {
                say('Imported ' + r.features + ' features into <a href="/survey/?room=' + r.code + '">project ' + r.code + '</a>.', true);
                payload.imports = [...(payload.imports || []), {code: r.code, features: r.features, at: new Date().toISOString()}];
                exports();
            }).catch(err => { say(err.message); e.target.disabled = false; });
            return;
        }
        if (r && !e.target.closest('input,select,button')) { active = r.dataset.row; focusFeature(active); refresh(); }
    });
    v.onClick = (p, target) => { const hit = target.closest?.('[data-f]'); if (hit) { active = hit.dataset.f; refresh(); document.querySelector('[data-row="' + active + '"]')?.scrollIntoView({block: 'nearest'}); } };
    let dragged = null;
    v.onDrag = (handle, q) => {
        const [id, i] = handle.split(':'), f = features().find(x => x.id === id);
        const p = f.p.map(x => [...x]); p[+i] = v.toM(q).map(v => +v.toFixed(3));
        edits = {...edits, [id]: {...edits[id], p}}; dragged = {id, p}; v.redraw();
    };
    v.onDragEnd = () => { if (dragged) save(dragged.id, {p: dragged.p}); dragged = null; };
    refresh();
    exports();
}

if (params.get('job')) openJob(params.get('job')); else home();
