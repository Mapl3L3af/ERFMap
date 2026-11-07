// Video intake jobs: storage, the stage runner and the /api/intake routes.
// Each job lives in <data>/intake/<id>/. The original upload is kept untouched
// under original/, and every stage writes its outputs to stages/<stage>/ so a
// stage can be retried, and audited, without rerunning the ones before it.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {kinds, restore} = require('../erfmap-survey/model');
const shared = require('../erfmap-intake/shared');

const STAGES = shared.STAGES;
const WORKER = path.join(__dirname, '..', 'worker', 'erfmap_worker.py');
const VIDEO = /\.(mp4|mov|m4v|avi|mkv|webm|mts|m2ts|3gp)$/i;
const PHOTO = /\.(jpe?g|png|tiff?|webp|bmp)$/i;
const MAX_PHOTOS = 200;
const MAX_UPLOAD = 8 * 1024 ** 3;
const failure = (status, message) => Object.assign(Error(message), {status});

function labelMap() {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'label-map.json'), 'utf8')).map || {}; }
    catch { return {}; }
}
function labels() {
    return {labels: Object.entries(kinds).map(([kind, [label, color, geometry]]) => ({kind, label, color, geometry})), map: labelMap()};
}

function createIntake({directory, createProject, readBody}) {
    const root = path.join(directory, 'intake');
    fs.mkdirSync(root, {recursive: true});
    const jobs = new Map(), listeners = new Map(), children = new Map();
    const python = process.env.ERFMAP_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    let capabilityCache = null;

    const dir = id => path.join(root, id);
    const write = (file, data) => { fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 1)); fs.renameSync(file + '.tmp', file); };
    const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
    const result = (id, stage) => readJson(path.join(dir(id), 'stages', stage, 'result.json'));

    function load(id) {
        if (!/^[a-f0-9]{12}$/.test(id)) throw failure(404, 'No intake job has that ID.');
        if (!jobs.has(id)) {
            const job = readJson(path.join(dir(id), 'job.json'));
            if (!job) throw failure(404, 'No intake job has that ID.');
            // A stage that was running when the server stopped did not finish.
            for (const stage of Object.values(job.stages)) if (stage.status === 'processing') {
                Object.assign(stage, {status: 'failed', error: 'Interrupted when the server stopped. Retry this stage.', finishedAt: new Date().toISOString()});
            }
            jobs.set(id, job);
        }
        return jobs.get(id);
    }
    function save(job) {
        job.updatedAt = new Date().toISOString();
        write(path.join(dir(job.id), 'job.json'), job);
        broadcast(job);
    }
    function publicJob(job) {
        return {...job, review: undefined, reviewCount: Object.keys(job.review?.features || {}).length};
    }
    function broadcast(job) {
        for (const res of listeners.get(job.id) || []) res.write('event: job\ndata: ' + JSON.stringify(publicJob(job)) + '\n\n');
    }

    function capabilities() {
        if (capabilityCache && Date.now() - capabilityCache.at < 30000) return Promise.resolve(capabilityCache.value);
        return new Promise(resolve => {
            let out = '', err = '';
            const child = spawn(python, [WORKER, 'capabilities'], {windowsHide: true});
            child.stdout.on('data', d => out += d);
            child.stderr.on('data', d => err += d);
            child.on('error', e => resolve({python: null, error: 'Python was not found (' + python + '): ' + e.message + '. Install Python 3.10+ or set ERFMAP_PYTHON.'}));
            child.on('close', code => {
                let value;
                try { value = {...JSON.parse(out), command: python}; }
                catch { value = {python: null, error: 'The worker could not start: ' + (err.trim().slice(-400) || 'exit ' + code)}; }
                capabilityCache = {at: Date.now(), value};
                resolve(value);
            });
        });
    }

    // ------------------------------------------------------------ the runner
    // Stages run in order. A stage whose status is complete or needs_review lets
    // the next one start. "unavailable" stops the pipeline unless the stage is
    // optional (classification), in which case later stages proceed without labels.
    function reset(job, fromStage) {
        const start = STAGES.findIndex(s => s.id === fromStage);
        for (const stage of STAGES.slice(start)) {
            if (stage.worker) fs.rmSync(path.join(dir(job.id), 'stages', stage.id), {recursive: true, force: true});
            const previous = job.stages[stage.id] || {};
            job.stages[stage.id] = {status: 'queued', progress: 0, attempts: previous.attempts || 0};
        }
    }
    function passable(stage, state) {
        return ['complete', 'needs_review'].includes(state.status) || (stage.optional && state.status === 'unavailable');
    }
    function advance(job) {
        if (children.has(job.id) || job.started === false) return;
        for (const stage of STAGES) {
            const state = job.stages[stage.id];
            if (stage.id === 'review') {
                const geometry = result(job.id, 'geometry');
                const ready = geometry?.features?.length;
                const imported = job.imports?.length;
                const status = ready ? (imported ? 'complete' : 'needs_review') : 'blocked';
                if (state.status !== status) { Object.assign(state, {status, progress: ready ? 1 : 0, summary: ready ? (imported ? 'Imported ' + job.imports.length + ' time(s)' : geometry.features.length + ' proposed features awaiting review') : 'Waiting for map geometry'}); save(job); }
                return;
            }
            if (state.status === 'queued' || state.status === 'blocked') return runStage(job, stage);
            if (!passable(stage, state)) {
                // Everything after a failed or unavailable stage waits for it.
                let changed = false;
                for (const later of STAGES.slice(STAGES.indexOf(stage) + 1)) {
                    if (job.stages[later.id].status !== 'blocked') { job.stages[later.id] = {...job.stages[later.id], status: 'blocked', progress: 0}; changed = true; }
                }
                if (changed) save(job);
                return;
            }
            if (stage.id === 'geometry' && !result(job.id, 'geometry')?.features?.length) {
                const review = job.stages.review;
                if (review.status !== 'blocked') { Object.assign(review, {status: 'blocked', summary: 'Waiting for map geometry'}); save(job); }
                return;
            }
        }
    }
    function runStage(job, stage) {
        if (stage.id === 'geometry') write(path.join(dir(job.id), 'calibration.json'), job.calibration || {markers: []});
        const state = job.stages[stage.id];
        Object.assign(state, {status: 'processing', progress: 0, message: 'Starting', error: undefined, startedAt: new Date().toISOString(), finishedAt: undefined, attempts: (state.attempts || 0) + 1});
        save(job);
        let child;
        try { child = spawn(python, [WORKER, 'run', stage.id, dir(job.id)], {windowsHide: true, env: process.env}); }
        catch (e) { return finish(job, stage, {status: 'unavailable', reason: 'Could not start Python: ' + e.message}); }
        children.set(job.id, child);
        let buffer = '', stderr = '', last = null, settled = false;
        const done = outcome => { if (settled) return; settled = true; children.delete(job.id); finish(job, stage, outcome); };
        child.stdout.on('data', chunk => {
            buffer += chunk;
            let line;
            while ((line = buffer.indexOf('\n')) >= 0) {
                const text = buffer.slice(0, line); buffer = buffer.slice(line + 1);
                try {
                    const event = JSON.parse(text);
                    if (event.event === 'progress') { Object.assign(state, {progress: event.value, message: event.message}); broadcast(job); }
                    if (event.event === 'result') last = event;
                } catch { /* ignore stray output */ }
            }
        });
        child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
        child.on('error', e => done({status: 'unavailable', reason: e.code === 'ENOENT' ? 'Python was not found (' + python + '). Install Python 3.10+ with worker/requirements.txt, or set ERFMAP_PYTHON.' : e.message}));
        child.on('close', code => {
            if (code === 0 && last) return done(result(job.id, stage.id) || last);
            const lines = stderr.trim().split('\n');
            const message = lines.filter(l => /Error|error:/.test(l)).pop() || lines.pop() || 'Exited with code ' + code;
            done({status: 'failed', error: message.slice(0, 500), log: stderr.slice(-2000)});
        });
    }
    function finish(job, stage, outcome) {
        const state = job.stages[stage.id];
        Object.assign(state, {
            status: outcome.status, progress: outcome.status === 'failed' ? state.progress : 1, message: undefined,
            summary: outcome.summary, warnings: outcome.warnings || [], reason: outcome.reason, error: outcome.error, log: outcome.log,
            finishedAt: new Date().toISOString(),
        });
        if (stage.id === 'probe' && outcome.metadata) job.metadata = outcome.metadata;
        if (stage.id === 'markers' && outcome.status !== 'failed') {
            // Seed calibration with the detected candidates, unconfirmed. Keep any
            // markers the reviewer added by hand.
            const manual = (job.calibration?.markers || []).filter(m => m.manual);
            job.calibration = {markerSideM: job.calibration?.markerSideM || 0.3048, references: [],
                markers: [...(outcome.markers || []).map(m => ({id: m.id, corners: m.corners, confirmed: false, flags: m.flags, frames: m.frames.length})), ...manual]};
        }
        save(job);
        advance(job);
    }

    // ------------------------------------------------------------ exports
    function reviewed(job) {
        const geometry = result(job.id, 'geometry');
        if (!geometry?.features?.length) throw failure(409, 'Map geometry is not ready yet.');
        return shared.reviewedFeatures(geometry, job.review?.features || {}, labels().labels);
    }
    function scenario(job) {
        const geometry = result(job.id, 'geometry');
        const site = shared.buildSite({job, geometry, features: reviewed(job), labels: labels().labels});
        if (!site.features.length) throw failure(409, 'Accept at least one feature before exporting.');
        return {format: 'fieldform-site-v1', site: restore(site)};
    }

    // ------------------------------------------------------------ routes
    const cleanName = raw => path.basename(String(raw || '')).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    async function receive(req, target, limit) {
        let size = 0;
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(target);
            req.on('data', chunk => { size += chunk.length; if (size > limit) { req.destroy(); reject(failure(413, 'That file is too large.')); } });
            req.on('error', reject);
            out.on('error', reject);
            out.on('finish', resolve);
            req.pipe(out);
        });
        if (!size) throw failure(400, 'The upload was empty.');
        return size;
    }
    // One video, or one or more photos. Photo jobs are created with the first
    // photo and ?defer=1, the rest are added to /originals, then /start runs them.
    async function upload(req, url) {
        const name = cleanName(url.searchParams.get('name') || 'video.mp4');
        const media = PHOTO.test(name) ? 'photos' : VIDEO.test(name) ? 'video' : null;
        if (!media) throw failure(415, 'Choose a video (MP4, MOV, MKV, AVI, WebM) or photos (JPEG, PNG, TIFF, WebP).');
        const id = randomUUID().replace(/-/g, '').slice(0, 12);
        fs.mkdirSync(path.join(dir(id), 'original'), {recursive: true});
        const target = path.join(dir(id), 'original', name);
        let size;
        try { size = await receive(req, target, MAX_UPLOAD); }
        catch (e) { fs.rmSync(dir(id), {recursive: true, force: true}); throw e; }
        const original = {name, path: 'original/' + name, size, type: req.headers['content-type'] || null};
        const job = {id, name, media, createdAt: new Date().toISOString(), original, originals: [original], started: media === 'video' || url.searchParams.get('defer') !== '1',
            stages: Object.fromEntries(STAGES.map(s => [s.id, {status: 'queued', progress: 0, attempts: 0}])), calibration: {markers: [], references: [], markerSideM: 0.3048}, review: {features: {}}, imports: []};
        write(path.join(dir(id), 'labels.json'), labels());
        jobs.set(id, job);
        save(job);
        if (job.started) advance(job);
        return publicJob(job);
    }
    async function addPhoto(job, req, url) {
        if (job.media !== 'photos' || job.started) throw failure(409, 'Photos can only be added to a photo job before it starts.');
        if (job.originals.length >= MAX_PHOTOS) throw failure(413, 'Use at most ' + MAX_PHOTOS + ' photos.');
        let name = cleanName(url.searchParams.get('name'));
        if (!PHOTO.test(name)) throw failure(415, 'Only photos can be added to a photo job.');
        while (job.originals.some(o => o.name === name)) name = name.replace(/(\.[^.]+)$/, '_1$1');
        const size = await receive(req, path.join(dir(job.id), 'original', name), MAX_UPLOAD);
        job.originals.push({name, path: 'original/' + name, size, type: req.headers['content-type'] || null});
        save(job);
        return publicJob(job);
    }

    function list() {
        return fs.readdirSync(root).filter(id => /^[a-f0-9]{12}$/.test(id)).map(id => { try { return load(id); } catch { return null; } })
            .filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30)
            .map(job => ({id: job.id, name: job.name, createdAt: job.createdAt, stages: Object.fromEntries(Object.entries(job.stages).map(([k, v]) => [k, v.status]))}));
    }

    function serveFile(res, job, relative) {
        const base = path.resolve(dir(job.id));
        const target = path.resolve(base, relative);
        if (!target.startsWith(base + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) throw failure(404, 'File not found.');
        const type = {jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', json: 'application/json', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm'}[target.split('.').pop().toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'private, max-age=60'});
        fs.createReadStream(target).pipe(res);
    }

    async function route(req, res, url) {
        if (!url.pathname.startsWith('/api/intake/')) return false;
        const json = (data, status = 200) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(data)); };
        const parts = url.pathname.split('/').slice(3).map(decodeURIComponent);   // after /api/intake/
        if (parts[0] === 'capabilities' && req.method === 'GET') return json(await capabilities()), true;
        if (parts[0] === 'labels' && req.method === 'GET') return json(labels()), true;
        if (parts[0] !== 'jobs') throw failure(404, 'Unknown intake address.');
        if (parts.length === 1) {
            if (req.method === 'GET') return json(list()), true;
            if (req.method === 'POST') return json(await upload(req, url), 201), true;
            throw failure(405, 'Use GET or POST.');
        }
        const job = load(parts[1]), action = parts[2];
        if (!action && req.method === 'GET') return json(publicJob(job)), true;
        if (action === 'events' && req.method === 'GET') {
            res.writeHead(200, {'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no'});
            res.write('event: job\ndata: ' + JSON.stringify(publicJob(job)) + '\n\n');
            if (!listeners.has(job.id)) listeners.set(job.id, new Set());
            listeners.get(job.id).add(res);
            const beat = setInterval(() => res.write(': live\n\n'), 15000);
            res.on('close', () => { clearInterval(beat); listeners.get(job.id)?.delete(res); });
            return true;
        }
        if (action === 'stages' && parts[3] && req.method === 'GET' && !parts[4]) {
            if (!STAGES.some(s => s.id === parts[3])) throw failure(404, 'Unknown stage.');
            if (parts[3] === 'review') return json({calibration: job.calibration, review: job.review, imports: job.imports}), true;
            return json(result(job.id, parts[3]) || {status: job.stages[parts[3]].status}), true;
        }
        if (action === 'stages' && parts[4] === 'retry' && req.method === 'POST') {
            const stage = STAGES.find(s => s.id === parts[3]);
            if (!stage || !stage.worker) throw failure(400, 'That stage cannot be rerun.');
            if (children.has(job.id)) throw failure(409, 'A stage is still running. Wait for it to finish.');
            const before = STAGES.slice(0, STAGES.indexOf(stage));
            if (before.some(s => !passable(s, job.stages[s.id]))) throw failure(409, 'Earlier stages must finish first.');
            reset(job, stage.id);
            save(job); advance(job);
            return json(publicJob(job)), true;
        }
        if (action === 'originals' && req.method === 'POST') return json(await addPhoto(job, req, url), 201), true;
        if (action === 'start' && req.method === 'POST') {
            if (!job.started) {
                job.started = true;
                if (job.media === 'photos') job.name = job.originals.length === 1 ? job.original.name : job.originals.length + ' photos (' + job.original.name + ', …)';
                save(job); advance(job);
            }
            return json(publicJob(job)), true;
        }
        if (action === 'files' && req.method === 'GET') return serveFile(res, job, parts.slice(3).join('/')), true;
        if (action === 'calibration' && req.method === 'POST') {
            const input = await readBody(req);
            if (!Array.isArray(input.markers)) throw failure(400, 'Send a markers list.');
            const references = Array.isArray(input.references) ? input.references : [];
            const point = q => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite);
            if (!references.every(r => typeof r.id === 'string' && point(r.a) && point(r.b) && Number.isFinite(r.metres) && r.metres > 0 && r.metres < 10000 && Math.hypot(r.a[0] - r.b[0], r.a[1] - r.b[1]) > 2))
                throw failure(400, 'Each measured distance needs two different points and a length in metres.');
            const side = input.markerSideM ?? 0.3048;
            if (!(Number.isFinite(side) && side >= 0.05 && side <= 50)) throw failure(400, 'Marker size must be between 5 cm and 50 m.');
            const valid = input.markers.every(m => typeof m.id === 'string' && Array.isArray(m.corners) && m.corners.length === 4 && m.corners.every(c => Array.isArray(c) && c.length === 2 && c.every(Number.isFinite)));
            if (!valid) throw failure(400, 'Each marker needs an ID and four corner points.');
            if (job.stages.geometry.status === 'processing') throw failure(409, 'Map geometry is being built. Try again in a moment.');
            job.calibration = {markerSideM: side,
                markers: input.markers.map(m => ({id: m.id.slice(0, 20), corners: m.corners, confirmed: m.confirmed === true, manual: m.manual === true, flags: Array.isArray(m.flags) ? m.flags.map(String) : [], frames: m.frames})),
                references: references.map(r => ({id: r.id.slice(0, 20), a: r.a, b: r.b, metres: r.metres, label: String(r.label || '').slice(0, 80), confirmed: r.confirmed !== false, ...(typeof r.frame === 'string' ? {frame: r.frame.slice(0, 20)} : {})}))};
            const confirmed = job.calibration.markers.filter(m => m.confirmed).length + job.calibration.references.filter(r => r.confirmed).length;
            if (passable(STAGES.find(s => s.id === 'markers'), job.stages.markers)) {
                Object.assign(job.stages.markers, confirmed
                    ? {status: 'complete', summary: job.calibration.references.some(r => r.frame)
                        ? new Set(job.calibration.references.filter(r => r.frame).map(r => r.frame)).size + ' photo(s) calibrated with a measured distance'
                        : confirmed + ' scale reference(s) confirmed: ' + job.calibration.markers.filter(m => m.confirmed).length + ' marker(s), ' + job.calibration.references.length + ' measured distance(s)'}
                    : {status: 'needs_review', summary: 'Nothing confirmed. Confirm a marker or add a measured distance to scale the map.'});
            }
            if (passable(STAGES.find(s => s.id === 'merging'), job.stages.merging)) reset(job, 'geometry');
            save(job); advance(job);
            return json(publicJob(job)), true;
        }
        if (action === 'review' && req.method === 'POST') {
            const input = await readBody(req);
            const geometry = result(job.id, 'geometry');
            const ids = new Set((geometry?.features || []).map(f => f.id));
            const next = {...(job.review?.features || {})};
            for (const [id, edit] of Object.entries(input.features || {})) {
                if (!ids.has(id)) continue;
                if (edit.kind !== undefined && !Object.hasOwn(kinds, edit.kind)) throw failure(400, 'Unknown feature kind ' + edit.kind + '.');
                if (edit.status !== undefined && !['proposed', 'accepted', 'rejected'].includes(edit.status)) throw failure(400, 'Unknown review status.');
                if (edit.height !== undefined && edit.height !== null && !(Number.isFinite(edit.height) && edit.height > 0 && edit.height < 500)) throw failure(400, 'Height must be between 0 and 500 m.');
                if (edit.p !== undefined && edit.p !== null && !(Array.isArray(edit.p) && edit.p.every(q => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite)))) throw failure(400, 'Invalid geometry.');
                next[id] = {...next[id], ...edit, name: edit.name === undefined ? next[id]?.name : String(edit.name).slice(0, 120), reviewedAt: new Date().toISOString()};
            }
            job.review = {features: next};
            save(job);
            return json({review: job.review}), true;
        }
        if (action === 'scenario' && req.method === 'GET') {
            res.writeHead(200, {'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="drone-intake-' + job.id + '.json"'});
            res.end(JSON.stringify(scenario(job), null, 2));
            return true;
        }
        if (action === 'import' && req.method === 'POST') {
            const {site} = scenario(job);
            const code = createProject(site);
            job.imports = [...(job.imports || []), {code, at: new Date().toISOString(), features: site.features.length}];
            job.stages.review = {...job.stages.review, status: 'queued'};
            save(job); advance(job);
            return json({code, features: site.features.length}), true;
        }
        if (action === 'model-summary' && req.method === 'GET') {
            const {site} = scenario(job);
            return json(shared.modelSummary(site, labels().labels)), true;
        }
        if (action === 'model.glb' && req.method === 'GET') {
            const {site} = scenario(job);
            const glb = shared.buildGlb(site, labels().labels);
            res.writeHead(200, {'Content-Type': 'model/gltf-binary', 'Content-Disposition': 'attachment; filename="drone-intake-' + job.id + '.glb"'});
            res.end(Buffer.from(glb));
            return true;
        }
        throw failure(404, 'Unknown intake address.');
    }

    return {route, capabilities};
}

module.exports = {createIntake};
