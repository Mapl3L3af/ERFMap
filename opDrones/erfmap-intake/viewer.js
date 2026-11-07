// A pan-and-zoom SVG viewer that keeps the source image under its overlays.
// Overlay coordinates are image pixels. Wheel zooms, drag pans, and elements
// with data-handle can be dragged by the caller through onDrag.
'use strict';
function createViewer(host, {image, width, height, hint = ''}) {
    host.classList.add('viewer');
    host.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" role="img"><image/><g class="overlay"></g></svg>'
        + '<div class="tools"><button type="button" data-z="in" title="Zoom in">+</button><button type="button" data-z="out" title="Zoom out">−</button><button type="button" data-z="fit">Fit</button></div>'
        + (hint ? '<div class="hint">' + hint + '</div>' : '');
    const svg = host.querySelector('svg'), img = svg.querySelector('image'), overlay = svg.querySelector('.overlay');
    let box = [0, 0, width, height], drag = null;
    const api = {onClick: null, onDrag: null, onDragEnd: null, scale: 1};
    function setImage(src, w, h) {
        width = w; height = h;
        if (src) { img.setAttribute('href', src); img.setAttribute('width', w); img.setAttribute('height', h); img.style.display = ''; }
        else img.style.display = 'none';
    }
    function apply() {
        svg.setAttribute('viewBox', box.join(' '));
        const r = svg.getBoundingClientRect();
        api.scale = r.width ? Math.max(box[2] / r.width, box[3] / r.height) : 1;   // image px per screen px
        host.style.setProperty('--px', api.scale);
        if (api.redraw) api.redraw();
    }
    function fit() { box = [0, 0, width, height]; apply(); }
    function focus(x0, y0, x1, y1, pad = 4) {
        const w = Math.max(x1 - x0, 1) * pad, h = Math.max(y1 - y0, 1) * pad, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const r = svg.getBoundingClientRect(), aspect = r.width / Math.max(1, r.height);
        const bw = Math.max(w, h * aspect), bh = bw / aspect;
        box = [cx - bw / 2, cy - bh / 2, bw, bh]; apply();
    }
    function point(e) {
        const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
        const q = p.matrixTransform(svg.getScreenCTM().inverse());
        return [q.x, q.y];
    }
    function zoom(factor, at) {
        const [x, y] = at || [box[0] + box[2] / 2, box[1] + box[3] / 2];
        box = [x - (x - box[0]) * factor, y - (y - box[1]) * factor, box[2] * factor, box[3] * factor]; apply();
    }
    svg.addEventListener('wheel', e => { e.preventDefault(); zoom(Math.exp(Math.sign(e.deltaY) * .15), point(e)); }, {passive: false});
    svg.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const handle = e.target.closest('[data-handle]');
        drag = {start: point(e), screen: [e.clientX, e.clientY], box: [...box], handle: handle?.dataset.handle, moved: false};
        svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', e => {
        if (!drag) return;
        if (Math.hypot(e.clientX - drag.screen[0], e.clientY - drag.screen[1]) > 3) drag.moved = true;
        if (drag.handle && api.onDrag) { api.onDrag(drag.handle, point(e)); return; }
        const r = svg.getBoundingClientRect(), k = drag.box[2] / r.width;
        box = [drag.box[0] - (e.clientX - drag.screen[0]) * k, drag.box[1] - (e.clientY - drag.screen[1]) * k, box[2], box[3]];
        svg.setAttribute('viewBox', box.join(' '));
    });
    svg.addEventListener('pointerup', e => {
        if (!drag) return;
        const d = drag; drag = null;
        if (d.handle && d.moved && api.onDragEnd) api.onDragEnd(d.handle);
        else if (!d.moved && api.onClick) api.onClick(point(e), e.target);
    });
    host.querySelector('.tools').addEventListener('click', e => {
        const z = e.target.dataset.z;
        if (z === 'in') zoom(1 / 1.4); if (z === 'out') zoom(1.4); if (z === 'fit') fit();
    });
    setImage(image, width, height);
    Object.assign(api, {svg, overlay, fit, focus, setImage, draw(markup) { overlay.innerHTML = markup; }, get box() { return box; }});
    requestAnimationFrame(fit);
    new ResizeObserver(() => { if (host.isConnected) apply(); }).observe(host);
    return api;
}
