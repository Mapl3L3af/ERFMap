const world = document.querySelector('#world');
const canvas = document.querySelector('canvas');
const nav = document.querySelector('nav');
const coords = document.querySelector('#coords');
const held = new Set();
let x = 0, y = 0, vx = 0, vy = 0, entering = false;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

const survey = document.querySelector('main');
let aimX = 0, aimY = 0, lookX = 0, lookY = 0;

function centerLook() {
  aimX = aimY = 0;
}

survey.addEventListener('pointermove', event => {
  if (event.pointerType === 'touch' || entering) return;
  const bounds = survey.getBoundingClientRect();
  aimX = 2 * (event.clientX - bounds.left) / bounds.width - 1;
  aimY = 2 * (event.clientY - bounds.top) / bounds.height - 1;
});
survey.addEventListener('pointerleave', centerLook);


[
  ['Map from Video', 23, 24], ['Open Project', 72, 21],
  ['Join Project', 28, 72], ['Info', 77, 68]
].forEach(([name, left, top], i) => {
  const button = document.createElement('button');
  button.style.left = left + '%';
  button.style.top = top + '%';
  button.innerHTML = '<small>SECTOR / 0' + (i + 1) + '</small><span class="label">' + name + '<b aria-hidden="true">↗</b></span>';
  button.onclick = () => {
    if (entering) return;
    if (name === 'Open Project') document.querySelector('#projectFile').click();
    if (name === 'Join Project') document.querySelector('#joinDialog').showModal();
    if (name === 'Map from Video') location.assign('/intake/');
    if (name === 'Info') statusLine.textContent = 'Map from Video turns drone video or photos into a locally scaled site map you can review, correct and export. Open Project loads a saved JSON file, and Join Project connects you to a teammate with their four digit code.';
  };
  nav.append(button);
});

const statusLine = document.querySelector('#homeStatus');
statusLine.textContent = sessionStorage.getItem('erfmap-message') || '';
sessionStorage.removeItem('erfmap-message');
async function createProject(data) {
  entering = true;
  statusLine.textContent = 'Opening project…';
  try {
    const response = await fetch('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:data});
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    location.assign('/survey/?room=' + result.code);
  } catch (error) { statusLine.textContent = error.message; entering = false; }
}
document.querySelector('#projectFile').onchange = async event => {
  const file = event.target.files[0]; event.target.value = '';
  if (file) await createProject(await file.text());
};
const joinDialog = document.querySelector('#joinDialog');
document.querySelector('#cancelJoin').onclick = () => joinDialog.close();
joinDialog.querySelector('form').onsubmit = event => {
  event.preventDefault();
  location.assign('/survey/?room=' + event.target.elements.code.value);
};
// Trace contours of a continuous height field, with closely spaced index lines.
function height(x, y) {
  const u = x + .23 * Math.sin(2.7*y + .5*x) + .06*Math.sin(6*y-x);
  const v = y + .21 * Math.sin(2*x-y) + .04*Math.cos(5*x+2*y);
  return 2*Math.sin(2.6*u+v) + 1.45*Math.cos(3*v-.5*u)
    + .69*Math.sin(4*u-2.7*v) + .46*Math.cos(5*v+u) + .07*Math.cos(10*u+6*v);
}
function drawMap() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const ratio = Math.min(devicePixelRatio, 2);
  canvas.width = Math.round(w*ratio);
  canvas.height = Math.round(h*ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio,ratio);
  ctx.fillStyle = '#161616';
  ctx.fillRect(0,0,w,h);
  const step = 7, scale = Math.max(285,w/5);
  const paths = new Map();
  const cols = Math.ceil(w/step)+1, rows = Math.ceil(h/step)+1;
  const field = Float32Array.from({length:cols*rows},(_,i) =>
    height((i%cols)*step/scale,Math.floor(i/cols)*step/scale));
  for(let row=0;row<rows-1;row++) for(let col=0;col<cols-1;col++) {
    const index = row*cols+col;
    const z = [field[index],field[index+1],field[index+cols+1],field[index+cols]];
    const px = col*step, py = row*step;
    const corners = [[px,py],[px+step,py],[px+step,py+step],[px,py+step]];
    for(let n=Math.ceil(Math.min(...z)/.15);n*.15<=Math.max(...z);n++){
      const level=n*.15;
      if(!paths.has(n)) paths.set(n,new Path2D());
      const path=paths.get(n);
      let move=true;
      for(let a=0;a<4;a++){
        const b=(a+1)%4;
        if((z[a]<level)===(z[b]<level)) continue;
        const t=(level-z[a])/(z[b]-z[a]);
        const sx=corners[a][0]+t*(corners[b][0]-corners[a][0]);
        const sy=corners[a][1]+t*(corners[b][1]-corners[a][1]);
        if(move) path.moveTo(sx,sy); else path.lineTo(sx,sy);
        move=!move;
      }
    }
  }
  for(const [n,path] of paths){
    ctx.strokeStyle=n%5?'#454545':'#626262';
    ctx.lineWidth=n%5?.65:1;
    ctx.stroke(path);
  }
  ctx.fillStyle='#777';
  ctx.font='9px monospace';
  for(let a=48;a<w;a+=146) for(let b=52;b<h;b+=146){
    ctx.fillRect(a-3,b,7,.8);ctx.fillRect(a,b-3,.8,7);
    if(((a-48+b-52)/146)%4===0) ctx.fillText(Math.round(260+height(a/scale,b/scale)*12)+' m',a+8,b+3);
  }
}
new ResizeObserver(drawMap).observe(world);
window.addEventListener('keydown',e=>{
  if(e.ctrlKey||e.altKey||e.metaKey||entering||joinDialog.open) return;
  const key=e.key.toLowerCase();
  if(['w','a','s','d'].includes(key)) held.add(key);
  if(key==='enter' && !e.repeat && nav.querySelector('button:hover')){
    e.preventDefault(); nav.querySelector('button:hover').click();
  }
});
window.addEventListener('keyup',e=>held.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => { held.clear(); centerLook(); });
let previous=performance.now();
function fly(now){
  const dt=Math.min((now-previous)/1000,.05);
  previous=now;
  const dx=Number(held.has('a'))-Number(held.has('d'));
  const dy=Number(held.has('w'))-Number(held.has('s'));
  const blend=1-Math.exp(-dt*8);
  vx+=(dx-vx)*blend;vy+=(dy-vy)*blend;
  const limitX=world.clientWidth*.115,limitY=world.clientHeight*.12;
  x=Math.max(-limitX,Math.min(limitX,x+vx*dt*135));
  y=Math.max(-limitY,Math.min(limitY,y+vy*dt*135));
  const tilt=reduced.matches?0:2;
  lookX += (aimX - lookX) * blend;
  lookY += (aimY - lookY) * blend;
  const offsetX = reduced.matches ? 0 : lookX * 10;
  const offsetY = reduced.matches ? 0 : lookY * 7;
  world.style.transform = `translate(${x - offsetX}px, ${y - offsetY}px)
    rotateX(${vy * tilt + offsetY * .06}deg) rotateY(${-vx * tilt - offsetX * .06}deg)`;
  coords.textContent=(44.4281+y*.00001).toFixed(4)+'° N  /  '+(110.5885+x*.00001).toFixed(4)+'° W';
  requestAnimationFrame(fly);
}
requestAnimationFrame(fly);
