// One process serves both screens, owns room membership and saves each accepted edit.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID, randomInt} = require('node:crypto');
const {demo, restore, importSurvey} = require('./erfmap-survey/model');
const changes = require('./erfmap-survey/changes');
const {createIntake} = require('./intake/jobs');
const directory = process.env.ERFMAP_DATA || path.join(__dirname, '.erfmap-data');
fs.mkdirSync(directory, {recursive:true});
const rooms = new Map();
const names = ['Bashful Bear','Curious Otter','Dapper Fox','Sunny Gecko'];
const colors = ['#ff806b','#61c9b1','#bb90ff','#f0bd55'];
const failure = (status, message) => Object.assign(Error(message), {status});
const file = code => path.join(directory, code + '.json');
function save(code, state) {
    fs.writeFileSync(file(code) + '.tmp', JSON.stringify(state));
    fs.renameSync(file(code) + '.tmp', file(code));
}
function roomFor(code) {
    if (!rooms.has(code)) {
        if (!fs.existsSync(file(code))) throw failure(404,'No project has that code.');
        rooms.set(code, {...JSON.parse(fs.readFileSync(file(code))), members:new Map(), simulation:{playing:false,time:0,speed:3,showTrails:true,anchor:Date.now(),version:0}});
    }
    return rooms.get(code);
}
function emit(member, type, data) {
    member.stream?.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n');
}
function roster(room) {
    const list = [...room.members.values()].map(m => m.user);
    for (const member of room.members.values()) emit(member,'roster',list);
}
function drop(room, member) {
    clearTimeout(member.timer);
    room.members.delete(member.token);
    member.stream?.end();
    roster(room);
}
function lease(room, member) {
    clearTimeout(member.timer);
    member.timer = setTimeout(() => drop(room,member),20000);
}
async function body(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 16*1024*1024) throw failure(413,'Project exceeds 16 MB.');
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
    catch { throw failure(400,'Choose a valid JSON file.'); }
}
function createProject(site) {
    site.features.forEach(f => f._syncId = randomUUID());
    const start = randomInt(10000);
    for(let i=0;i<10000;i++) {
        const code = String((start+i)%10000).padStart(4,'0');
        if (!fs.existsSync(file(code))) { save(code,{site,revision:0}); return code; }
    }
    throw failure(503,'No room codes available.');
}
const intake = createIntake({directory, createProject, readBody: body});
async function route(req,res) {
    const url = new URL(req.url,'http://localhost');
    const json = data => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(data)); };
    if (!url.pathname.startsWith('/api/')) {
        const survey = /^\/(survey|erfmap-survey)(\/|$)/.test(url.pathname);
        const videoIntake = /^\/(intake|erfmap-intake)(\/|$)/.test(url.pathname);
        if (/^\/(survey|erfmap-survey|erfmap-frontpage|intake|erfmap-intake)$/.test(url.pathname)) {
            res.writeHead(302,{Location:url.pathname+'/'+url.search}); return res.end();
        }
        const name = url.pathname.replace(/^\/(?:survey\/|erfmap-survey\/|erfmap-frontpage\/|intake\/|erfmap-intake\/)?/,'') || 'index.html';
        if (!/^[a-z0-9-]+\.(html|js|svg|css)$/.test(name)) throw failure(404,'Page unavailable.');
        const target = path.join(__dirname,survey?'erfmap-survey':videoIntake?'erfmap-intake':'erfmap-frontpage',name);
        if (!fs.existsSync(target)) throw failure(404,'Page unavailable.');
        res.setHeader('Content-Type', {html:'text/html',js:'text/javascript',css:'text/css',svg:'image/svg+xml'}[name.split('.').pop()]);
        return fs.createReadStream(target).pipe(res);
    }
    res.setHeader('Cache-Control','no-store');
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw failure(403,'Use the project server to join.');
    if (req.method === 'POST' && url.pathname === '/api/projects') {
        const input = await body(req);
        let site;
        try { site = input.demo === true && Object.keys(input).length === 1 ? demo() : input.type === 'FeatureCollection' ? importSurvey(input) : restore(input.site || input); }
        catch (e) { throw failure(400,e.message || 'Invalid survey.'); }
        return json({code:createProject(site)});
    }
    if (await intake.route(req,res,url)) return;
    const match = url.pathname.match(/^\/api\/projects\/(\d{4})\/(join|events|edit|presence|signal|leave|simulation)$/);
    if (!match) throw failure(404,'Unknown project address.');
    const [,code,action] = match, room = roomFor(code);
    if (action === 'join' && req.method === 'POST') {
        const input = await body(req);
        let member = room.members.get(input.token);
        if (!member) {
            if (room.members.size >= 4) throw failure(409,'All four places are taken.');
            const slot = names.findIndex(name => ![...room.members.values()].some(m => m.user.name === name));
            member = {token:randomUUID(),seq:0,user:{id:randomUUID(),name:names[slot],color:colors[slot]}};
            room.members.set(member.token,member); lease(room,member);
        }
        return json({token:member.token,user:member.user,seq:member.seq,simulation:room.simulation,serverNow:Date.now()});
    }
    const member = room.members.get(req.headers.authorization?.replace(/^Bearer /,'') || url.searchParams.get('token'));
    if (!member) throw failure(403,'Your place expired. Rejoin the project.');
    if (action === 'events' && req.method === 'GET') {
        member.stream?.end(); clearTimeout(member.timer);
        res.writeHead(200,{'Content-Type':'text/event-stream','X-Accel-Buffering':'no'});
        member.stream=res;
        emit(member,'snapshot',{site:room.site,revision:room.revision,seq:member.seq,simulation:room.simulation,serverNow:Date.now()});
        roster(room);
        const beat=setInterval(()=>res.write(': live\n\n'),10000);
        res.on('close',()=>{clearInterval(beat); if(member.stream===res){member.stream=null; if(room.members.has(member.token)) lease(room,member);}});
        return;
    }
    if(req.method!=='POST') throw failure(405,'Use POST.');
    const data=await body(req);
    if(action==='edit') {
        if(data.seq === member.seq) return json({ok:true});
        if(data.seq !== member.seq+1) throw failure(409,'Edit sequence changed. Rejoin the project.');
        let site;
        try {site=restore(changes.apply(room.site,data.patch));} catch {throw failure(400,'Invalid project edit.');}
        const revision=room.revision+1;
        save(code,{site,revision});
        Object.assign(room,{site,revision}); member.seq=data.seq;
        if (data.patch.put.length || data.patch.remove.length ||
            ['pedestrians','environment','samples','w','h'].some(key => Object.hasOwn(data.patch.meta,key))) {
            room.simulation = {...room.simulation,playing:false,time:0,anchor:Date.now(),version:room.simulation.version+1};
        }
        for(const m of room.members.values()) emit(m,'edit',{patch:data.patch,revision,author:member.user.id,seq:data.seq,simulation:room.simulation});
    } else if(action==='simulation') {
        const current = room.simulation, now = Date.now();
        if (data.command === 'sync') return json({simulation:current,serverNow:now});
        if (!['run','pause','reset','speed','trails'].includes(data.command)) throw failure(400,'Unknown simulation command.');
        if (data.command === 'speed' && (!Number.isFinite(data.value) || data.value<1 || data.value>16)) throw failure(400,'Choose a speed from 1 to 16.');
        if (data.command === 'trails' && typeof data.value !== 'boolean') throw failure(400,'Invalid trails setting.');
        const next = {...current, time:current.time+(current.playing?(now-current.anchor)*current.speed/1000:0), anchor:now,version:current.version+1};
        if (data.command === 'run') next.playing=true;
        if (data.command === 'pause') next.playing=false;
        if (data.command === 'reset') {next.playing=false;next.time=0;}
        if (data.command === 'speed') next.speed=data.value;
        if (data.command === 'trails') next.showTrails=data.value;
        room.simulation=next;
        for (const m of room.members.values()) emit(m,'simulation',next);
        return json({simulation:next,serverNow:now});
    } else if(action==='presence' || action==='signal') {
        for(const m of room.members.values()) if(m!==member && data.to?.includes(m.user.id)) emit(m,action,{from:member.user.id,value:data.value});
    } else if(action==='leave') drop(room,member);
    else throw failure(405,'Unsupported operation.');
    json({ok:true});
}
const server=http.createServer((req,res)=>route(req,res).catch(e=>{
    res.writeHead(e.status||500,{'Content-Type':'application/json'});
    res.end(JSON.stringify({error:e.status?e.message:'Could not save or load this project.'}));
}));
server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
        console.error('Port ' + (process.env.PORT || 3000) + ' is already in use.');
        console.error('If erfMap is already running, open http://localhost:' + (process.env.PORT || 3000));
        console.error('Otherwise stop the existing server, or run PORT=3001 npm start.');
    } else {
        console.error('Could not start erfMap: ' + error.message);
    }
    process.exitCode = 1;
});
server.listen(Number(process.env.PORT || 3000),process.env.HOST || '0.0.0.0',()=>{
    const port = server.address().port;
    console.log('Open erfMap at http://localhost:' + port);
    if (server.address().address === '0.0.0.0') {
        for (const addresses of Object.values(require('node:os').networkInterfaces()))
            for (const address of addresses || []) if (address.family === 'IPv4' && !address.internal)
                console.log('On the same network: http://' + address.address + ':' + port);
    }
});
