'use strict';
const multiplayer = (() => {
    const panel = document.querySelector('#sessionDetails'), toggle = document.querySelector('#sessionToggle');
    const overlay = document.querySelector('#crewOverlay');
    const peers = new Map(), tracks = new Map(), channels = new Map();
    const pending = [];
    let room, token, me, stream, canonical, displayed, rev=-1, seq=0, sending=false, online=false;
    let cursor=null, lastPose='', lastTargets='', frame=0;
    const copy = value => JSON.parse(JSON.stringify(value));
    const id = () => Array.from(crypto.getRandomValues(new Uint32Array(4)),v=>v.toString(16)).join('-');
    const base = () => '/api/projects/'+room+'/';
    let simulation=null, clockOffset=Date.now()-performance.now();
    let commands=Promise.resolve();
    async function post(action,data) {
        const started=performance.now();
        const response = await fetch(base()+action,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(data)});
        const result = await response.json();
        if(!response.ok) throw Error(result.error);
        if(Number.isFinite(result.serverNow)) clockOffset=result.serverNow-(started+performance.now())/2;
        return result;
    }
    function simulationTime() {
        if(!simulation) return time;
        return simulation.time + (simulation.playing ? Math.max(0,performance.now()+clockOffset-simulation.anchor)*simulation.speed/1000 : 0);
    }
    function restoreSimulation() {
        if(!simulation) return;
        playing=simulation.playing;
        speed=simulation.speed;
        showTrails=simulation.showTrails;
        time=simulationTime();
        if(playing) wakeSimulation();
    }
    function acceptSimulation(next, show=true) {
        if(!next || (simulation && next.version<simulation.version)) return;
        const changed=!simulation || next.version!==simulation.version;
        simulation=next;
        restoreSimulation();
        if(show && changed) {
            if(playing) tab='Simulate';
            render();
        }
    }
    function simulationCommand(command,value) {
        commands=commands.then(async()=>{
            if(!online) throw Error('Reconnect before changing the shared simulation.');
            const result=await post('simulation',{command,value});
            acceptSimulation(result.simulation);
        }).catch(error=>{msg=error.message;render();});
        return commands;
    }
    function status() {
        toggle.textContent = online ? '⌁ '+room+' · '+peers.size+'/4' : 'Connecting…';
        panel.replaceChildren();
        const note=document.createElement('small');
        note.textContent=online ? (pending.length?'Saving edits…':'Saved to server') : 'Reconnecting to project '+room;
        panel.append(note);
        for(const user of peers.values()) {
            const row=document.createElement('div'); row.style.color=user.color;
            row.textContent=user.name+(user.id===me.id?' (you)':''); panel.append(row);
        }
        const home=document.createElement('a'); home.href='/'; home.textContent='Return home'; panel.append(home);
    }
    toggle.onclick=e=>{e.stopPropagation(); panel.hidden=!panel.hidden;};
    function repaintSite(force=false) {
        if(!force && drag) { deferredRefresh=true; return; }
        let next=canonical;
        for(const entry of pending) next=projectChanges.apply(next,entry.patch);
        if(!force && JSON.stringify(next)===JSON.stringify(displayed)) return;
        const selected=site.features[sel]?._syncId;
        site=copy(next); displayed=copy(next);
        sel=selected?site.features.findIndex(f=>f._syncId===selected):-1;
        vertexSel=-1; history=[]; contours=site.showContours!==false; refresh();
    }
    function sendSite() {
        if(!displayed) return;
        for(const f of site.features) if(!f._syncId) f._syncId=id();
        const patch=projectChanges.diff(displayed,site);
        if(patch) {pending.push({seq:++seq,patch:copy(patch)}); displayed=copy(site); status(); flush();}
    }
    async function flush() {
        if(sending || !online || !pending.length) return;
        sending=true;
        const entry=pending[0];
        try { await post('edit',entry); }
        catch(e) { toggle.title=e.message; }
        finally {
            sending=false;
            if(pending.length) setTimeout(flush,pending[0]===entry?1000:0);
        }
    }
    function members(list) {
        peers.clear();
        for(const user of list) peers.set(user.id,user);
        for(const [key,link] of channels) if(!peers.has(key)){link.pc.close();channels.delete(key);}
        for(const key of tracks.keys()) if(!peers.has(key)) tracks.delete(key);
        for(const key of peers.keys()) if(key!==me.id && me.id<key && !channels.has(key)) connect(key,true).catch(()=>{});
        lastPose=''; status(); animate();
    }
    // ICE and offers travel through this room. Positions fall back to the server
    // for each teammate until a direct data channel has actually opened.
    async function connect(key,offer) {
        if(!window.RTCPeerConnection) return;
        if(channels.has(key)) return channels.get(key);
        const pc=new RTCPeerConnection(), link={pc,channel:null,candidates:[]};
        channels.set(key,link);
        const signal=value=>post('signal',{to:[key],value}).catch(()=>{});
        pc.onicecandidate=e=>{if(e.candidate) signal({candidate:e.candidate.toJSON()});};
        function attach(channel) {
            link.channel=channel;
            channel.onmessage=e=>{try{receive(key,JSON.parse(e.data));}catch{}};
        }
        pc.ondatachannel=e=>attach(e.channel);
        if(offer) {
            attach(pc.createDataChannel('movement',{ordered:false,maxRetransmits:0}));
            await pc.setLocalDescription(await pc.createOffer());
            await signal({description:pc.localDescription.toJSON()});
        }
        return link;
    }
    async function signal({from,value}) {
        const link=await connect(from,false); if(!link) return;
        const {pc,candidates}=link;
        if(value.description) {
            await pc.setRemoteDescription(value.description);
            for(const candidate of candidates.splice(0)) await pc.addIceCandidate(candidate);
            if(value.description.type==='offer') {
                await pc.setLocalDescription(await pc.createAnswer());
                await post('signal',{to:[from],value:{description:pc.localDescription.toJSON()}});
            }
        } else if(pc.remoteDescription) await pc.addIceCandidate(value.candidate);
        else candidates.push(value.candidate);
    }
    let deferredRefresh=false;
    function finishDrag() {
        if(deferredRefresh) {
            deferredRefresh=false;
            queueMicrotask(()=>repaintSite());
        }
    }
    document.addEventListener('pointerup',finishDrag);
    document.addEventListener('pointercancel',finishDrag);
    let movementSeq=0;
    function transmit() {
        if(!online || !me || peers.size<2) return;
        const pos=view3 ? walk.state() : cursor && {x:cursor[0],y:cursor[1]};
        const pose={x:pos?.x??0,y:pos?.y??0,is3d:view3,visible:!!pos};
        const targets=[...peers.keys()].filter(key=>key!==me.id);
        const stamp=JSON.stringify(pose), route=targets.map(k=>channels.get(k)?.channel?.readyState).join(',');
        if(stamp===lastPose && route===lastTargets) return;
        lastPose=stamp; lastTargets=route; pose.n=++movementSeq;
        const relay=[];
        for(const key of targets) {
            const channel=channels.get(key)?.channel;
            if(channel?.readyState==='open') {try{channel.send(JSON.stringify(pose));continue;}catch{}}
            relay.push(key);
        }
        if(relay.length) post('presence',{to:relay,value:pose}).catch(()=>{lastPose='';});
    }
    function users(now=performance.now()) {
        const result=[];
        for(const [key,track] of tracks) {
            const t=Math.min(1,(now-track.time)/125);
            if(peers.has(key) && track.end.visible) result.push({...peers.get(key),is3d:track.end.is3d,
                x:track.x+(track.end.x-track.x)*t,y:track.y+(track.end.y-track.y)*t});
        }
        return result;
    }
    function receive(key,pose) {
        if(!peers.has(key)||!pose||![pose.x,pose.y,pose.n].every(Number.isFinite)||pose.n<=(tracks.get(key)?.end.n??-1)) return;
        const now=performance.now(),old=users(now).find(u=>u.id===key);
        tracks.set(key,{time:now,x:old?.x??pose.x,y:old?.y??pose.y,end:pose}); animate();
    }
    function paintPlan() {
        overlay.innerHTML=users().map(u=>{
            const [x,y]=project([u.x,u.y]);
            return '<g transform="translate('+x+' '+y+')"><path d="M0 0l3 18 4-6 7-2z" fill="'+u.color+'" stroke="#202020"/><text x="13" y="17" fill="'+u.color+'" stroke="#161616" stroke-width="3" paint-order="stroke">'+esc(u.name)+(u.is3d?' · 3D':'')+'</text></g>';
        }).join('');
    }
    function animate() {
        if(frame) return;
        frame=requestAnimationFrame(function step(now){
            frame=0;
            if(view3) walk.draw(); else paintPlan();
            if([...tracks.values()].some(t=>now-t.time<125)) frame=requestAnimationFrame(step);
        });
    }
    async function start() {
        room=new URLSearchParams(location.search).get('room');
        if(!/^\d{4}$/.test(room||'')) {location.replace('/');return;}
        document.querySelector('main').inert=true;
        try {
            const joined=await post('join',{});
            token=joined.token; me=joined.user; seq=joined.seq;
            acceptSimulation(joined.simulation,false);
            stream=new EventSource(base()+'events?token='+token);
            const on=(type,fn)=>stream.addEventListener(type,e=>fn(JSON.parse(e.data)));
            on('snapshot',s=>{
                canonical=s.site;rev=s.revision; while(pending.length && pending[0].seq<=s.seq) pending.shift();
                online=true;acceptSimulation(s.simulation,false);if(playing)tab='Simulate';repaintSite(true);document.querySelector('main').inert=false;status();flush();
            });
            on('edit',e=>{
                if(e.revision<=rev) return;
                canonical=projectChanges.apply(canonical,e.patch); rev=e.revision;
                if(e.author===me.id && pending[0]?.seq===e.seq) pending.shift();
                acceptSimulation(e.simulation,false);repaintSite();restoreSimulation();render();status();flush();
            });
            on('simulation',acceptSimulation); on('roster',members); on('presence',p=>receive(p.from,p.value)); on('signal',p=>signal(p).catch(()=>{}));
            stream.onerror=()=>{online=false;status();if(stream.readyState===EventSource.CLOSED){toggle.textContent='Rejoin '+room;toggle.onclick=()=>location.reload();document.querySelector('main').inert=false;}};
            setInterval(transmit,125);
            setInterval(()=>{
                if(online) post('simulation',{command:'sync'}).then(result=>acceptSimulation(result.simulation)).catch(()=>{});
            },10000);
        } catch(e) {sessionStorage.setItem('erfmap-message',e.message);location.replace('/');}
    }
    document.addEventListener('visibilitychange',()=>{
        if(!document.hidden && simulation) {restoreSimulation();render();}
    });
    window.addEventListener('DOMContentLoaded',start);
    window.addEventListener('pagehide',()=>{if(token){stream?.close();navigator.sendBeacon(base()+'leave?token='+token,'{}');}});
    document.querySelector('#map').addEventListener('pointerleave',()=>{cursor=null;});
    return {sendSite,paintPlan,users,simulationCommand,restoreSimulation,simulationTime,updatePresence(p){cursor=p;}};
})();
