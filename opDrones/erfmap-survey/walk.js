// A low-resolution perspective renderer. World coordinates are east, south, up.
const walk = (() => {
    const canvas = document.getElementById('walk'), keys = new Set();
    let gl, program, buffer, texture, vertexCount=0, camera, scene, look, activeFrame=0, previous=0;
    let vertices=[], triangles=null, surface;
    let heatTexture, uploadedHeat, weatherFrame=0;
    const style='realistic';
    document.body.dataset.worldStyle=style;
    const colors = {grass:'#9cc76e',shrub:'#53a653',soil:'#c59b68',water:'#4ab8df',pavement:'#c6bdac',road:'#676a7d',canopy:'#529951',unknown:'#9993aa'};
    function initialize(){
        gl=canvas.getContext('webgl',{antialias:false,alpha:true});
        if(!gl) return false;
        function shader(type,src){
            const sh=gl.createShader(type);gl.shaderSource(sh,src);gl.compileShader(sh);
            if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(sh));return sh;
        }
        program=gl.createProgram();
        gl.attachShader(program,shader(gl.VERTEX_SHADER,`
            attribute vec3 pos,col; attribute float ground;
            uniform vec3 eye;uniform vec2 turn,tilt,extent;uniform float aspect;
            varying vec3 tint;varying vec2 uv;varying float textured,depth;
            void main(){vec3 p=pos-eye; float ahead=dot(p.xy,turn);
            float side=dot(p.xy,vec2(-turn.y,turn.x));
            float up=p.z*tilt.x-ahead*tilt.y;float d=ahead*tilt.x+p.z*tilt.y;
            gl_Position=vec4(side*1.42/aspect,up*1.42,d*1.00002-.12,d);
            tint=col;uv=pos.xy/extent;textured=ground;depth=d;}`));
        gl.attachShader(program,shader(gl.FRAGMENT_SHADER,`
            precision mediump float;varying vec3 tint;varying vec2 uv;varying float textured,depth;
            uniform sampler2D land,heat;uniform float fog,heatOn,visualStyle,wet;uniform vec3 ambient,skyTint;
            void main(){vec3 rgb=tint*mix(vec3(1.),texture2D(land,uv).rgb,max(textured,0.));
            rgb*=ambient*mix(1.,wet,max(textured,0.));
            if(visualStyle<.5){float grey=dot(rgb,vec3(.299,.587,.114));rgb=vec3(grey);}
            if(heatOn>.5 && textured>=0.){vec4 h=texture2D(heat,uv);rgb=mix(rgb,h.rgb,h.a*.94); }
            gl_FragColor=vec4(mix(rgb,visualStyle<.5?vec3(dot(skyTint,vec3(.299,.587,.114))):skyTint,smoothstep(fog*.45,fog*1.6,depth)*.65),1.);}`));
        gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
        gl.useProgram(program);buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
        for(const [name,n,offset] of [['pos',3,0],['col',3,12],['ground',1,24]]){
            const a=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,n,gl.FLOAT,false,28,offset);
        }
        texture=gl.createTexture();
        heatTexture=gl.createTexture();
        gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,heatTexture);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));
        for(const axis of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,axis,gl.CLAMP_TO_EDGE);
        for(const filter of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,filter,gl.LINEAR);
        gl.uniform1i(gl.getUniformLocation(program,'heat'),1);gl.activeTexture(gl.TEXTURE0);
        gl.enable(gl.DEPTH_TEST);return true;
    }
    const rgb=c=>[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)/255);
    function face(points,color,shade=1,ground=0){
        const tint=rgb(color).map(c=>c*shade);
        for(let i=1;i<points.length-1;i++)for(const p of [points[0],points[i],points[i+1]])vertices.push(...p,...tint,ground);
    }
    function ring(p,r,z,n=7){return Array.from({length:n},(_,j)=>[p[0]+r*Math.cos(j*2*Math.PI/n),p[1]+r*Math.sin(j*2*Math.PI/n),z]);}
    function solid(bottom,top,c,projection=0){
        face(top,c,1.05,projection);
        bottom.forEach((p,i)=>{const j=(i+1)%bottom.length;face([p,bottom[j],top[j],top[i]],c,.72+.24*(.5+.5*Math.cos(i*2*Math.PI/bottom.length)),projection);});
    }
    function column(p,r,h,c,base,topRadius=r,n=7){solid(ring(p,r,base,n),ring(p,topRadius,base+h,n),c);}
    function build(site){
        const playful=style==='stylized',bare=style==='bare';
        vertices=[];scene=site;const tex=document.createElement('canvas');tex.width=tex.height=1024;
        const ctx=tex.getContext('2d');ctx.scale(1024/site.w,1024/site.h);
        ctx.fillStyle=style==='realistic'?'#92957b':'#b3c97c';ctx.fillRect(0,0,site.w,site.h);
        const groundFeatures=site.features.filter(f=>(kinds[f.kind][2]==='area'&&f.kind!=='building')||['path','crossing'].includes(f.kind));
        for(const f of groundFeatures.sort((a,b)=>Number(kinds[a.kind][2]!=='area')-Number(kinds[b.kind][2]!=='area'))){
            ctx.beginPath();f.p.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));
            if(kinds[f.kind][2]==='area'){ctx.closePath();ctx.fillStyle=featureColor(f);ctx.fill();}
            else{ctx.strokeStyle=featureColor(f);ctx.lineWidth=Math.max(1.1,Number(f.tagProperties?.width||1.55));ctx.lineJoin='round';ctx.stroke();}
        }
        // Sparse ink marks and soft contact shadows on the illustrated ground.
        const noise=i=>{const v=Math.sin(i*78.233+19.7)*43758.5453;return v-Math.floor(v);};
        if(!bare){
        ctx.save();
        for(const f of groundFeatures.filter(f=>f.kind==='grass'||f.kind==='water')){
            ctx.save();ctx.beginPath();f.p.forEach((q,i)=>i?ctx.lineTo(...q):ctx.moveTo(...q));ctx.closePath();ctx.clip();
            const water=f.kind==='water';ctx.strokeStyle=water?'#d0efe950':'#42523535';ctx.lineWidth=water?.13:.09;
            ctx.beginPath();for(let i=0;i<(playful?1200:4800);i++){
                const x=noise(i*2)*site.w,y=noise(i*2+1)*site.h;
                ctx.moveTo(x-.22,y);ctx.lineTo(x,y+(water?.035:.28));ctx.lineTo(x+(water?.8:.13),y-.05);
            }ctx.stroke();ctx.restore();
        }
        for(const f of site.features.filter(f=>['tree','bush','bin','bench'].includes(f.kind))){
            const [x,y]=f.p[0],r=f.kind==='tree'?2.1:.62;
            ctx.fillStyle='#344b5038';ctx.beginPath();ctx.ellipse(x+r*.4,y+r*.18,r,r*.63,.35,0,2*Math.PI);ctx.fill();
        }
        ctx.restore();
        }
        gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,tex);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,style==='realistic'?gl.LINEAR:gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
        const mesh=elevationMesh(site),steps=mesh.steps,grid=mesh.grid;
        surface=mesh.at;
        for(let y=0;y<steps;y++)for(let x=0;x<steps;x++){
            const a=grid[y][x],b=grid[y][x+1],c=grid[y+1][x+1],d=grid[y+1][x];
            const shade=Math.max(.73,Math.min(1.04,.93+(b[2]-a[2])/(site.w/steps)*.28));
            face([a,b,c],'#ffffff',shade,1);face([a,c,d],'#ffffff',shade*.985,1);
        }
        // Chunky cloud banks make the skyline readable while turning.
        const span=Math.hypot(site.w,site.h);
        if(playful)for(let i=0;i<11;i++){
            const angle=i*2.4, x=site.w/2+Math.cos(angle)*span*.74,y=site.h/2+Math.sin(angle)*span*.74;
            const z=surface([x,y])+span*(.13+noise(i)*.12);
            for(let j=0;j<3;j++){
                const center=[x+j*span*.045,y],r=span*(j===1?.064:.047);
                solid(ring(center,r,z,7),ring(center,r*.79,z+r*.55,7),'#ffefda',-1);
            }
        }
        for(const f of site.features){
            const p=f.p[0],z=surface(p);
            if(f.kind==='building'){
                const shed=f.itemType==='employeeShed';
                const base=f.p.map(q=>[...q,surface(q)-.15]), roof=Math.max(...base.map(q=>q[2]))+(+f.height||(shed?2.6:5));
                const roofColor=featureColor(f), roofShape=shed?'Pointed':f.tagProperties?.roofShape||'Flat';
                const walls=edges(base,true);
                const doorWall=shed?walls.reduce((best,wall)=>dist(...wall)>dist(...best)?wall:best):null;
                for(const wall of walls){
                    const [a,b]=wall;
                    const len=dist(a,b);if(len<.01)continue;face([a,b,[b[0],b[1],roof],[a[0],a[1],roof]],shed?'#a4ae9f':playful?featureColor(f):'#c9c5bb',.8+.14*Math.abs(b[0]-a[0])/len);
                    // A thick painted fascia and a window surround give the block a toy-like profile.
                    if(playful)for(const sign of [-1,1]){
                        const ox=-(b[1]-a[1])/len*.09*sign,oy=(b[0]-a[0])/len*.09*sign;
                        face([[a[0]+ox,a[1]+oy,roof-.36],[b[0]+ox,b[1]+oy,roof-.36],[b[0]+ox,b[1]+oy,roof+.12],[a[0]+ox,a[1]+oy,roof+.12]],'#ab5850');
                    }
                    if(wall===doorWall && len>1){
                        const ux=(b[0]-a[0])/len,uy=(b[1]-a[1])/len;
                        const mid=[(a[0]+b[0])/2,(a[1]+b[1])/2],bottom=surface(mid);
                        for(const offset of [-.025,.025]){
                            const x=mid[0]-uy*offset,y=mid[1]+ux*offset;
                            face([[x-ux*.47,y-uy*.47,bottom],[x+ux*.47,y+uy*.47,bottom],
                                [x+ux*.47,y+uy*.47,bottom+2],[x-ux*.47,y-uy*.47,bottom+2]],'#526057');
                        }
                    }
                    if(!bare && !shed)for(let i=1;i<=Math.floor(len/4);i++){
                        const t=i/(Math.floor(len/4)+1),cx=a[0]+(b[0]-a[0])*t,cy=a[1]+(b[1]-a[1])*t,ux=(b[0]-a[0])/len,uy=(b[1]-a[1])/len;
                        for(const sign of [-1,1]){const x=cx-sign*uy*.025,y=cy+sign*ux*.025;
                        const bx=cx-sign*uy*.012,by=cy+sign*ux*.012;
                        if(playful)face([[bx-ux*1.13,by-uy*1.13,roof-2.84],[bx+ux*1.13,by+uy*1.13,roof-2.84],[bx+ux*1.13,by+uy*1.13,roof-1.26],[bx-ux*1.13,by-uy*1.13,roof-1.26]],'#795756');
                        face([[x-ux,y-uy,roof-2.7],[x+ux,y+uy,roof-2.7],[x+ux,y+uy,roof-1.4],[x-ux,y-uy,roof-1.4]],playful?'#82b4bc':'#596c75');}
                    }
                }
                if(roofShape==='Flat')for(const patch of surfaceCells(f.p,site.w,site.h))face(patch.map(q=>[...q,roof]),roofColor);
                else{
                    const center=f.p.reduce((sum,q)=>[sum[0]+q[0]/f.p.length,sum[1]+q[1]/f.p.length], [0,0]);
                    const peak=roof+(shed ? 0.65 : roofShape==='Pointed'?2.5:1.1);
                    for(const [a,b] of edges(f.p,true))face([[...a,roof],[...b,roof],[center[0],center[1],peak]],roofColor,.9+.1*Math.abs(b[0]-a[0])/Math.max(.01,dist(a,b)));
                }
            }else if(f.kind==='roadLine'){
                const width=Math.max(.2,Number(f.tagProperties?.width||6)),half=width/2,color=featureColor(f);
                for(const [a,b] of edges(f.p)){
                    const length=dist(a,b);if(length<.001)continue;
                    const nx=-(b[1]-a[1])/length*half,ny=(b[0]-a[0])/length*half;
                    face([[a[0]+nx,a[1]+ny],[b[0]+nx,b[1]+ny],[b[0]-nx,b[1]-ny],[a[0]-nx,a[1]-ny]].map(q=>[...q,surface(q)+.035]),color);
                }
            }else if(f.kind==='tree'){
                const growth=Math.max(2,Math.min(40,Number(f.tagProperties?.maxGrowth||16))),size=growth/18,treeColor=featureColor(f);
                if(bare){
                    column(p,.3,2.4*size,'#777777',z,.3,4);
                    column(p,2.3*size,3.2*size,'#aaaaaa',z+1.9*size,0,5);
                    continue;
                }
                if(style==='realistic'){
                    column(p,.28*size,3.4*size,'#6d5947',z,.16*size,12);
                    const crown=[p[0]+.2*size,p[1]],center=z+3.7*size;
                    for(let band=0;band<6;band++){
                        const a=-Math.PI/2+band*Math.PI/6,b=a+Math.PI/6;
                        solid(ring(crown,2.2*size*Math.cos(a),center+2*size*Math.sin(a),12),
                              ring(crown,2.2*size*Math.cos(b),center+2*size*Math.sin(b),12),treeColor);
                    }
                    continue;
                }
                const tilt=noise(p[0]+p[1])-.5, crown=[p[0]+tilt*.8,p[1]+.25];
                solid(ring(p,.45*size,z),ring(crown,.26*size,z+3.1*size),'#976748');
                solid(ring(crown,1.5*size,z+2.1*size),ring(crown,2.45*size,z+3.25*size),treeColor);
                solid(ring(crown,2.45*size,z+3.25*size),ring([crown[0]+tilt*size,crown[1]],1.65*size,z+4.85*size),treeColor);
                const tuft=[crown[0]+1.2,crown[1]-.4];
                column(tuft,.8*size,1.1*size,treeColor,z+3.5*size,1.1*size,6);column(tuft,1.1*size,.75*size,treeColor,z+4.6*size,.48*size,6);
            }else if(f.kind==='bush'){
                const radius=Number(f.tagProperties?.size||1.2),color=featureColor(f);
                for(const [dx,dy,scale] of [[0,0,1],[-.42,.08,.72],[.39,-.12,.78]])
                    solid(ring([p[0]+dx*radius,p[1]+dy*radius],radius*.68*scale,z+.3),ring([p[0]+dx*radius,p[1]+dy*radius],radius*.54*scale,z+radius*1.05*scale),color);
            }else if(f.kind==='bench'){
                const length=Math.max(.6,Math.min(12,Number(f.tagProperties?.length||2.4))),half=length/2;
                for(const dx of [-half*.58,half*.58])column([p[0]+dx,p[1]],.12,.52,'#505666',z);
                solid(rect(p[0]-half,p[1]-.4,length,.8).map(q=>[...q,z+.47]),rect(p[0]-half,p[1]-.4,length,.8).map(q=>[...q,z+.67]),featureColor(f));
            }else if(f.kind==='light'){
                const lumens=Math.max(0,Number(f.tagProperties?.brightness??1800)),glow=Math.max(.18,Math.min(.72,lumens/10000));
                column(p,.12,3.2,'#51596c',z);column(p,glow,.55,lumens>3500?'#fff1aa':'#ffdf85',z+3.2,glow*.7);
            }
            else if(f.kind==='bin'){
                if(!playful){column(p,.43,1,'#39706a',z);column(p,.49,.14,'#314c55',z+1);continue;}
                column(p,.41,1.1,'#3c8e89',z,.5,8);column(p,.58,.19,'#edaf50',z+1.1,.52,8);
                for(const dx of [-.15,.15]){
                    const eye=[p[0]+dx,p[1]-.44];column(eye,.12,.19,'#fff2da',z+.74,.1,6);
                    column([eye[0],eye[1]-.095],.055,.09,'#393647',z+.78,.045,6);
                }}
            else if(['entrance','destination'].includes(f.kind)){column(p,.09,2.3,'#805c44',z);face([[...p,z+2.4],[p[0]+1,p[1],z+2.05],[...p,z+1.8]],featureColor(f));}
            else if(f.kind==='dangerSign'){
                const [x,y]=p;
                column(p,.055,1.6,'#687074',z);
                for(const side of [-1,1]){
                    const plate=y+side*.035, ink=plate+side*.008;
                    face([[x-.42,plate,z+1.45],[x+.42,plate,z+1.45],[x,plate,z+2.18]],'#372d23');
                    face([[x-.34,ink,z+1.49],[x+.34,ink,z+1.49],[x,ink,z+2.09]],featureColor(f));
                    const front=ink+side*.008;
                    face([[x-.034,front,z+1.96],[x+.034,front,z+1.96],[x+.022,front,z+1.68],[x-.022,front,z+1.68]],'#372d23');
                    face([[x-.028,front,z+1.63],[x+.028,front,z+1.63],[x+.028,front,z+1.57],[x-.028,front,z+1.57]],'#372d23');
                }
            }
            else if(f.kind==='fountain'){
                column(p,.16,.9,'#657a80',z);column(p,.42,.16,featureColor(f),z+.9,.34);column(p,.08,.42,'#79bfce',z+1.06,.08);
            }else if(f.kind==='drainage'){
                column(p,.48,.08,featureColor(f),z,.48,12);
                for(let offset=-.3;offset<=.3;offset+=.15)face([[p[0]+offset,p[1]-.35,z+.09],[p[0]+offset+.035,p[1]-.35,z+.09],[p[0]+offset+.035,p[1]+.35,z+.09],[p[0]+offset,p[1]+.35,z+.09]],'#374449');
            }else if(f.kind==='birdhouse'){
                column(p,.1,2,'#73563d',z,.1,6);
                const bottom=rect(p[0]-.32,p[1]-.32,.64,.64).map(q=>[...q,z+2]);
                const top=rect(p[0]-.32,p[1]-.32,.64,.64).map(q=>[...q,z+2.6]);
                solid(bottom,top,featureColor(f));
                face([[p[0]-.4,p[1]-.34,z+2.58],[p[0]+.4,p[1]-.34,z+2.58],[p[0],p[1]-.34,z+2.95]],'#75513d');
            }else if(f.kind==='fence'&&f.tagProperties?.visibility!=='Invisible'){for(const [a,b] of edges(f.p)){const aa=surface(a),bb=surface(b);face([[...a,aa+.6],[...b,bb+.6],[...b,bb+.85],[...a,aa+.85]],featureColor(f));column(a,.12,1,'#93623d',aa);}}
        }
        gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),gl.STATIC_DRAW);vertexCount=vertices.length/7;
        triangles=gl.createBuffer();vertices=[];
    }
    function startAt([x,y]){
        keys.clear();
        const yaw=Math.atan2(site.h/2-y,site.w/2-x);
        camera={x,y,yaw,pitch:-.06,targetYaw:yaw,targetPitch:-.06,vx:0,vy:0,vz:0,feet:null,airborne:false};
    }
    function bind(buf){gl.bindBuffer(gl.ARRAY_BUFFER,buf);for(const [name,n,off] of [['pos',3,0],['col',3,12],['ground',1,24]])gl.vertexAttribPointer(gl.getAttribLocation(program,name),n,gl.FLOAT,false,28,off);}
    function draw(){
        if(!view3)return;
        if(!gl&&!initialize()){canvas.hidden=true;document.getElementById('status').textContent='First-person view requires WebGL. Enable graphics acceleration or use 2D Plan.';return;}
        if(scene!==site){if(triangles)gl.deleteBuffer(triangles);build(site);}
        const w=Math.min(style==='realistic'?1440:960,Math.round(canvas.clientWidth*(style==='realistic'?1:.85))),h=Math.round(w*canvas.clientHeight/canvas.clientWidth);
        if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
        gl.viewport(0,0,w,h);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
        const uniform=n=>gl.getUniformLocation(program,n);
        const heat=displayedAnalysis()?.canvas||null;
        if(heat && uploadedHeat!==heat){
            gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,heatTexture);
            gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,heat);
            gl.activeTexture(gl.TEXTURE0);uploadedHeat=heat;
        }
        const conditions=scenarioConditions(),light=environmentLighting(conditions);
        const sky=style==='bare'?light.sky.map(()=>light.sky.reduce((s,v)=>s+v,0)/3):light.sky;
        const color=sky.map(v=>Math.round(v*255)).join(',');
        const sun=conditions.hour>=6&&conditions.hour<18;
        const celestialX=50+Math.sin((conditions.hour-6)/12*Math.PI-camera.yaw)*48;
        const glow=sun?'#fff2c0':'#d9e2ed';
        canvas.parentElement.style.background=conditions.weather==='clear'?
            'radial-gradient(circle at '+celestialX+'% '+(55-38*Math.max(.15,light.daylight))+'%, '+(style==='bare'?'#ededed':glow)+' 0 1.7%, transparent 2.1%), linear-gradient(rgb('+color+'),rgb('+sky.map(v=>Math.round(Math.min(1,v+.12)*255)).join(',')+'))':
            'linear-gradient(rgb('+color+'),rgb('+sky.map(v=>Math.round(Math.min(1,v+.1)*255)).join(',')+'))';
        gl.uniform3fv(uniform('ambient'),light.tint);gl.uniform3fv(uniform('skyTint'),sky);gl.uniform1f(uniform('wet'),light.wet);
        gl.uniform1f(uniform('visualStyle'),style==='bare'?0:style==='stylized'?1:2);
        gl.uniform1f(uniform('heatOn'),heat?1:0);
        gl.uniform3f(uniform('eye'),camera.x,camera.y,(camera.feet??surface([camera.x,camera.y]))+1.7);
        gl.uniform2f(uniform('turn'),Math.cos(camera.yaw),Math.sin(camera.yaw));gl.uniform2f(uniform('tilt'),Math.cos(camera.pitch),Math.sin(camera.pitch));
        gl.uniform2f(uniform('extent'),site.w,site.h);gl.uniform1f(uniform('aspect'),w/h);gl.uniform1f(uniform('fog'),Math.max(site.w,site.h)*light.fog);
        bind(buffer);gl.drawArrays(gl.TRIANGLES,0,vertexCount);
        personTargets=[];
        if(tab==='Simulate'){
            vertices=[];
            net.trips.forEach((trip,i)=>{
                const state=pedestrianState(trip,i), selected=selectedPerson===i;
                const q=state.position;
                if(!state.waiting){
                    const seated=state.stopped && state.task.kind==='bench';
                    const floor=surface(q), hips=floor+(seated?.67:.85);
                    const coat=selected?'#176b88':['#b35238','#477f79','#805f9b','#476e91'][i%4];
                    const stride=state.stopped?0:Math.sin((time-2*i)*trip.pace*5)*.14;
                    for(const side of [-1,1]){
                        const foot=[q[0]+side*.1,q[1]+(seated?.4:stride*side)];
                        const knee=[foot[0],foot[1]+(seated?0:.04)];
                        const hip=[foot[0],q[1]];
                        solid(ring(foot,.075,floor+.03),ring(knee,.085,floor+(seated?.54:.42)),'#384355');
                        solid(ring(knee,.085,floor+(seated?.54:.42)),ring(hip,.09,hips),'#465063');
                    }
                    column(q,.19,.53,coat,hips,.24);
                    const reaching=state.stopped && ['bin','fountain'].includes(state.task.kind);
                    for(const side of [-1,1]){
                        const shoulder=[q[0]+side*.22,q[1]];
                        const hand=[shoulder[0],q[1]+(reaching&&side===1?-.45:stride*side)];
                        solid(ring(hand,.06,hips+(reaching?.18:.03)),ring(shoulder,.08,hips+.49),coat);
                    }
                    column(q,.13,.23,'#d5aa80',hips+.55,.12);
                    rememberPerson(i,q,hips+.25);
                }
                if(selected || (showTrails && selectedPerson<0 && !state.waiting)){
                    const trail=selected?trip.p:state.trail;
                    for(const [a,b] of edges(trail)){const l=dist(a,b);if(!l)continue;const nx=-(b[1]-a[1])*.15/l,ny=(b[0]-a[0])*.15/l;
                        face([[a[0]+nx,a[1]+ny],[b[0]+nx,b[1]+ny],[b[0]-nx,b[1]-ny],[a[0]-nx,a[1]-ny]].map(p=>[...p,surface(p)+.07]),selected?'#176b88':'#ee8534');}
                }
            });
            bind(triangles);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),gl.DYNAMIC_DRAW);gl.drawArrays(gl.TRIANGLES,0,vertices.length/7);vertices=[];
        }
        const surveyors = typeof multiplayer !== 'undefined' ? multiplayer.users().filter(user => user.is3d) : [];
        if (surveyors.length) {
            vertices = [];
            for (const user of surveyors) {
                const p = [user.x, user.y], z = surface(p), coat = user.color;
                column(p, .23, .62, coat, z + .8, .19, 7);
                column([p[0], p[1] - .015], .16, .25, '#f1cfad', z + 1.43, .14, 7);
                column([p[0] - .11, p[1] + .02], .075, .42, '#31323a', z + .35, .07, 5);
                column([p[0] + .11, p[1] + .02], .075, .42, '#31323a', z + .35, .07, 5);
            }
            bind(triangles);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),gl.DYNAMIC_DRAW);gl.drawArrays(gl.TRIANGLES,0,vertices.length/7);vertices=[];
        }
        if(['rain','snow'].includes(conditions.weather)){
            vertices=[];
            const snow=conditions.weather==='snow',elapsed=matchMedia('(prefers-reduced-motion: reduce)').matches?0:performance.now()/1000;
            const random=i=>{const v=Math.sin(i*127.1+31)*43758.5453;return v-Math.floor(v);};
            for(let i=0;i<210;i++){
                const x=Math.floor(camera.x/10)*10+(random(i)-.5)*42,y=Math.floor(camera.y/10)*10+(random(i+501)-.5)*42;
                if(x<0||x>site.w||y<0||y>site.h||site.features.some(f=>f.kind==='building'&&inside([x,y],f.p)))continue;
                const height=surface([x,y])+((random(i+900)*13-elapsed*(snow?1.25:11))%13+13)%13;
                const width=snow?.06:.016,tail=snow?.1:.65,c=Math.cos(camera.yaw),s=Math.sin(camera.yaw);
                face([[x-s*width,y+c*width,height],[x+s*width,y-c*width,height],[x+s*width-.09,y-c*width,height+tail],[x-s*width-.09,y+c*width,height+tail]],snow?'#ffffff':'#bbd4ed',1,-1);
            }
            bind(triangles);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),gl.DYNAMIC_DRAW);gl.drawArrays(gl.TRIANGLES,0,vertices.length/7);vertices=[];
            if(!weatherFrame&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
                weatherFrame=requestAnimationFrame(()=>{weatherFrame=0;if(view3)draw();});
            }
        }
    }
    function move(dt){
        const forward=Number(keys.has('w')||keys.has('arrowup'))-Number(keys.has('s')||keys.has('arrowdown'));
        const side=Number(keys.has('d'))-Number(keys.has('a'));
        camera.targetYaw+=dt*1.9*(Number(keys.has('arrowright'))-Number(keys.has('arrowleft')));
        const response=1-Math.exp(-24*dt);
        camera.yaw+=(camera.targetYaw-camera.yaw)*response;
        camera.pitch+=(camera.targetPitch-camera.pitch)*response;
        const speed=(keys.has('shift')?8:4.3)/Math.max(1,Math.hypot(forward,side));
        const c=Math.cos(camera.yaw),s=Math.sin(camera.yaw);
        const acceleration=1-Math.exp(-dt*(camera.airborne?5:11));
        camera.vx+=(speed*(forward*c-side*s)-camera.vx)*acceleration;
        camera.vy+=(speed*(forward*s+side*c)-camera.vy)*acceleration;
        const free=(a,b)=>!scene.features.some(f=>['water','building'].includes(f.kind)&&blocked(a,b,f.p));
        const p=[camera.x,camera.y],q=[Math.max(0,Math.min(site.w,p[0]+camera.vx*dt)),Math.max(0,Math.min(site.h,p[1]+camera.vy*dt))];
        if(free(p,q)){camera.x=q[0];camera.y=q[1];}
        else if(free(p,[q[0],p[1]])){camera.x=q[0];camera.vy=0;}
        else if(free(p,[p[0],q[1]])){camera.y=q[1];camera.vx=0;}
        const floor=surface([camera.x,camera.y]);
        if(camera.airborne){
            camera.feet+=camera.vz*dt-9*dt*dt;camera.vz-=18*dt;
            if(camera.feet<=floor){camera.airborne=false;camera.vz=0;}
        }
        if(!camera.airborne)camera.feet=floor;
    }
    function animate(now){
        activeFrame=0;
        if(!view3||!scene||!camera||!surface)return;
        const dt=Math.min(.08,(now-previous)/1000);previous=now;
        move(dt);draw();
        if(keys.size||camera.airborne||Math.hypot(camera.vx,camera.vy)>.015||
            Math.abs(camera.yaw-camera.targetYaw)+Math.abs(camera.pitch-camera.targetPitch)>.0002)
            activeFrame=requestAnimationFrame(animate);
    }
    function wake(){if(!activeFrame){previous=performance.now();activeFrame=requestAnimationFrame(animate);}}
    function press(k){
        if(!scene||!camera||!surface)return;
        if(k==='jump'){
            if(camera.airborne)return;
            camera.feet=surface([camera.x,camera.y]);camera.vz=6.3;camera.airborne=true;
        }else keys.add(k);
        wake();
    }
    const controls=['w','a','s','d','arrowleft','arrowright','arrowup','arrowdown','shift','jump'];
    window.addEventListener('keydown',e=>{
        const k=e.code==='Space'?'jump':e.key.toLowerCase();
        if(!view3||!controls.includes(k)||['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;
        if(k==='jump'&&e.target.closest('button'))return;
        e.preventDefault();if(!e.repeat)press(k);
    });
    window.addEventListener('keyup',e=>keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur',()=>keys.clear());
    // Project the walker body with the same camera transform as the vertex shader.
    let personTargets=[], tap=null;
    function rememberPerson(index,q,z){
        const dx=q[0]-camera.x,dy=q[1]-camera.y;
        const ahead=dx*Math.cos(camera.yaw)+dy*Math.sin(camera.yaw);
        const side=-dx*Math.sin(camera.yaw)+dy*Math.cos(camera.yaw);
        const up=z-(camera.feet??surface([camera.x,camera.y]))-1.7;
        const depth=ahead*Math.cos(camera.pitch)+up*Math.sin(camera.pitch);
        if(depth<.1)return;
        const focal=canvas.clientHeight*.71;
        personTargets.push({index,depth,x:canvas.clientWidth/2+side*focal/depth,
            y:canvas.clientHeight/2-(up*Math.cos(camera.pitch)-ahead*Math.sin(camera.pitch))*focal/depth,
            radius:Math.max(7,.55*focal/depth)});
    }
    canvas.onpointerdown=e=>{tap=[e.clientX,e.clientY];canvas.focus();canvas.setPointerCapture(e.pointerId);look=[e.clientX,e.clientY];};
    canvas.onpointermove=e=>{
        if(!look||!camera)return;
        if(tap && Math.hypot(e.clientX-tap[0],e.clientY-tap[1])>5)tap=null;
        camera.targetYaw+=(e.clientX-look[0])*.006;
        camera.targetPitch=Math.max(-1,Math.min(.95,camera.targetPitch-(e.clientY-look[1])*.005));
        look=[e.clientX,e.clientY];wake();
    };
    canvas.onpointerup=e=>{
        if(tap && tab==='Simulate'){
            const r=canvas.getBoundingClientRect();
            const hit=personTargets.filter(t=>Math.hypot(e.clientX-r.left-t.x,e.clientY-r.top-t.y)<=t.radius).sort((a,b)=>a.depth-b.depth)[0];
            if(hit)inspectPedestrian(hit.index);
        }
        tap=null;look=null;
    };
    canvas.onpointercancel=()=>{tap=null;look=null;};
    document.querySelectorAll('[data-walk]').forEach(b=>{
        b.onpointerdown=e=>{e.preventDefault();b.setPointerCapture(e.pointerId);press(b.dataset.walk);};
        b.onpointerup=b.onpointercancel=()=>keys.delete(b.dataset.walk);
        b.onclick=e=>{if(e.detail===0&&b.dataset.walk==='jump')press('jump');};
    });
    return {draw,startAt,state(){return camera?{x:camera.x,y:camera.y,yaw:camera.yaw,pitch:camera.pitch}:null;},invalidate(){scene=null;keys.clear();},stop(){keys.clear();cancelAnimationFrame(weatherFrame);weatherFrame=0;}};
})();
