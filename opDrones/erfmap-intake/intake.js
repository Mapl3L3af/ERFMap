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

function mountReconstruction(host, {value, save} = {}) {
    const detail = document.createElement('details');
    detail.id = 'reconstruction'; detail.className = 'map-details';
    detail.innerHTML = '<summary>Optional · Photogrammetry setup</summary>'
        + '<p><label><input type="checkbox" data-enable> Use NodeODM for this flyover</label></p>'
        + '<div data-fields hidden><p><label>NodeODM service URL <input type="url" data-url value="http://127.0.0.1:3001" placeholder="http://127.0.0.1:3001"></label></p>'
        + '<p><label><input type="checkbox" data-building> Request a full 3D building model</label></p>'
        + '<p>Include overlapping photos of the roofs and building sides for a building model. The selected service receives your original photos when processing starts.</p>'
        + '<p>erfMap uses the orthophoto and terrain. Detailed building meshes stay in the downloadable photogrammetry files; they are not displayed in the survey.</p>'
        + '<button type="button" data-check>Check connection</button></div>'
        + '<p><a href="/info.html#reconstruction">Photo requirements and engine setup ↗</a></p>'
        + (save ? '<button type="button" data-save>Save setup &amp; rebuild imagery</button><p>Rebuilding replaces scale calibration, detected features and their review decisions.</p>' : '')
        + '<p data-status role="status"></p>';
    host.append(detail);
    const q = selector => detail.querySelector(selector);
    q('[data-enable]').checked = value?.enabled === true;
    q('[data-url]').value = value?.url || 'http://127.0.0.1:3001';
    q('[data-building]').checked = value?.buildingModel === true;
    const toggle = () => { q('[data-fields]').hidden = !q('[data-enable]').checked; };
    q('[data-enable]').onchange = toggle; toggle();
    const read = () => {
        if (!q('[data-enable]').checked) return {enabled:false};
        if (!q('[data-url]').reportValidity() || !q('[data-url]').value) throw Error('Enter the NodeODM service URL.');
        return {enabled:true, url:q('[data-url]').value.trim(), buildingModel:q('[data-building]').checked};
    };
    q('[data-check]').onclick = async () => {
        q('[data-check]').disabled = true; q('[data-status]').textContent = 'Checking NodeODM…';
        try {
            const result = await api('/api/intake/reconstruction-check', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(read())});
            q('[data-status]').textContent = result.ready ? 'ODM '+result.version+' is ready'+(result.maxImages ? ' · up to '+result.maxImages+' photos' : '')+'.' : 'Photogrammetry is off.';
        } catch (error) { q('[data-status]').textContent = error.message; }
        finally { q('[data-check]').disabled = false; }
    };
    if (save) q('[data-save]').onclick = async () => {
        q('[data-save]').disabled = true;
        try { await save(read()); } catch (error) { q('[data-status]').textContent = error.message; }
        finally { q('[data-save]').disabled = false; }
    };
    if (location.hash === '#reconstruction') detail.open = true;
    return {read};
}

// ---------------------------------------------------------------- home
async function home() {
    document.getElementById('newJob').hidden = true;
    app.innerHTML = '<div class="home"><section class="upload-intro"><small class="cap">Map from video</small><h2>Add video or photos</h2>'
        + '<p>Choose one drone video or overlapping overhead photos of the same site.</p>'
        + '<ol class="journey"><li><b>01</b> Add imagery</li><li><b>02</b> Set a distance</li><li><b>03</b> Review your map</li></ol></section>'
        + '<section class="card upload-card"><div id="reconstructionSetup"></div><div class="drop" id="drop"><h3>Drop your imagery here</h3><p>One video, or photos of the same site</p><label class="button primary" tabindex="0" id="filePicker" role="button">Choose video or photos<input type="file" id="video" multiple accept="video/*,image/*,.mp4,.mov,.mkv,.avi,.webm,.mts,.jpg,.jpeg,.png,.tif,.tiff,.webp" hidden></label><p class="cap" id="uploadName"></p><div class="bar" id="uploadBar" hidden><i style="width:0"></i></div></div>'
        + '<p id="uploadStatus" role="status"></p><p class="upload-tip">Have a known ground distance handy, such as a sidewalk width. You’ll use it to set the map’s scale.</p>'
        + '<details class="map-details"><summary>About your map</summary><p>Maps use local distances, with no GPS position or elevation. Camera angle and terrain can affect accuracy; results are not survey-grade.</p></details></section>'
        + '<section class="card capture-guide"><small class="cap">DJI Neo 2 · before you fly</small><h3>Film for a clean map</h3><ol>' + S.CAPTURE_GUIDE.map(g => '<li><b>' + esc(g.title) + '</b><span>' + esc(g.body) + '</span></li>').join('') + '</ol><p class="cap">After upload, erfMap checks your footage and tells you what to refilm.</p></section>'
        + '<section class="recent-section"><h3>Recent flyovers</h3><ul class="jobs" id="jobs"><li>Loading flyovers…</li></ul></section>'
        + '<details class="setup-details"><summary>Processing setup</summary><div id="caps"><p>Checking the worker…</p></div></details></div>';
    uploadReconstruction = mountReconstruction(document.getElementById('reconstructionSetup'));
    const input = document.getElementById('video'), drop = document.getElementById('drop');
    document.getElementById('filePicker').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
    input.onchange = () => input.files.length && upload([...input.files]);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files.length) upload([...e.dataTransfer.files]); };
    api('/api/intake/capabilities').then(renderCaps).catch(e => document.getElementById('caps').innerHTML = '<p class="no">' + esc(e.message) + '</p>');
    api('/api/intake/jobs').then(list => {
        document.getElementById('jobs').innerHTML = list.length ? list.map(j => {
            const states = Object.values(j.stages);
            const status = states.includes('processing') ? 'processing' : states.includes('failed') ? 'failed' : j.stages.review === 'complete' ? 'complete' : states.includes('needs_review') ? 'needs_review' : 'queued';
            return '<li>' + chip(status) + '<a href="?job=' + j.id + '">' + esc(j.name) + '</a><span class="cap">' + new Date(j.createdAt).toLocaleString() + '</span></li>';
        }).join('') : '<li class="empty-jobs">Your flyovers will appear here once you add imagery.</li>';
    }).catch(() => { document.getElementById('jobs').innerHTML = '<li class="empty-jobs">Could not load recent flyovers.</li>'; });
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
function send(url, file, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded);
        xhr.onload = () => {
            let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
            xhr.status >= 300 ? reject(Error(data.error || 'Upload failed.')) : resolve(data);
        };
        xhr.onerror = () => reject(Error('Upload failed. Is the erfMap server still running?'));
        xhr.send(file);
    });
}
let capturePinned = false;
let referencePinned = false;
let uploading = false, uploadReconstruction = null;
async function upload(files) {
    if (uploading || !files.length) return;
    const bar = document.getElementById('uploadBar'), status = document.getElementById('uploadStatus');
    const isVideo = f => /^video\//.test(f.type) || /\.(mp4|mov|m4v|avi|mkv|webm|mts|m2ts|3gp)$/i.test(f.name);
    const isPhoto = f => /^image\//.test(f.type) || /\.(jpe?g|png|tiff?|webp|bmp)$/i.test(f.name);
    const videos = files.filter(isVideo), photos = files.filter(isPhoto).sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}));
    if (videos.length && photos.length || videos.length > 1 || videos.length + photos.length !== files.length) {
        status.textContent = 'Choose either one video, or one or more photos (JPEG, PNG, TIFF or WebP).'; return;
    }
    let reconstruction;
    try { reconstruction = uploadReconstruction.read(); } catch (error) { status.textContent = error.message; return; }
    if (reconstruction.enabled && (videos.length || photos.length < 3)) { status.textContent = 'Photogrammetry needs at least three overlapping original photographs.'; return; }
    const setupQuery = reconstruction.enabled ? '&photogrammetry=1&nodeodm_url=' + encodeURIComponent(reconstruction.url) + (reconstruction.buildingModel ? '&building_model=1' : '') : '';
    const list = videos.length ? videos : photos, total = list.reduce((s, f) => s + f.size, 0);
    document.getElementById('uploadName').textContent = (videos.length ? list[0].name : list.length + ' photo' + (list.length > 1 ? 's' : '')) + ' · ' + (total / 1048576).toFixed(1) + ' MB';
    uploading = true;
    document.getElementById('video').disabled = true;
    document.getElementById('drop').setAttribute('aria-busy', 'true');
    bar.firstElementChild.style.width = '0%';
    bar.hidden = false;
    let done = 0;
    const progress = loaded => { bar.firstElementChild.style.width = (total ? 100 * (done + loaded) / total : 0) + '%'; };
    try {
        status.textContent = 'Uploading… originals are kept unchanged.';
        const created = await send('/api/intake/jobs?name=' + encodeURIComponent(list[0].name) + (photos.length ? '&defer=1' : '') + setupQuery, list[0], progress);
        done += list[0].size;
        for (const [i, file] of list.slice(1).entries()) {
            status.textContent = 'Uploading photo ' + (i + 2) + ' of ' + list.length + '…';
            await send('/api/intake/jobs/' + created.id + '/originals?name=' + encodeURIComponent(file.name), file, progress);
            done += file.size;
        }
        if (photos.length) await api('/api/intake/jobs/' + created.id + '/start', {method: 'POST'});
        location.assign('?job=' + created.id);
    } catch (e) { status.textContent = e.message + ' Choose your files again to retry.'; }
    finally { uploading = false; document.getElementById('video').disabled = false; document.getElementById('video').value = ''; document.getElementById('drop').removeAttribute('aria-busy'); }
}

// ---------------------------------------------------------------- job page
async function openJob(id) {
    document.getElementById('newJob').hidden = false;
    labels = (await api('/api/intake/labels')).labels;
    app.innerHTML = '<div class="layout single-review"><aside><button type="button" id="openCapture">Capture checks</button><ol class="stages" id="stages"></ol><details class="source-details"><summary>Source imagery</summary><section id="original"></section><button type="button" id="openReference">Map reference</button></details><details class="capture-check" id="captureCheck" hidden><summary id="captureSummary"></summary><div id="captureBody"></div></details></aside><section class="card" id="panel"><p>Loading…</p></section></div>';
    document.getElementById('openReference').onclick=()=>{referencePinned=true;capturePinned=false;selected='markers';renderPanel();};
    document.getElementById('openCapture').onclick = () => { capturePinned = true; selected = 'capture'; renderPanel(); };
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
        const originals = job.originals || [job.original];
        document.getElementById('original').innerHTML = job.media === 'photos'
            ? '<small class="cap">Original photos (kept unchanged)</small><p>' + originals.length + ' photo' + (originals.length > 1 ? 's' : '') + ' · ' + (originals.reduce((s, o) => s + o.size, 0) / 1048576).toFixed(1) + ' MB</p><details><summary>Files</summary><ul>' + originals.map(o => '<li><a href="' + fileUrl(o.path) + '" download>' + esc(o.name) + '</a></li>').join('') + '</ul></details>'
            : '<small class="cap">Original video (kept unchanged)</small><p>' + esc(job.original.name) + '<br><span class="cap">' + (job.original.size / 1048576).toFixed(1) + ' MB · uploaded ' + new Date(job.createdAt).toLocaleString() + '</span></p><a class="button" href="' + fileUrl(job.original.path) + '" download>Download original</a>';
    }
    const archiveReady = job.reconstruction?.enabled && ['complete','needs_review'].includes(job.stages.correction.status);
    if (!archiveReady) document.getElementById('reconstructionDownload')?.remove();
    if (archiveReady && !document.getElementById('reconstructionDownload')) {
        const download=document.createElement('p');download.id='reconstructionDownload';
        download.innerHTML='<a href="'+fileUrl('nodeodm-all.zip')+'" download>Download photogrammetry files (ZIP)</a>';
        document.getElementById('original').append(download);
    }
    // Keep one workspace open, moving from reference line to processing to review.
    const unlocked = (job.calibration?.references || []).some(r => r.confirmed !== false);
    const preparation = ['probe', 'frames', 'capture', 'correction', 'markers'];
    const preparing = preparation.find(id => !['complete', 'needs_review'].includes(job.stages[id].status));
    const processing = S.STAGES.filter(s => s.worker && !preparation.includes(s.id));
    const waiting = processing.find(s => !['complete', 'needs_review'].includes(job.stages[s.id].status)
        && !(s.optional && job.stages[s.id].status === 'unavailable'));
    const previousSelected = selected;
    const capturePending = job.stages.capture?.status === 'needs_review' && !job.captureReview;
    selected = referencePinned ? 'markers' : capturePinned || capturePending ? 'capture' : preparing || (!unlocked ? 'markers' : waiting?.id || 'review');
    document.getElementById('openReference').disabled=!['complete','needs_review'].includes(job.stages.markers.status);
    document.getElementById('openCapture').disabled = !['complete', 'needs_review'].includes(job.stages.capture?.status);
    renderStages();
    const state = job.stages[selected];
    const key = [state.status, state.attempts, state.finishedAt, selected === 'review' ? job.imports?.length : selected === 'capture' ? job.captureReview?.at : ''].join('|');
    if (previousSelected !== selected || shown[selected] !== key) { shown[selected] = key; delete results[selected]; renderPanel(); }
    else if (state.status === 'processing') renderHead();
}
// Footage check: once frames are scored (and aligned), say what to refilm.
let captureKey = '';
async function renderCapture() {
    const box = document.getElementById('captureCheck');
    if (!box || !job) return;
    const ok = id => ['complete', 'needs_review'].includes(job.stages[id]?.status);
    if (!ok('frames')) { box.hidden = true; return; }
    const key = ['frames', 'correction', 'probe'].map(id => job.stages[id]?.finishedAt + job.stages[id]?.status).join('|');
    if (key === captureKey) return;
    if (captureKey) for (const id of ['probe', 'frames', 'correction']) delete results[id];   // a stage was rerun
    captureKey = key;
    try {
        const [probe, frames, correction] = await Promise.all([ok('probe') ? stageData('probe') : null, stageData('frames'), ok('correction') ? stageData('correction') : null]);
        const r = S.captureReport({probe, frames, correction});
        document.getElementById('captureSummary').innerHTML = '<span class="capture-dot ' + (r.refilm ? 'refilm' : r.warnings ? 'warn' : 'ok') + '"></span>Footage check · ' + (r.refilm ? r.refilm + ' thing' + (r.refilm > 1 ? 's' : '') + ' to refilm' : r.warnings ? r.warnings + ' warning' + (r.warnings > 1 ? 's' : '') : 'looks good');
        document.getElementById('captureBody').innerHTML = '<ul class="capture-issues">' + r.issues.map(i => '<li class="' + i.severity + '"><b>' + esc(i.title) + '</b><span>' + esc(i.detail) + '</span>' + (i.at ? '<span class="cap">At ' + esc(i.at) + '</span>' : '') + (i.refilm ? '<span class="refilm-tip">' + esc(i.refilm) + '</span>' : '') + '</li>').join('') + '</ul>'
            + '<p class="cap">Not checked: ' + r.notChecked.map(esc).join(' ') + '</p>' + (r.refilm ? '<p><a class="button" href="/intake/">Upload new footage</a></p>' : '');
        box.hidden = false;
        if (r.refilm && !box.dataset.seen) { box.open = true; box.dataset.seen = '1'; }
    } catch (e) { captureKey = ''; box.hidden = true; }
}
function renderStages() {
    const phase = ['probe', 'frames', 'capture', 'correction'].includes(selected) ? 0 : selected === 'markers' ? 1 : selected === 'review' ? 3 : 2;
    const steps = ['Prepare imagery', 'Set the scale', 'Build the map', 'Review & finish'];
    renderCapture();
    document.getElementById('stages').innerHTML = steps.map((title, i) => '<li class="' + (i < phase ? 'done' : i === phase ? 'active' : '') + '"' + (i === phase ? ' aria-current="step"' : '') + '><span class="step-number">' + (i < phase ? '✓' : i + 1) + '</span><span>' + title + '</span></li>').join('');
}

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
    const title = selected === 'capture' ? 'Capture checks' : selected === 'markers' ? 'Set the scale' : selected === 'review' ? 'Review the map' : ['failed', 'unavailable'].includes(st.status) ? 'Processing needs attention' : ['probe', 'frames', 'capture', 'correction'].includes(selected) ? 'Preparing your imagery' : 'Building your map';
    let h = '<div class="panelhead"><div><small class="cap">' + (meta.id === 'markers' ? '1 · Reference line' : meta.id === 'review' ? '3 · Feature review' : ['probe', 'frames', 'capture', 'correction'].includes(meta.id) ? 'Preparing reference image' : '2 · Processing') + '</small><h2>' + title + ' ' + chip(st.status) + '</h2><p>' + esc(st.summary || (st.status === 'blocked' ? 'Waiting for an earlier stage.' : st.status === 'queued' ? 'Queued.' : '')) + '</p></div>';
    if (meta.worker && ['failed', 'unavailable'].includes(st.status)) h += '<button type="button" class="primary" data-retry="' + selected + '">Retry this stage</button>';
    else if (meta.worker && ['complete', 'needs_review'].includes(st.status) && selected !== 'markers') h += '<button type="button" data-retry="' + selected + '" title="Earlier stages are kept. This stage and the ones after it run again.">Run again from here</button>';
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
    document.body.classList.remove('review-workspace', 'show-review-stages');
    viewer = null; view = {};
    panel.innerHTML = '<div id="head">' + headMarkup() + '</div><div id="body"></div>';
    const ready = ['complete', 'needs_review', 'unavailable'].includes(st.status);
    if (!ready && !(selected === 'review' && st.status !== 'blocked')) {
        if (['processing', 'queued', 'blocked'].includes(st.status)) document.getElementById('body').innerHTML = '<div class="processing-state"><span class="processing-orbit" aria-hidden="true"></span><h3>' + (['probe', 'frames', 'capture', 'correction'].includes(selected) ? 'Preparing the reference image' : 'Detecting buildings, paths and other features') + '</h3><p>This page updates automatically. You can leave and return from the flyover list.</p></div>';
        return;
    }
    try {
        const data = results[selected] || await api('/api/intake/jobs/' + job.id + '/stages/' + selected);
        results[selected] = data;
        const body = document.getElementById('body');
        if (!body) return;
        await ({probe: viewProbe, frames: viewFrames, capture: viewCapture, correction: viewCorrection, markers: viewMarkers, regions: viewRegions, classification: viewClassification, merging: viewMerging, geometry: viewGeometry, review: viewReview}[selected])(body, data);
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
    if (m.media === 'photos') {
        body.innerHTML = '<div class="grid">' + m.photos.map(p => '<figure class="thumb" style="margin:0;cursor:default"><img loading="lazy" src="' + fileUrl(p.path) + '" alt=""><div><b>' + esc(p.name) + '</b><br>' + p.width + ' × ' + p.height + (p.exif ? '<br><span class="cap">' + esc([p.exif.Make, p.exif.Model].filter(Boolean).join(' ') || 'no camera tags') + (p.exif.DateTimeOriginal ? ' · ' + esc(p.exif.DateTimeOriginal) : '') + (p.exif.GPSInfo ? ' · GPS tag (unused)' : '') + '</span>' : '') + '</div></figure>').join('') + '</div>';
        return;
    }
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
        body.innerHTML = '<p>' + (data.sample_fps ? 'Frames sampled at ' + data.sample_fps.toFixed(2) + ' per second.' : 'Each uploaded photo is one frame, scaled to at most 2000 px.') + ' Blur limit: sharpness below ' + data.blur_limit + '. Flagged frames are left out of later stages.</p>'
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

function viewCapture(body, data) {
    if (!data.readiness) {
        body.innerHTML = '<p>Capture checks were not run for this older flyover. Use “Run again from here” to check it; downstream results will be rebuilt.</p>';
        return;
    }
    const images = data.images || [], usable = images.filter(i => !i.excluded).length;
    const readiness = {ready: 'Ready for processing', needs_review: 'Review capture warnings', blocked: 'Multi-view reconstruction blocked'}[data.readiness];
    body.innerHTML = '<h3>' + esc(readiness) + '</h3><ul>' + (data.reasons || []).map(r => '<li>' + esc(r) + '</li>').join('') + '</ul>'
        + '<p>These checks run before map processing. '+(job.reconstruction?.enabled ? 'NodeODM photogrammetry is enabled for this flyover. These planar checks do not verify building-side coverage.' : 'Photogrammetry is off for this flyover.')+' Original uploads are preserved.</p>'
        + (job.captureReview ? '<p class="note">Report acknowledged for 2D mapping at ' + esc(new Date(job.captureReview.at).toLocaleString()) + '.</p>' : data.readiness !== 'ready' ? '<p>Review the images below. You can start a new flyover with additional connecting or replacement photos, or acknowledge the limitations and continue with the current 2D pipeline.</p><button type="button" class="primary" id="continueCapture"' + (usable ? '' : ' disabled') + '>'+(job.reconstruction?.enabled ? 'Continue with photogrammetry' : 'Continue with 2D mapping')+'</button>' : '')
        + '<p><button type="button" id="returnCapture">Return to workflow</button> <a class="button" href="/api/intake/jobs/' + job.id + '/stages/capture" download="capture-report.json">Download report JSON</a> <a class="button" href="/intake/">New flyover</a></p>'
        + '<h3>Image quality and overlap</h3><p class="cap">Quality scores use a maximum analysis side of ' + data.settings.analysis_side + ' px. Sharpness threshold: ' + data.settings.sharpness_min + '; texture threshold: ' + data.settings.texture_min + '. Overlap target: ' + pct(data.settings.overlap_target) + '. Overlap is a planar footprint estimate, not a raw match count.</p>'
        + '<div style="overflow:auto"><table><thead><tr><th>Image</th><th>Quality</th><th>Connections / best overlap</th><th>Flags / exclusions</th></tr></thead><tbody>' + images.map(i => '<tr><td><a href="' + fileUrl(i.image) + '" target="_blank" rel="noopener"><img loading="lazy" src="' + fileUrl(i.image) + '" alt="' + esc(i.source) + '" style="width:100px;max-height:80px;object-fit:contain"><br>' + esc(i.source) + '</a><br>' + esc(i.id) + '</td><td>Sharpness ' + i.metrics.sharpness + '<br>Texture ' + i.metrics.texture + '</td><td>' + i.connections + ' / ' + pct(i.best_overlap) + '</td><td>' + flags(i.flags, ['blur', 'connection', 'overlap']) + (i.excluded ? '<br><b>Excluded:</b> ' + esc(i.exclusion_reasons.join(', ')) : '') + '</td></tr>').join('') + '</tbody></table></div>'
        + '<h3>Image connection groups</h3><p>' + esc(data.pair_search) + ' · ' + data.compared_pairs + ' pairs checked. A connection means distributed ORB matches passed geometric verification; it does not guarantee reconstruction.</p><ol>' + data.groups.map(group => '<li>' + group.map(esc).join(', ') + '</li>').join('') + '</ol>'
        + '<h3>Estimated coverage</h3><p>Green: two or more image footprints. Amber: one view. Red: suspected enclosed gap. Dark: outside estimated footprints. Separate groups have unrelated coordinate frames. This preview cannot detect all missing outer strips or ground hidden by trees and buildings.</p>'
        + data.coverage.map(group => '<section><h4>' + group.images.map(esc).join(', ') + ' · ' + esc(group.status) + '</h4>' + (group.image ? '<img src="' + fileUrl(group.image) + '" alt="Estimated image footprint coverage" style="max-width:100%;image-rendering:pixelated"><p>Single-view area: ' + pct(group.single_view_fraction) + ' · suspected enclosed gaps: ' + group.gaps.length + '</p><p class="cap">' + esc(group.scope) + '</p>' : '<p>' + esc(group.reason) + '</p>') + '</section>').join('')
        + '<details><summary>Verified image pairs</summary><table><tr><th>Pair</th><th>Inliers</th><th>Overlap estimate</th></tr>' + data.links.filter(l => l.ok).map(l => '<tr><td>' + esc(l.from) + ' → ' + esc(l.to) + '</td><td>' + l.inliers + '</td><td>' + pct(l.overlap) + '</td></tr>').join('') + '</table></details>';
    document.getElementById('returnCapture').onclick = () => { capturePinned = false; update(job); };
    const button = document.getElementById('continueCapture');
    if (button) button.onclick = async () => {
        button.disabled = true;
        try {
            const next = await api('/api/intake/jobs/' + job.id + '/capture-review', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({action: job.reconstruction?.enabled ? 'continue-reconstruction' : 'continue-2d'})});
            capturePinned = false;
            update(next);
        } catch (error) { button.disabled = false; alert(error.message); }
    };
}

function viewCorrection(body, data) {
    let current = data.frames[0];
    const okLinks = data.links.filter(l => l.ok).length;
    body.innerHTML = '<table class="kv"><tr><td>Cleanup</td><td>' + esc(data.cleanup) + ' <span class="flag good">applied</span></td></tr><tr><td>Lens correction</td><td>' + esc(data.lens.reason) + ' <span class="flag ' + (data.lens.status === 'applied' ? 'good' : 'bad') + '">' + data.lens.status + '</span></td></tr><tr><td>Alignment</td><td>' + (data.layout === 'sheet' ? 'None: photos are calibrated one by one, so they are laid out side by side instead of stitched.' : okLinks + ' of ' + data.links.length + ' frame pairs matched (ORB features + RANSAC homography); reference frame ' + data.reference) + '</td></tr></table>'
        + '<h3>Before and after cleanup</h3><div class="row" id="strip" style="overflow-x:auto;flex-wrap:nowrap;padding-bottom:6px">' + data.frames.map(f => '<button type="button" class="thumb" style="flex:0 0 110px" data-cframe="' + f.id + '"><img loading="lazy" src="' + fileUrl(f.after) + '" alt=""><div>' + f.id + (f.to_mosaic ? '' : ' <span class="flag bad">unaligned</span>') + '</div></button>').join('') + '</div><div class="compare" id="compare"></div>'
        + (data.layout === 'sheet' ? '<h3>Photo sheet</h3><p>Each photo keeps its own pixels. Their positions relative to each other are not known.</p>' : '<h3>Alignment preview</h3><p>Aligned frames stitched onto the reference frame with planar homographies. This is a preview for checking overlap, not an orthomosaic.</p>') + '<div id="mosaic"></div>'
        + (data.layout === 'sheet' ? '' : '<details><summary>Frame-pair matches</summary><table><tr><th>From</th><th>To</th><th>Inliers</th><th></th></tr>' + data.links.map(l => '<tr><td>' + l.from + '</td><td>' + (l.to || 'no match') + '</td><td>' + l.inliers + '</td><td>' + (l.ok ? '<span class="flag good">aligned</span>' : '<span class="flag bad">weak match</span>') + '</td></tr>').join('') + '</table></details>');
    const compare = () => {
        document.getElementById('compare').innerHTML = '<figure><img src="' + fileUrl(current.before) + '" alt="Before"><figcaption>Before · extracted frame ' + current.id + '</figcaption></figure><figure><img src="' + fileUrl(current.after) + '" alt="After"><figcaption>After · cleanup' + (data.lens.status === 'applied' ? ' and lens correction' : ' (lens correction unavailable)') + '</figcaption></figure>';
        document.querySelectorAll('[data-cframe]').forEach(b => b.setAttribute('aria-pressed', b.dataset.cframe === current.id));
    };
    document.getElementById('strip').onclick = e => { const b = e.target.closest('[data-cframe]'); if (b) { current = data.frames.find(f => f.id === b.dataset.cframe); compare(); } };
    compare();
    createViewer(document.getElementById('mosaic'), {image: fileUrl(data.mosaic.image), width: data.mosaic.width, height: data.mosaic.height, hint: 'Scroll to zoom, drag to pan'});
}

// ---- scale calibration
const UNITS = {ft: 0.3048, in: 0.0254, m: 1, cm: 0.01};
const refLength = r => Math.hypot(r.a[0] - r.b[0], r.a[1] - r.b[1]);
const fmtLength = m => m >= 1 ? m.toFixed(2) + ' m (' + (m / 0.3048).toFixed(1) + ' ft)' : (m * 100).toFixed(1) + ' cm (' + (m / 0.0254).toFixed(1) + ' in)';
// Photos: one measured distance per photo, each photo scaled on its own.
function calibrationChecks(r, tile) {
    const [x0, y0, w, h] = tile, out = [], inside = q => q[0] >= x0 && q[0] <= x0 + w && q[1] >= y0 && q[1] <= y0 + h;
    if (!inside(r.a) || !inside(r.b)) out.push('reference segment leaves the photo');
    if (refLength(r) < 0.1 * Math.max(w, h)) out.push('reference segment is short (under 10% of the photo), so a small click error changes the scale a lot');
    const m = 0.05 * Math.max(w, h);
    if ([r.a, r.b].some(q => q[0] - x0 < m || x0 + w - q[0] < m || q[1] - y0 < m || y0 + h - q[1] < m)) out.push('reference end near the photo edge, where lens distortion is strongest');
    return out;
}
function measurementHeight(body) {
    const field = document.createElement('p');
    field.innerHTML = '<label>Height above ground (m) <input id="captureHeight" type="number" min="0.1" max="10000" step="any"></label>';
    body.prepend(field);
    const input = field.querySelector('input');
    input.value = job.captureProfile?.height_agl_m ?? '';
    let edited = false;
    input.oninput = () => { edited = true; };
    return () => {
        if (!edited) return {};
        if (!input.reportValidity() || !input.value) throw Error('Enter a height greater than zero.');
        return {height_agl_m: Number(input.value)};
    };
}
async function viewPerImage(body, data) {
    const images = data.images || [];
    const refs = JSON.parse(JSON.stringify((job.calibration?.references || []).filter(r => r.frame)));
    const geometry = job.stages.geometry.status === 'needs_review' || job.stages.geometry.status === 'complete' ? await stageData('geometry').catch(() => null) : null;
    const checked = Object.fromEntries((geometry?.scale?.images || []).map(i => [i.frame, i]));
    let active = images[0]?.frame || null, measuring = null, pending = null, dirty = false;
    const name = i => i.source || i.frame;
    body.innerHTML = '<div class="note">Each photo is calibrated <b>on its own</b>: pick a photo, click the two ends of something you measured on the ground (sidewalk width, a tape measure, two cones), and enter the distance. That photo’s features are sized from that distance only; no scale is shared between photos.'
        + '<br>A single distance sets the scale <b>near the measured segment</b>. Perspective, camera tilt, terrain and lens distortion make sizes elsewhere in the photo approximate. Results are <b>locally scaled, unreferenced</b>: no geographic coordinates and no heights.</div>'
        + '<div class="split"><div id="mviewer"></div><div>'
        + '<div id="refForm" hidden class="card" style="margin-bottom:8px;padding:10px"><b id="refFor"></b><label>Distance between A and B <div class="row"><input id="refValue" type="number" min="0" step="any" style="width:110px"><select id="refUnit"><option value="ft">ft</option><option value="m">m</option><option value="in">in</option><option value="cm">cm</option></select></div></label><label>What is it? <input id="refLabel" placeholder="e.g. sidewalk width, tape measure" style="width:100%"></label><div class="row" style="margin-top:6px"><button type="button" class="primary" id="refAdd">Use this distance</button><button type="button" id="refCancel">Cancel</button></div></div>'
        + '<div class="row"><button type="button" class="primary" id="saveMarkers">Save scale &amp; continue</button></div><p id="mstatus" class="cap"></p><div class="list" id="mlist"></div></div></div>';
    const height = measurementHeight(body);
    const v = viewer = createViewer(document.getElementById('mviewer'), {image: fileUrl(data.mosaic.image), width: data.mosaic.width, height: data.mosaic.height, hint: 'Zoom in before clicking. Drag the white handles to adjust a segment.'});
    const text = (x, y, t, k, anchor = 'start') => '<text x="' + x + '" y="' + y + '" font-size="' + 13 * k + '" text-anchor="' + anchor + '" fill="#fff" stroke="#000" stroke-width="' + 3 * k + '" paint-order="stroke">' + esc(t) + '</text>';
    const draw = () => {
        const k = v.scale;
        let s = '';
        for (const i of images) {
            const [x, y, w, h] = i.tile, r = refs.find(q => q.frame === i.frame), on = i.frame === active;
            s += '<rect data-tile="' + i.frame + '" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="none" stroke="' + (on ? '#c2e69e' : r ? '#8ec26a' : '#e8b04f') + '" stroke-width="' + (on ? 3 : 1.5) + '" vector-effect="non-scaling-stroke"/>';
            s += text(x + 8 * k, y + 20 * k, name(i) + (r ? ' · ' + fmtLength(r.metres) : ' · not calibrated'), k);
        }
        for (const r of [...refs, ...(pending ? [pending] : [])]) {
            const on = r.frame === active;
            s += '<line x1="' + r.a[0] + '" y1="' + r.a[1] + '" x2="' + r.b[0] + '" y2="' + r.b[1] + '" stroke="#6fb3e0" stroke-width="' + (on ? 3 : 2) + '" vector-effect="non-scaling-stroke"/>';
            s += text((r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2 - 8 * k, r === pending ? 'A–B' : fmtLength(r.metres), k, 'middle');
            if (on && r !== pending) ['a', 'b'].forEach(end => s += '<circle data-handle="r:' + r.frame + ':' + end + '" cx="' + r[end][0] + '" cy="' + r[end][1] + '" r="' + 6 * k + '" fill="#fff" stroke="#155d76" stroke-width="2" vector-effect="non-scaling-stroke" style="cursor:move"/>');
        }
        for (const p of measuring?.points || []) s += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + 4 * k + '" fill="#c2e69e"/>';
        v.draw(s);
    };
    v.redraw = draw;
    const list = () => {
        document.getElementById('mlist').innerHTML = images.map(i => {
            const r = refs.find(q => q.frame === i.frame), c = checked[i.frame];
            const same = r && c && c.reference === r.id && c.a?.[0] === r.a[0] && c.a?.[1] === r.a[1] && c.b?.[0] === r.b[0] && c.b?.[1] === r.b[1] && c.metres === r.metres;
            const issues = r ? [...new Set([...calibrationChecks(r, i.tile), ...(same ? c.flags : [])])] : [];
            return '<div data-pick="' + i.frame + '" aria-selected="' + (i.frame === active) + '"><b>' + esc(name(i)) + '</b> ' + (r ? '<span class="flag good">' + esc(fmtLength(r.metres)) + '</span>' : '<span class="flag">not calibrated</span>')
                + (r ? '<br><span class="cap">' + (r.label ? esc(r.label) + ' · ' : '') + refLength(r).toFixed(0) + ' px · ≈ ' + (r.metres / refLength(r) * 100).toFixed(2) + ' cm per pixel in this photo</span>' : '')
                + (issues.length ? '<br>' + flags(issues, ['short', 'leaves', 'edge', 'featureless', 'blurry', 'tilted']) : '') + (i.flags?.length ? '<br><span class="cap">Photo: ' + esc(i.flags.join(', ')) + '</span>' : '')
                + '<div class="row" style="margin-top:6px"><button type="button" data-measure="' + i.frame + '">' + (r ? 'Redo points' : 'Calibrate this photo') + '</button>' + (r ? '<button type="button" data-editref="' + i.frame + '">Edit distance</button><button type="button" data-remove="' + i.frame + '">Remove</button>' : '') + '</div></div>';
        }).join('');
        const done = new Set(refs.map(r => r.frame)).size;
        document.getElementById('mstatus').textContent = measuring ? 'Click point ' + (measuring.points.length ? 'B' : 'A') + ' inside ' + name(images.find(i => i.frame === measuring.frame)) + '.' : pending ? 'Enter the measured distance.' : (dirty ? 'Unsaved changes. ' : '') + done + ' of ' + images.length + ' photos calibrated.' + (done < images.length ? ' Uncalibrated photos are left out of the map.' : '');
        draw();
    };
    const focusTile = frame => { const i = images.find(x => x.frame === frame); if (i) { const [x, y, w, h] = i.tile; v.focus(x, y, x + w, y + h, 1.05); } };
    const openForm = (frame, r) => {
        const f = document.getElementById('refForm'); f.hidden = false;
        document.getElementById('refFor').textContent = name(images.find(i => i.frame === frame));
        document.getElementById('refUnit').value = 'ft';
        document.getElementById('refValue').value = r ? +(r.metres / 0.3048).toFixed(3) : '';
        document.getElementById('refLabel').value = r?.label || '';
        document.getElementById('refValue').focus();
    };
    v.onClick = (p, target) => {
        if (measuring) {
            const i = images.find(x => x.frame === measuring.frame), [x, y, w, h] = i.tile;
            if (p[0] < x || p[0] > x + w || p[1] < y || p[1] > y + h) { document.getElementById('mstatus').textContent = 'That point is outside ' + name(i) + '. Both ends must be in the same photo.'; return; }
            measuring.points.push(p);
            if (measuring.points.length === 2) {
                const old = refs.find(r => r.frame === measuring.frame);
                pending = {frame: measuring.frame, a: measuring.points[0], b: measuring.points[1], metres: old?.metres, label: old?.label};
                measuring = null; openForm(pending.frame, old);
            }
            list(); return;
        }
        const hit = target.closest?.('[data-tile]');
        if (hit) { active = hit.dataset.tile; list(); }
    };
    v.onDrag = (handle, p) => { const [, frame, end] = handle.split(':'); const r = refs.find(x => x.frame === frame); if (r) { r[end] = p; dirty = true; draw(); } };
    v.onDragEnd = () => list();
    body.querySelector('#mlist').onclick = e => {
        const m = e.target.closest('[data-measure]'), ed = e.target.closest('[data-editref]'), rm = e.target.closest('[data-remove]'), pick = e.target.closest('[data-pick]');
        if (m) { active = m.dataset.measure; measuring = {frame: active, points: []}; pending = null; document.getElementById('refForm').hidden = true; focusTile(active); }
        else if (ed) { active = ed.dataset.editref; const r = refs.find(x => x.frame === active); pending = {...r}; openForm(active, r); }
        else if (rm) { refs.splice(refs.findIndex(x => x.frame === rm.dataset.remove), 1); dirty = true; }
        else if (pick) { active = pick.dataset.pick; focusTile(active); }
        list();
    };
    document.getElementById('refCancel').onclick = () => { pending = null; document.getElementById('refForm').hidden = true; list(); };
    document.getElementById('refAdd').onclick = () => {
        const metres = Number(document.getElementById('refValue').value) * UNITS[document.getElementById('refUnit').value];
        if (!(metres > 0) || !pending) { document.getElementById('mstatus').textContent = 'Enter the measured distance.'; return; }
        const n = images.findIndex(i => i.frame === pending.frame) + 1;
        const r = {id: 'D' + n, frame: pending.frame, a: pending.a, b: pending.b, metres, label: document.getElementById('refLabel').value.trim(), confirmed: true};
        const at = refs.findIndex(x => x.frame === r.frame);
        if (at >= 0) refs[at] = r; else refs.push(r);
        pending = null; dirty = true; document.getElementById('refForm').hidden = true;
        list();
    };
    document.getElementById('saveMarkers').onclick = async () => {
        const note = t => { const el = document.getElementById('mstatus'); if (el) el.textContent = t; };
        try { await api('/api/intake/jobs/' + job.id + '/calibration', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({markers: [], references: refs, markerSideM: job.calibration?.markerSideM || 0.3048, ...height()})}); dirty = false; delete results.geometry; note('Scale saved. Building your map…'); }
        catch (e) { note(e.message); }
    };
    list();
}
async function viewMarkers(body, data) {
    if (data.mode === 'per-image') return viewPerImage(body, data);
    let reference = JSON.parse(JSON.stringify(job.calibration?.references?.find(r => !r.frame) || null));
    let points = reference ? [reference.a, reference.b] : [];
    body.innerHTML = '<p>Click the two ends of a line segment, then enter its known length.</p>'
        + '<div class="split"><div id="mviewer"></div><div>'
        + '<label class="row">Known length <input id="lengthValue" type="number" min="0" step="any" style="width:100px"><select id="lengthUnit"><option value="ft">ft</option><option value="in">in</option><option value="m">m</option><option value="cm">cm</option></select></label>'
        + '<div class="row"><button type="button" id="redrawSegment">Redraw segment</button><button type="button" class="primary" id="saveMarkers">Save scale &amp; continue</button></div><p id="mstatus" class="cap"></p></div></div>';
    const height = measurementHeight(body);
    const v = viewer = createViewer(document.getElementById('mviewer'), {image: fileUrl(data.mosaic.image), width: data.mosaic.width, height: data.mosaic.height, hint: 'Click two endpoints. Drag the handles to adjust the segment.'});
    const input = document.getElementById('lengthValue'), unit = document.getElementById('lengthUnit');
    if (reference) { unit.value = 'm'; input.value = reference.metres; }
    const note = message => { document.getElementById('mstatus').textContent = message; };
    const draw = () => {
        const k = v.scale;
        let svg = points.length === 2 ? '<line x1="' + points[0][0] + '" y1="' + points[0][1] + '" x2="' + points[1][0] + '" y2="' + points[1][1] + '" stroke="#8ec26a" stroke-width="3" vector-effect="non-scaling-stroke"/>' : '';
        points.forEach((p, i) => { svg += '<circle data-handle="segment:' + i + '" cx="' + p[0] + '" cy="' + p[1] + '" r="' + 5 * k + '" fill="#fff" stroke="#155d76" stroke-width="2" vector-effect="non-scaling-stroke"/>'; });
        v.draw(svg);
    };
    v.redraw = draw;
    v.onClick = p => { if (points.length < 2) { points.push(p); draw(); note(points.length === 2 ? 'Enter the known length, then save calibration.' : 'Click the second endpoint.'); } };
    v.onDrag = (handle, p) => { points[Number(handle.split(':')[1])] = p; draw(); note('Unsaved changes.'); };
    document.getElementById('redrawSegment').onclick = () => { points = []; draw(); note('Click the first endpoint.'); };
    document.getElementById('saveMarkers').onclick = async () => {
        const metres = Number(input.value) * UNITS[unit.value];
        if (points.length !== 2 || refLength({a: points[0], b: points[1]}) <= 2) return note('Select two different endpoints on the preview.');
        if (!(metres > 0 && metres < 10000)) return note('Enter a known length greater than zero and less than 10,000 m.');
        reference = {id: 'D1', a: points[0], b: points[1], metres, confirmed: true};
        try {
            await api('/api/intake/jobs/' + job.id + '/calibration', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({markers: [], references: [reference], ...height()})});
            delete results.geometry;
            note('Scale saved. Building your map…');
        } catch (e) { note(e.message); }
    };
    draw();
    note(points.length === 2 ? 'Adjust the segment or its known length, then save.' : 'Click the first endpoint.');
    mountMapReference(body, {job, mosaic:data.mosaic, fileUrl, save:async input=>{
        const next=await api('/api/intake/jobs/'+job.id+'/map-reference', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
        for(const stage of ['regions','classification','merging','geometry'])delete results[stage];
        referencePinned=false;
        update(next);
    }});
    mountReconstruction(body, {value:job.reconstruction, save:async config=>{
        const next=await api('/api/intake/jobs/'+job.id+'/reconstruction',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});
        results={}; shown={}; referencePinned=false; update(next); renderPanel();
    }});
    if(referencePinned){const back=document.createElement('button');back.type='button';back.textContent='Return to workflow';back.onclick=()=>{referencePinned=false;update(job);renderPanel();};body.prepend(back);}
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
            if (p?.omit) { s += '<polygon points="' + pts(r.polygon) + '" fill="none" stroke="#9a9a9a" stroke-width="1" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"><title>' + r.id + ' · omitted: ' + esc(p.omit_reason || '') + '</title></polygon>'; used.add('omit'); continue; }
            const l = label(p?.kind); used.add(p?.kind || '');
            s += '<polygon points="' + pts(r.polygon) + '" fill="' + l.color + '" fill-opacity=".38" stroke="' + (p?.needs_review ? '#e0705f' : l.color) + '" stroke-width="2" ' + (p?.needs_review ? 'stroke-dasharray="6 4" ' : '') + 'vector-effect="non-scaling-stroke"><title>' + r.id + ' · ' + esc(l.label) + (p?.confidence != null ? ' · ' + pct(p.confidence) : '') + '</title></polygon>';
            const c = S.centroid(r.polygon);
            s += '<text x="' + c[0] + '" y="' + c[1] + '" font-size="' + 11 * k + '" text-anchor="middle" fill="#fff" stroke="#000" stroke-width="' + 3 * k + '" paint-order="stroke">' + esc(p?.kind ? l.label + ' ' + pct(p.confidence) : '?') + '</text>';
        }
        v.draw(s);
        if (predictions && document.getElementById('klegend')) document.getElementById('klegend').innerHTML = [...used].map(kd => kd === 'omit' ? '<span><i style="border:1px dashed #9a9a9a"></i>Omitted (not mapped)</span>' : '<span><i style="background:' + label(kd || null).color + '"></i>' + esc(kd ? label(kd).label : 'Unlabelled') + '</span>').join('') + '<span><i style="border:2px dashed #e0705f"></i>needs review (confidence below ' + pct(results.classification?.uncertain_below) + ' or no label)</span>';
    };
    v.redraw = draw;
    document.getElementById('kf').onchange = e => { frame = regions.keyframes.find(k => k.id === e.target.value); v.setImage(fileUrl(frame.image), frame.width, frame.height); v.fit(); };
}
function viewRegions(body, data) {
    return keyframeView(body, data, null, '<p>Method: <b>' + esc(data.method) + '</b>. Regions are outlined only; no labels are assigned at this stage.</p>');
}
async function viewClassification(body, data) {
    const regions = await stageData('regions');
    const model = data.model ? 'Model: <b>' + esc(data.model.name || 'unnamed') + '</b> ' + esc(data.model.version || '') + (data.model.heuristic ? ' <span class="flag bad">heuristic, not trained</span>' : '') + (data.model.note ? '<br><span class="cap">' + esc(data.model.note) + '</span>' : '') : 'No classifier ran. Regions are shown as unlabelled proposals.';
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
    document.getElementById('glist').onclick = e => { const p = e.target.closest('[data-pick]'); if (!p) return; active = p.dataset.pick; const g = data.merged.find(x => x.id === active); const xs = g.polygon.map(q => q[0]), ys = g.polygon.map(q => q[1]); v.focus(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 2.5, v.contextSize(data.scale?.m_per_px > 0 ? 25 / data.scale.m_per_px : 0)); list(); };
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
        if (mode === 'imagery' && geometry.evidence?.shadows && options.shadows?.()) s += '<image href="' + esc(fileUrl(geometry.evidence.shadows) + '?v=' + (geometry.revision || 'initial')) + '" width="' + geometry.mosaic.width + '" height="' + geometry.mosaic.height + '" pointer-events="none"/>';
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
    const drawFeatures = v.redraw;
    if (options.overlay) v.redraw = () => { drawFeatures(); v.overlay.insertAdjacentHTML('beforeend', options.overlay(toPx, v.scale)); };
    v.toPx = toPx; v.toM = toM;
    return v;
}
function viewGeometry(body, data) {
    if (!data.features?.length) {
        body.innerHTML = '<div class="note warn">' + esc(data.summary || 'No geometry yet.') + '</div><button type="button" data-stage="markers">Go to Scale calibration</button>';
        return;
    }
    const sc = data.scale;
    const scaleText = sc.mode === 'per-image'
        ? 'Per photo, from one measured distance each:' + sc.images.map(i => '<br>' + esc(i.source || i.frame) + ': ' + esc(fmtLength(i.metres)) + (i.label ? ' (' + esc(i.label) + ')' : '') + ' over ' + i.segment_px.toFixed(0) + ' px ≈ ' + (i.m_per_px * 100).toFixed(2) + ' cm/px' + (i.flags.length ? ' ' + flags(i.flags, ['short', 'leaves', 'edge', 'featureless', 'blurry', 'tilted']) : '')).join('') + '<br><span class="cap">Photos are placed side by side below; the gaps between them mean nothing.</span>'
        : (sc.m_per_px * 100).toFixed(3) + ' cm per preview pixel, median of ' + sc.markers + ' marker(s) and ' + (sc.references || 0) + ' measured distance(s)' + (sc.spread != null ? '; references disagree by ' + (sc.spread * 100).toFixed(1) + '%' : '');
    body.innerHTML = '<table class="kv"><tr><td>Scale</td><td>' + scaleText + '</td></tr><tr><td>Extent</td><td>' + data.extent_m.map(v => v.toFixed(1)).join(' × ') + ' m (local)</td></tr><tr><td>Features</td><td>' + data.features.length + ' proposals: ' + ['area', 'line', 'point'].map(g => data.features.filter(f => f.geometry === g).length + ' ' + g + 's').join(', ') + '</td></tr></table><div id="geomap" style="margin-top:10px"></div>';
    const features = S.reviewedFeatures(data, {}, labels);
    viewer = mapView(document.getElementById('geomap'), data, () => features);
}

// ---- review & export
async function viewReview(body, payload) {
    const geometry = await stageData('geometry');
    if (!geometry.features?.length) { body.innerHTML = '<div class="note warn">Map geometry is not ready. Specify a known segment length in Scale calibration first.</div>'; return; }
    document.body.classList.add('review-workspace');
    let edits = payload.review?.features || {}, active = null, reviewPanel = 'review';
    const staged = job.sceneMode === 'stitched', phase = staged ? payload.review?.phase || 'zones' : 'ready';
    let outline = [];
    let marks = [], clickMode = 'select', shadows = false, busy = false, submitting = false;
    const visible = f => phase === 'zones' ? f.kind !== 'grass' && (f.geometry !== 'point' || f.kind === 'tree') : phase === 'points' ? ['tree', 'bush', 'bench', 'light'].includes(f.kind) : phase === 'access' ? ['entrance', 'path'].includes(f.kind) : true;
    const title = {zones: '1 · Review zones and trees', points: '2 · Review bushes, benches and lights', access: '3 · Confirm entrances and NPC access', ready: 'Ready to import'}[phase];
    const options = phase === 'zones' ? ['select', 'building', 'path', 'tree', 'shadow'] : phase === 'points' ? ['select', 'tree', 'bush', 'bench', 'light', 'remove'] : phase === 'access' ? ['select', 'entrance'] : ['select'];
    const toolbar = staged ? '<h3>' + title + '</h3><p>' + ({zones: 'Start with rough guidance: drag a general path line, or click building corners and choose Finish outline. Reevaluate to let the model fit visible boundaries; sketches are suggestions, not final answers. Accept the resulting proposals when correct. Use trees and shade to explain hidden path sections.', points: 'Trees require a visible canopy; vegetation without one is a bush. Outline a representative bush, bench or light post: choose the category, click around the object, then Finish outline. SAM 3 uses these examples to search for similar objects when enabled. Reevaluate and review the proposals. Remove dot suppresses an incorrect detection.', access: 'NPC spawn and leave points are only required at scene-edge path ends. Paths ending within 5% of the map boundary extend to the edge. Building entrances are optional. Click the actual door on an accepted building outline. Nearby path ends join it; red circles show optional interior connections. Select a path to drag its end to the correct entrance or scene edge.', ready: 'Zone, point and access review are complete.'}[phase]) + '</p>'
        + (geometry.pointDetection && phase === 'points' ? '<p class="note">' + esc(geometry.pointDetection) + '</p>' : '')
        + '<div class="row"><label>Action <select id="clickMode">' + options.map(k => '<option value="' + k + '">' + ({select: 'Select / edit', shadow: 'This is shadow', remove: 'Remove dot', entrance: 'Mark building entrance'}[k] || 'This is ' + label(k).label) + '</option>').join('') + '</select></label><label><input type="checkbox" id="showShadows"> Show candidate shadows</label>'
        + (['zones', 'points'].includes(phase) ? '<button type="button" id="finishOutline">Finish outline</button><label>Search corridor size <input id="brushSize" type="range" min="8" max="100" value="32"></label>' : '')
        + (['zones', 'points'].includes(phase) ? '<button type="button" id="reevaluate">Recalculate corrections</button><button type="button" id="undoMark">Undo mark</button><span id="markCount" class="cap">0 corrections</span>' : '') + '</div>'
        + (geometry.evidence?.note ? '<p class="cap">' + esc(geometry.evidence.note) + '</p>' : '')
        + '<div class="row"><button type="button" id="approveStep" class="primary"' + (phase === 'ready' ? ' hidden' : '') + '>' + ({zones: 'Zones look right → review dots', points: 'Dots look right → place entrances', access: 'Access looks right → ready for import'}[phase] || '') + '</button>'
        + (phase !== 'zones' ? '<button type="button" data-back="zones">Return to zones</button>' : '') + (['access', 'ready'].includes(phase) ? '<button type="button" data-back="points">Return to dots</button>' : '') + '</div><p id="pathIssues" class="cap"></p>' : '';
    const kindOptions = kind => ['area', 'line', 'point'].map(g => '<optgroup label="' + g[0].toUpperCase() + g.slice(1) + 's">' + labels.filter(l => l.geometry === g && !(staged && phase === 'zones' && l.kind === 'grass')).map(l => '<option value="' + l.kind + '"' + (l.kind === kind ? ' selected' : '') + '>' + esc(l.label) + ' (' + l.kind + ')</option>').join('') + '</optgroup>').join('');
    const features = () => S.reviewedFeatures(geometry, edits, labels);
    const pendingFeatures = () => features().filter(f => visible(f) && f.status === 'proposed');
    body.innerHTML = '<section class="review-workspace-grid"><article class="review-map-panel"><div class="review-map-toolbar" role="toolbar" aria-label="Review map tools">'
        + '<button type="button" data-map="fit">Fit</button><button type="button" data-map="pan" aria-pressed="false">Pan</button><button type="button" data-map="select" aria-pressed="true">Select</button>'
        + '<span class="toolbar-divider"></span><span class="cap">' + esc(title) + '</span><button type="button" id="pipelineToggle" aria-expanded="false">Progress</button></div>'
        + '<div id="rmap"></div><footer class="review-map-status"><span id="rstatus" role="status">Select a feature to review its properties.</span><span>Scroll to zoom · drag to pan · drag vertices to edit</span></footer></article>'
        + '<aside class="review-controls"><button type="button" id="foldReview" aria-expanded="true" aria-controls="reviewToolBody">Hide tools</button><div id="reviewToolBody"><small class="cap">CONTROL PANEL</small>'
        + '<nav class="review-tabs" aria-label="Review panels"><button type="button" data-review-tab="review" aria-pressed="true">Review</button><button type="button" data-review-tab="features" aria-pressed="false">Justify</button><button type="button" data-review-tab="export" aria-pressed="false">Export</button></nav>'
        + '<section data-review-panel="review"><div class="note warn">Only accepted features are imported. Amber dashed outlines are pending; solid outlines are accepted.</div>' + toolbar
        + '<p>Review each feature in Justify. Choose Yes to accept it or No to reject it and continue.</p><p id="reviewCounts" class="cap"></p></section>'
        + '<section data-review-panel="features" hidden><h2>Feature properties</h2><p class="review-help">Is this feature correct? Review its properties, then choose Yes or No to submit and continue.</p><button type="button" id="acceptAll">Accept all</button><div class="review-table"><table><tbody id="rows"></tbody></table></div><h3 class="review-list-title">Still to review <span class="cap" id="reviewListCount"></span></h3><p class="review-help">Pick any feature to jump to it on the map.</p><div class="review-list" id="reviewList" role="list"></div></section>'
        + '<section data-review-panel="export" hidden><h2>Export</h2><div class="export"><section id="exportScenario"></section><section id="export3d"></section></div></section></div></aside></section>';
    const v = viewer = mapView(document.getElementById('rmap'), geometry, () => features().filter(f => reviewPanel !== 'features' || f.id === active || (visible(f) && f.status === 'proposed')), {editable: phase !== 'ready' || !staged, active: () => active, shadows: () => shadows,
        overlay: (toPx, k) => {
            let markup = outline.length ? '<polyline points="' + pts(outline.map(toPx)) + '" fill="none" stroke="#fff" stroke-width="2" vector-effect="non-scaling-stroke"/>' : '';
            for (const m of marks) { if (m.outline) { markup += '<polygon points="' + pts(m.outline.map(toPx)) + '" fill="none" stroke="' + label(m.kind).color + '" stroke-width="2" vector-effect="non-scaling-stroke"/>'; continue; } if (m.stroke) { markup += '<polyline points="' + pts(m.stroke.map(toPx)) + '" fill="none" stroke="' + (m.kind === 'shadow' ? '#bc67cf' : label(m.kind).color) + '" stroke-width="' + (2 * m.radius / geometry.scale.m_per_px) + '" stroke-linecap="round" stroke-linejoin="round" opacity=".6" pointer-events="none"/>'; continue; } const q = toPx(m.p); markup += '<circle cx="' + q[0] + '" cy="' + q[1] + '" r="' + 6 * k + '" fill="' + (m.kind === 'shadow' ? '#bc67cf' : label(m.kind).color) + '" stroke="#fff" stroke-width="2" vector-effect="non-scaling-stroke" pointer-events="none"/>'; }
            if (reviewPanel !== 'features' && phase === 'access') for (const end of S.pathEnds(features(), geometry).filter(e => e.type === 'unresolved')) { const q = toPx(end.p); markup += '<circle cx="' + q[0] + '" cy="' + q[1] + '" r="' + 12 * k + '" fill="none" stroke="#f05252" stroke-width="3" vector-effect="non-scaling-stroke" pointer-events="none"/>'; }
            return markup;
        }, hint: 'Choose a category and drag to paint zones. Select / edit lets you pan and adjust features.'});
    let saving = Promise.resolve();
    const save = (id, edit) => {
        edits = {...edits, [id]: {...edits[id], ...edit}};
        refresh();
        saving = saving.then(() => api('/api/intake/jobs/' + job.id + '/review', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({features: {[id]: edit}})}))
            .then(r => { say('Saved.'); edits = r.review.features; exports(); })
            .catch(e => { say(e.message); });
    };
    const rows = () => {
        document.getElementById('rows').innerHTML = features().filter(f => f.id === active).map(f => '<tr data-row="' + f.id + '" aria-selected="' + (f.id === active) + '" class="' + f.status + '"><td data-field="Feature"><button type="button" data-feature="' + esc(f.id) + '" aria-label="Edit ' + esc(f.name) + '">' + esc(f.name) + '</button><br><span class="cap">' + esc(f.id) + '</span>' + (phase === 'zones' && f.kind === 'building' && f.status === 'accepted' ? '<br>Locked' : '') + '</td>'
            + '<td data-field="Label"><select data-edit="kind" data-id="' + f.id + '">' + kindOptions(f.kind) + '</select>' + (f.predictedKind ? '' : '<span class="cap">no model label</span>') + '</td>'
            + '<td data-field="Name"><input data-edit="name" data-id="' + f.id + '" value="' + esc(f.name) + '"></td>'
            + '<td data-field="Approximate size">' + (f.size.area_m2 != null ? '≈ ' + f.size.area_m2 + ' m²' : f.size.length_m != null ? '≈ ' + f.size.length_m + ' m long' : '<span class="cap">point</span>') + (f.image ? '<br><span class="cap">' + esc(f.image.source || f.image.frame) + ' · scale ' + esc(f.calibration.id) + ' (' + esc(fmtLength(f.calibration.metres)) + ')</span>' : '') + '</td>'
            + '<td data-field="Height (m)">' + (f.geometry === 'area' ? '<input data-edit="height" data-id="' + f.id + '" type="number" min="0" step="0.1" placeholder="estimate" value="' + (f.height ?? '') + '">' : '<span class="cap">—</span>') + '</td>'
            + '<td data-field="Model">' + (f.predictedKind ? esc(label(f.predictedKind).label) + ' · ' + pct(f.confidence) : '—') + '</td><td data-field="Flags">' + flags(f.flags, ['conflict', 'label', 'geometry']) + (f.note ? '<br><span class="cap">' + esc(f.note) + '</span>' : '') + '</td>'
            + '<td data-field="Decision"><div class="row"><button type="button" data-status="accepted" data-id="' + f.id + '" class="' + (f.status === 'accepted' ? 'primary' : '') + '">Yes</button><button type="button" data-status="rejected" data-id="' + f.id + '"' + (f.status === 'rejected' ? ' style="border-color:#e0705f"' : '') + '>No</button></div></td></tr>').join('') || '<tr><td>All features in this step have been reviewed.</td></tr>';
    };
    function refresh() {
        const pending = pendingFeatures();
        const next = pending.find(f => f.id === active) || pending[0];
        const changed = active !== (next?.id || null);
        active = next?.id || null;
        rows(); v.redraw();
        if (changed && active && reviewPanel === 'features') focusFeature(active);
        document.getElementById('acceptAll').disabled = busy || submitting || !pending.length || (staged && phase === 'ready');
        document.getElementById('rstatus').textContent = submitting ? 'Submitting decision…' : next ? 'Review ' + next.name + ' · ' + pending.length + ' remaining' : 'All features in this step have been reviewed.';
        if (submitting) body.querySelectorAll('[data-edit], [data-status]').forEach(el => { el.disabled = true; });
        const list = features().filter(visible);
        document.getElementById('reviewListCount').textContent = pending.length ? pending.length + ' left' : '';
        document.getElementById('reviewList').innerHTML = pending.map(f => '<button type="button" role="listitem" data-feature="' + esc(f.id) + '" aria-current="' + (f.id === active) + '"><i style="background:' + label(f.kind).color + '"></i><span><b>' + esc(f.name) + '</b><small>' + esc(f.id) + ' · ' + esc(label(f.kind).label) + ' · ' + (f.size.area_m2 != null ? '≈ ' + f.size.area_m2 + ' m²' : f.size.length_m != null ? '≈ ' + f.size.length_m + ' m' : 'point') + (f.confidence != null ? ' · ' + pct(f.confidence) : '') + '</small></span></button>').join('') || '<p class="cap">Nothing left in this step.</p>';
        document.getElementById('reviewCounts').textContent = list.filter(f => f.status === 'accepted').length + ' accepted · ' + list.filter(f => f.status === 'proposed').length + ' pending · ' + list.filter(f => f.status === 'rejected').length + ' rejected';
        if (staged && phase === 'ready') body.querySelectorAll('[data-edit], [data-status], #acceptLabelled').forEach(el => { el.disabled = true; });
        if (document.getElementById('markCount')) document.getElementById('markCount').textContent = marks.length + ' correction(s)';
        if (document.getElementById('pathIssues')) { const ends = S.pathEnds(features(), geometry).filter(e => e.type === 'unresolved'); document.getElementById('pathIssues').textContent = phase === 'access' ? ends.length + ' unresolved path end(s). Interior path ends may remain; only scene-edge access points are required.' : ''; }
    }
    async function action(endpoint, value) {
        if (busy) return;
        busy = true; say('Saving and reevaluating…');
        try {
            await saving;
            await api('/api/intake/jobs/' + job.id + '/' + endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)});
            delete results.geometry; delete results.review;
            await renderPanel();
        } catch (e) { say(e.message); } finally { busy = false; }
    }
    async function exports() {
        if (!document.getElementById('exportScenario')) return;   // panel was re-rendered
        if (staged && phase !== 'ready') {
            document.getElementById('exportScenario').innerHTML = '<h3>Import after review</h3><p>Finish zones, dots and edge access review before exporting.</p>';
            document.getElementById('export3d').innerHTML = '';
            return;
        }
        const list = features(), accepted = list.filter(f => f.status === 'accepted');
        const pending = list.filter(f => f.status === 'proposed').length, rejected = list.filter(f => f.status === 'rejected').length;
        document.getElementById('exportScenario').innerHTML = '<small class="cap">Import into erfMap</small><h3>' + accepted.length + ' accepted · ' + pending + ' pending · ' + rejected + ' rejected</h3>'
            + '<p>Accepted features become an erfMap scenario (<code>fieldform-site-v1</code>) in local metres, the format Open Project already reads. GeoJSON is not used because erfMap’s GeoJSON import needs real longitude and latitude, which this imagery does not have.</p><p class="cap">Each feature keeps its job, source frames or photo, scale calibration, approximate size, model label, confidence and review status under <code>intake</code>.</p>'
            + '<div class="row"><button type="button" class="primary" id="importNow"' + (accepted.length ? '' : ' disabled') + '>Import into erfMap</button><a class="button" ' + (accepted.length ? 'href="/api/intake/jobs/' + job.id + '/scenario"' : 'aria-disabled="true" style="opacity:.45"') + '>Download scenario JSON</a></div>'
            + (payload.imports?.length ? '<h3>Imported</h3><ul>' + payload.imports.map(i => '<li><a href="/survey/?room=' + i.code + '">Project ' + i.code + '</a> · ' + i.features + ' features · ' + new Date(i.at).toLocaleString() + '</li>').join('') + '</ul>' : '');
        const panel = document.getElementById('export3d');
        if (!panel) return;
        if (!accepted.length) { panel.innerHTML = '<small class="cap">3D model export</small><h3>glTF binary (.glb)</h3><p>Accept features to see exactly what the 3D model will contain.</p>'; return; }
        try {
            const sum = await api('/api/intake/jobs/' + job.id + '/model-summary');
            if (!panel.isConnected) return;
            panel.innerHTML = '<small class="cap">3D model export</small><h3>glTF binary (.glb), metres, ' + esc(sum.label.toLowerCase()) + '</h3>'
                + '<div class="note warn"><b>Elevation: ' + (sum.elevation.status === 'terrain' ? 'supplied ground terrain.' : 'flat at 0 m.') + '</b> ' + esc(sum.elevation.reason) + '</div>'
                + '<div class="note"><b>Contours: ' + (sum.contours.available ? 'available (' + sum.contours.interval_m + ' m interval).' : 'unavailable.') + '</b> ' + esc(sum.contours.reason) + '</div>'
                + '<table><tr><th>Feature</th><th>Exported as</th><th>Height</th></tr>' + sum.features.map(f => '<tr><td>' + esc(f.name) + ' <span class="cap">' + f.kind + '</span></td><td>' + esc(f.shape) + '</td><td>' + (f.height ? f.height + ' m <span class="flag">' + esc(f.heightSource) + '</span>' : '—') + '</td></tr>').join('') + '</table>'
                + '<p><a class="button primary" href="/api/intake/jobs/' + job.id + '/model.glb">Download .glb</a></p>';
        } catch (e) { panel.innerHTML = '<div class="note err">' + esc(e.message) + '</div>'; }
    }
    const focusFeature = id => { const f = features().find(x => x.id === id); const p = f.p.map(v.toPx); const xs = p.map(q => q[0]), ys = p.map(q => q[1]); v.focus(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 2.5, v.contextSize(25 / geometry.scale.m_per_px)); };
    body.addEventListener('change', e => {
        if (busy || submitting) return;
        if (e.target.id === 'clickMode') { v.panOnly = false; body.querySelector('[data-map="pan"]').setAttribute('aria-pressed', 'false'); body.querySelector('[data-map="select"]').setAttribute('aria-pressed', 'true'); outline = []; clickMode = e.target.value; active = null; refresh(); return; }
        if (e.target.id === 'showShadows') { shadows = e.target.checked; v.redraw(); return; }
        const el = e.target.closest('[data-edit]'); if (!el) return;
        const id = el.dataset.id, field = el.dataset.edit;
        if (field === 'kind') save(id, {kind: el.value, p: null});
        if (field === 'name') save(id, {name: el.value.trim() || undefined});
        if (field === 'height') save(id, {height: el.value === '' ? null : Number(el.value)});
    });
    function showReviewPanel(name) {
        reviewPanel = name;
        if (name === 'review') v.fit();
        else if (name === 'features' && active) focusFeature(active);
        v.redraw();
        body.querySelectorAll('[data-review-panel]').forEach(el => { el.hidden = el.dataset.reviewPanel !== name; });
        body.querySelectorAll('[data-review-tab]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.reviewTab === name)));
        document.getElementById('reviewToolBody').hidden = false;
        document.getElementById('foldReview').textContent = 'Hide tools';
        document.getElementById('foldReview').setAttribute('aria-expanded', 'true');
    }
    body.addEventListener('click', e => {
        const featureButton = e.target.closest('[data-feature]');
        if (featureButton) { active = featureButton.dataset.feature; focusFeature(active); refresh(); return; }
        const tab = e.target.closest('[data-review-tab]');
        if (tab) { showReviewPanel(tab.dataset.reviewTab); return; }
        if (e.target.id === 'foldReview') {
            const tools = document.getElementById('reviewToolBody'); tools.hidden = !tools.hidden;
            e.target.textContent = tools.hidden ? 'Show tools' : 'Hide tools';
            e.target.setAttribute('aria-expanded', String(!tools.hidden)); return;
        }
        if (e.target.id === 'pipelineToggle') {
            const open = document.body.classList.toggle('show-review-stages');
            e.target.setAttribute('aria-expanded', String(open)); return;
        }
        const mapTool = e.target.closest('[data-map]');
        if (mapTool) {
            if (mapTool.dataset.map === 'fit') v.fit();
            else {
                v.panOnly = mapTool.dataset.map === 'pan'; clickMode = 'select';
                const mode = document.getElementById('clickMode'); if (mode) mode.value = 'select';
                body.querySelectorAll('[data-map="pan"], [data-map="select"]').forEach(el => el.setAttribute('aria-pressed', String(el === mapTool)));
                if (v.panOnly) active = null; refresh();
            }
            return;
        }
        if (e.target.id === 'finishOutline') { if (outline.length < 3) return say('Click at least three corners around the object.'); marks.push({kind: clickMode, p: outline[0], outline, guide: true}); outline = []; refresh(); return; }
        if (e.target.id === 'undoMark') { if (outline.length) outline.pop(); else marks.pop(); refresh(); return; }
        if (e.target.id === 'reevaluate') { if (outline.length) return say('Finish or undo the outline first.'); if (!marks.length) { say('Mark at least one correction on the scene.'); return; } action('feedback', {marks}); return; }
        if (e.target.id === 'approveStep') { if (marks.length || outline.length) { say('Reevaluate or undo your pending corrections first.'); return; } action('review-step', {}); return; }
        if (e.target.dataset.back) { action('review-step', {back: e.target.dataset.back}); return; }
        if (busy || submitting) return;
        if (e.target.id === 'acceptAll') {
            const accepted = Object.fromEntries(pendingFeatures().map(f => [f.id, {status: 'accepted'}]));
            if (!Object.keys(accepted).length || (staged && phase === 'ready')) return;
            submitting = true; refresh();
            saving = saving.then(() => api('/api/intake/jobs/' + job.id + '/review', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({features: accepted})}))
                .then(r => { edits = r.review.features; say('All pending features in this step accepted.'); exports(); })
                .catch(err => { say(err.message); })
                .finally(() => { submitting = false; refresh(); });
            return;
        }
        const s = e.target.closest('[data-status]'), r = e.target.closest('[data-row]');
        if (s) {
            const id = s.dataset.id, status = s.dataset.status;
            if (id !== active) return;
            submitting = true; refresh();
            saving = saving.then(() => api('/api/intake/jobs/' + job.id + '/review', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({features: {[id]: {status}}})}))
                .then(r => { edits = r.review.features; say('Decision saved.'); exports(); })
                .catch(err => { say(err.message); })
                .finally(() => { submitting = false; refresh(); });
            return;
        }
        if (e.target.id === 'acceptLabelled') { for (const f of features().filter(visible)) if (!f.kind.startsWith('unknown') && f.status === 'proposed') save(f.id, {status: 'accepted'}); return; }
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
    v.onClick = (p, target) => {
        if (busy || submitting || v.panOnly) return;
        if (clickMode === 'entrance') { action('entrance', {p: v.toM(p)}); return; }
        if (['building', 'bush', 'bench', 'light'].includes(clickMode)) { outline.push(v.toM(p)); refresh(); return; }
        if (clickMode !== 'select') { if (p[0] >= 0 && p[1] >= 0 && p[0] < geometry.mosaic.width && p[1] < geometry.mosaic.height) { marks.push({kind: clickMode, p: v.toM(p).map(x => +x.toFixed(3)), guide: true}); refresh(); } return; }
        const hit = target.closest?.('[data-f]'); if (hit && features().some(f => f.id === hit.dataset.f && visible(f))) { active = hit.dataset.f; showReviewPanel('features'); refresh(); document.querySelector('[data-row="' + active + '"]')?.scrollIntoView({block: 'nearest'}); }
    };
    let stroke = null;
    const bounded = p => [Math.max(0, Math.min(geometry.mosaic.width - 1, p[0])), Math.max(0, Math.min(geometry.mosaic.height - 1, p[1]))];
    v.onStrokeStart = (p, e) => {
        if (busy || v.panOnly || phase !== 'zones' || ['select', 'building'].includes(clickMode) || e.shiftKey) return false;
        if (p[0] < 0 || p[1] < 0 || p[0] >= geometry.mosaic.width || p[1] >= geometry.mosaic.height) return false;
        const q = v.toM(p);
        stroke = {guide: true, kind: clickMode, p: q, stroke: [q, q], radius: Number(document.getElementById('brushSize').value) * v.scale * geometry.scale.m_per_px / 2};
        marks.push(stroke); v.redraw(); return true;
    };
    v.onStrokeMove = p => {
        if (!stroke || stroke.stroke.length >= 2000) return;
        const q = v.toM(bounded(p)), last = stroke.stroke.at(-1);
        if (Math.hypot(q[0] - last[0], q[1] - last[1]) < stroke.radius / 4) return;
        stroke.stroke.push(q); v.redraw();
    };
    v.onStrokeEnd = p => { v.onStrokeMove(p); stroke = null; refresh(); };
    v.onStrokeCancel = () => { if (stroke) marks.pop(); stroke = null; refresh(); };
    let dragged = null;
    v.onDrag = (handle, q) => {
        if (submitting || busy) return;
        const [id, i] = handle.split(':'), f = features().find(x => x.id === id);
        const p = f.p.map(x => [...x]); p[+i] = v.toM(q).map(v => +v.toFixed(3));
        edits = {...edits, [id]: {...edits[id], p}}; dragged = {id, p}; v.redraw();
    };
    v.onDragEnd = () => { if (dragged) save(dragged.id, {p: dragged.p}); dragged = null; };
    refresh();
    exports();
}

if (params.get('job')) openJob(params.get('job')); else home();
