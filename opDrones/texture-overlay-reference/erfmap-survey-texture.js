// One north-up orthophoto covers the site's local-metre rectangle.
const surveyTexture = (() => {
    const surfaces = new Set(['building', 'grass', 'soil', 'shrub', 'water', 'pavement', 'road', 'roadLine', 'path', 'crossing', 'solar', 'greenroof']);
    let source, image, url, revision = 0;
    function eligible(feature) {
        return surfaces.has(feature.kind) && feature.source !== 'Proposed';
    }
    async function load(data) {
        const current = ++revision;
        source = data;
        if (url) URL.revokeObjectURL(url);
        url = image = null;
        if (!data) return;
        try {
            if (typeof data !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/i.test(data))
                throw Error('Unsupported image');
            const bytes = Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), c => c.charCodeAt(0));
            url = URL.createObjectURL(new Blob([bytes], {type: data.slice(5, data.indexOf(';'))}));
            const next = new Image();
            next.src = url;
            await next.decode();
            if (current !== revision) return;
            image = next;
        } catch {
            if (current !== revision) return;
            msg = 'Could not read the survey texture. Attach a JPEG, PNG, or WebP image.';
        }
        walk.invalidate();
        render();
    }
    function sync(site) {
        if (source !== site.textureImage) load(site.textureImage);
        const toggle = document.getElementById('surveyTextures');
        toggle.disabled = !image;
        toggle.checked = Boolean(image && site.showTextures);
    }
    function active(site) { return site.showTextures && source === site.textureImage && image; }
    function definition(site, project, scale) {
        if (!active(site)) return '';
        const [x, y] = project([0, 0]), w = site.w * scale, h = site.h * scale;
        return '<defs><pattern id="survey-photo" patternUnits="userSpaceOnUse" patternTransform="translate('+x+' '+y+')" width="'+w+'" height="'+h+'"><image href="'+url+'" width="'+w+'" height="'+h+'" preserveAspectRatio="none"/></pattern></defs>';
    }
    return {eligible, active, definition, sync};
})();
