const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');

function createTraining({directory, readBody, launch = spawn}) {
    const root = path.resolve(directory, 'training');
    fs.mkdirSync(root, {recursive:true});
    const pointer = path.join(root, 'active.json');
    if (fs.existsSync(pointer)) {
        const active = JSON.parse(fs.readFileSync(pointer));
        if (fs.existsSync(path.join(active.model, 'config.json'))) process.env.ERFMAP_SEGFORMER_MODEL = active.model;
    }
    let job = {status:'idle'}, child;
    const local = path.join(__dirname, '..', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const python = process.env.ERFMAP_PYTHON || (fs.existsSync(local) ? local : 'python3');
    return {
        async route(req, res, url) {
            if (url.pathname !== '/api/training') return false;
            res.setHeader('Content-Type', 'application/json');
            if (req.method === 'GET') { res.end(JSON.stringify(job)); return true; }
            if (req.method !== 'POST') { res.writeHead(405); res.end('{}'); return true; }
            if (job.status === 'training') throw Object.assign(Error('Training is already running.'), {status:409});
            const dataset = await readBody(req, 256*1024*1024);
            if (dataset.format !== 'erfmap-semantic-annotations' || !Array.isArray(dataset.images) || !dataset.images.length || !Array.isArray(dataset.annotations) || !dataset.annotations.length || !Array.isArray(dataset.categories)) {
                throw Object.assign(Error('Add images and labels before training.'), {status:400});
            }
            // Recheck after upload: another request may have started a job meanwhile.
            if (job.status === 'training') throw Object.assign(Error('Training is already running.'), {status:409});
            const id = randomUUID(), folder = path.join(root,id), model = path.join(folder,'model');
            fs.mkdirSync(folder);
            const input = path.join(folder,'dataset.json');
            fs.writeFileSync(input, JSON.stringify(dataset));
            job = {id,status:'training',message:'Loading training dependencies and base model…'};
            let errors = '', pending = '';
            const failed = message => { job = {...job,status:'failed',message}; };
            try {
                child = launch(python, ['-u',path.join(__dirname,'..','worker','train_semantic.py'),input,model], {windowsHide:true});
                child.stdout.on('data', data => {
                    pending += data.toString();
                    const lines = pending.split('\n'); pending = lines.pop();
                    for (const line of lines) { try { const progress = JSON.parse(line); if (typeof progress.message === 'string') job.message = progress.message; } catch {} }
                });
                child.stderr.on('data', data => { errors = (errors + data.toString()).slice(-4000); });
                child.on('error', error => failed('Could not start trainer: ' + error.message));
                child.on('close', code => {
                    if (code !== 0 || !fs.existsSync(path.join(model,'config.json'))) { failed(errors.trim() || 'Trainer stopped before saving a model.'); return; }
                    try {
                        fs.writeFileSync(pointer+'.tmp',JSON.stringify({model}));
                        fs.renameSync(pointer+'.tmp',pointer);
                        process.env.ERFMAP_SEGFORMER_MODEL = model;
                        job = {...job,status:'complete',message:'Training complete. New analyses now use your trained model.'};
                    } catch (error) { failed('Model saved but activation failed: '+error.message); }
                });
            } catch (error) { failed(error.message); }
            res.writeHead(202); res.end(JSON.stringify(job)); return true;
        },
        stop() { child?.kill(); }
    };
}
module.exports = {createTraining};
