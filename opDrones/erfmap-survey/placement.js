// Pointer capture keeps a drag attached to the toolbar figure on touch screens.
(() => {
    const button = $('walker');
    const ghost = document.createElement('div');
    ghost.className = 'walker-marker';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.append(button.querySelector('svg').cloneNode(true));
    ghost.hidden = true;
    document.body.append(ghost);
    let armed = false, start = null, moved = false, flight = null;
    const hint = 'Drop the walker on open ground, or tap a spot. Escape cancels.';
    function arm(value) {
        armed = value;
        button.setAttribute('aria-pressed', String(value));
        document.body.classList.toggle('placing-walker', value);
        ghost.hidden = true;
        if (value) $('status').textContent = hint;
    }
    function cancel() {
        flight?.cancel();
        flight = null;
        arm(false);
        start = null;
        render();
    }
    function landing(e) {
        if (!svg.contains(document.elementFromPoint(e.clientX, e.clientY))) return null;
        const p = world(e);
        if (p[0]<0 || p[0]>site.w || p[1]<0 || p[1]>site.h) return null;
        return site.features.some(f => ['building','water'].includes(f.kind) && inside(p,f.p)) ? null : p;
    }
    function preview(e) {
        ghost.hidden = false;
        ghost.style.left = e.clientX+'px';
        ghost.style.top = e.clientY+'px';
        ghost.classList.toggle('invalid', !landing(e));
    }
    async function drop(e) {
        const p = landing(e);
        if (!p) {
            ghost.hidden = true;
            $('status').textContent = 'Choose open ground inside the survey, clear of buildings and water.';
            return;
        }
        arm(false);
        const origin = project(p);
        const dx = svg.clientWidth/2-origin[0], dy = svg.clientHeight/2-origin[1];
        const options = {duration:matchMedia('(prefers-reduced-motion: reduce)').matches?0:430,easing:'cubic-bezier(.55,.03,.85,.5)',fill:'forwards'};
        const animation = svg.animate([
            {transform:'none',transformOrigin:origin.join('px ')+'px'},
            {transform:'translate('+dx+'px,'+dy+'px) scale(3.6)',transformOrigin:origin.join('px ')+'px'}
        ],options);
        flight = animation;
        $('status').textContent = 'Entering the walkthrough…';
        try { await animation.finished; } catch { return; }
        if (flight !== animation) return;
        flight = null;
        walk.startAt(p);
        view3 = true;
        msg = '';
        render();
        animation.cancel();
        $('walk').focus({preventScroll:true});
    }
    button.addEventListener('pointerdown',e=>{
        if (e.button!==0 || flight) return;
        start=[e.clientX,e.clientY]; moved=false;
        button.setPointerCapture(e.pointerId);
    });
    button.addEventListener('pointermove',e=>{
        if (!start || (!moved && Math.hypot(e.clientX-start[0],e.clientY-start[1])<5)) return;
        if (!moved) arm(true);
        moved=true; preview(e);
    });
    button.addEventListener('pointerup',e=>{
        if (start && moved) drop(e);
        start=null;
    });
    button.addEventListener('pointercancel',cancel);
    button.addEventListener('click',e=>{
        if ((e.detail && moved) || flight) return;
        if (armed) cancel(); else arm(true);
    });
    svg.addEventListener('pointermove',e=>{if(armed)preview(e);});
    svg.addEventListener('pointerleave',()=>{if(!start)ghost.hidden=true;});
    svg.addEventListener('pointerdown',e=>{
        if (!armed && !flight) return;
        e.stopImmediatePropagation();
        if (armed && e.button===0) drop(e);
    },true);
    document.addEventListener('click',e=>{
        if ((armed || flight) && !button.contains(e.target) && e.target.closest('button')) cancel();
    },true);
    window.addEventListener('keydown',e=>{
        if (e.key==='Escape' && (armed || flight)) {
            e.stopImmediatePropagation();cancel();button.focus();
        }
    },true);
})();
