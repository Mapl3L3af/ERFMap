// Captured photo textures. A site keeps images in `site.assets` (id → data URL and
// the local-metre rectangle the image covers). Each reconstructed item that should
// show the photo carries `feature.texture = {asset, projection: 'planar-xy'}`, so the
// mapping survives JSON and GLB round-trips and can differ per item. Proposed items
// keep their flat colours so they stand out against what was captured.
const surveyTexture = (() => {
    const surfaces = new Set(['building', 'grass', 'soil', 'shrub', 'water', 'pavement', 'road', 'roadLine', 'path', 'crossing', 'solar', 'greenroof', 'canopy', 'unknown']);
    const images = new Map();      // asset id → {data, image, url}
    let pending = 0;
    function eligible(feature) { return surfaces.has(feature.kind) && feature.source !== 'Proposed'; }
    function asset(site, id) { return site.assets?.[id]; }
    function bounds(site, a) { return Array.isArray(a?.bounds) && a.bounds.length === 4 ? a.bounds : [0, 0, site.w, site.h]; }
    async function decode(id, data) {
        const entry = {data, image: null, url: null, failed: false};
        images.set(id, entry);
        try {
            if (typeof data !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/i.test(data)) throw Error('Unsupported image');
            const bytes = Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), c => c.charCodeAt(0));
            entry.url = URL.createObjectURL(new Blob([bytes], {type: data.slice(5, data.indexOf(';'))}));
            const next = new Image();
            next.src = entry.url;
            await next.decode();
            entry.image = next;
        } catch {
            entry.failed = true;
            msg = 'Could not read a survey texture. Attach a JPEG, PNG or WebP image.';
        }
        if (images.get(id) !== entry) return;
        walk.invalidate();
        render();
    }
    // Load any new or changed images; drop removed ones.
    function sync(site) {
        // Surveys saved by the November 6 texture prototype keep one image in
        // `textureImage`; move it into the asset map with per-item mappings.
        if (typeof site.textureImage === 'string' && !site.assets?.ortho) {
            const show = site.showTextures;
            attach(site, site.textureImage, 'site photo');
            site.showTextures = show !== false;
            delete site.textureImage;
        }
        const wanted = site.assets || {};
        for (const [id, entry] of images) if (!wanted[id] || wanted[id].data !== entry.data) { if (entry.url) URL.revokeObjectURL(entry.url); images.delete(id); }
        for (const [id, a] of Object.entries(wanted)) if (a?.type === 'image' && !images.has(id)) decode(id, a.data);
        const toggle = document.getElementById('surveyTextures');
        const any = [...images.values()].some(e => e.image);
        if (toggle) { toggle.disabled = !any; toggle.checked = Boolean(any && site.showTextures !== false); }
        const button = document.querySelector('[data-command="textures"]');
        if (button) { button.disabled = !any; button.title = any ? 'Show captured photo textures on items' : 'No photo attached. Use File › Attach site photo…'; button.setAttribute('aria-pressed', String(Boolean(any && site.showTextures !== false))); }
    }
    function ready(site, feature) {
        if (site.showTextures === false || !feature.texture?.asset) return null;
        const e = images.get(feature.texture.asset);
        return e?.image ? {entry: e, asset: asset(site, feature.texture.asset)} : null;
    }
    function any(site) { return site.showTextures !== false && [...images.values()].some(e => e.image); }
    // One SVG pattern per image, aligned to the plan projection.
    function definitions(site, project, scale) {
        if (!any(site)) return '';
        let s = '<defs>';
        for (const [id, e] of images) {
            if (!e.image) continue;
            const [bx, by, bw, bh] = bounds(site, asset(site, id)), [x, y] = project([bx, by]);
            s += '<pattern id="tex-' + id.replace(/[^\w-]/g, '_') + '" patternUnits="userSpaceOnUse" patternTransform="translate(' + x + ' ' + y + ')" width="' + bw * scale + '" height="' + bh * scale + '"><image href="' + e.url + '" width="' + bw * scale + '" height="' + bh * scale + '" preserveAspectRatio="none"/></pattern>';
        }
        return s + '</defs>';
    }
    function fill(site, feature) { return ready(site, feature) ? 'url(#tex-' + feature.texture.asset.replace(/[^\w-]/g, '_') + ')' : null; }
    // Paint an item's photo onto a 2D canvas already scaled to local metres.
    function paint(ctx, site, feature, shape) {
        const r = ready(site, feature);
        if (!r) return false;
        const [bx, by, bw, bh] = bounds(site, r.asset);
        ctx.save(); shape(); ctx.clip();
        ctx.drawImage(r.entry.image, bx, by, bw, bh);
        ctx.restore();
        return true;
    }
    // Attach a north-up photo covering the survey rectangle and map it onto every
    // eligible captured item.
    function attach(site, dataUrl, name) {
        const id = 'ortho';
        site.assets = {...site.assets, [id]: {type: 'image', role: 'orthophoto', data: dataUrl, bounds: [0, 0, site.w, site.h], name: name || 'site photo', projection: 'planar-xy'}};
        let mapped = 0;
        for (const f of site.features) if (eligible(f) && !f.texture) { f.texture = {asset: id, projection: 'planar-xy'}; mapped++; }
        site.showTextures = true;
        return mapped;
    }
    return {eligible, sync, definitions, fill, paint, attach, any, images};
})();
