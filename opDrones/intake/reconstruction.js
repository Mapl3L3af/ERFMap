'use strict';
const fail = (status, message) => Object.assign(Error(message), {status});

function configuration(input) {
    if (!input || input.enabled === false) return {enabled: false};
    if (input.enabled !== true) throw fail(400, 'Choose whether to enable photogrammetry.');
    let url;
    try { url = new URL(input.url); } catch { throw fail(400, 'Enter a valid NodeODM service URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw fail(400, 'Use an HTTP or HTTPS NodeODM URL without credentials, query parameters or fragments.');
    }
    return {enabled: true, url: url.href.replace(/\/+$/, ''), buildingModel: input.buildingModel === true};
}

async function check(input, request = fetch) {
    const config = configuration(input);
    if (!config.enabled) return {ready: false, enabled: false};
    async function get(path) {
        const response = await request(config.url + path, {signal: AbortSignal.timeout(5000), redirect: 'error'});
        if (!response.ok) throw Error('HTTP ' + response.status);
        return response.json();
    }
    try {
        const [info, options] = await Promise.all([get('/info'), get('/options')]);
        if (String(info.engine).toLowerCase() !== 'odm') throw Error('The service must use the ODM engine.');
        if (!Array.isArray(options)) throw Error('The service returned an invalid options list.');
        const required = ['dtm', 'pc-classify', 'dem-gapfill-steps', ...(config.buildingModel ? ['skip-3dmodel'] : [])];
        const missing = required.filter(name => !options.some(o => o.name === name));
        if (missing.length) throw Error('Missing engine options: ' + missing.join(', '));
        return {ready: true, engine: 'ODM', version: String(info.engineVersion || 'unknown'), maxImages: info.maxImages || null};
    } catch (error) {
        throw fail(502, 'NodeODM is not ready: ' + error.message);
    }
}

function environment(job, inherited = process.env) {
    const env = {...inherited};
    // Preserve environment-based configuration for jobs created before this UI.
    if (job?.reconstruction) {
        delete env.ERFMAP_NODEODM_URL;
        delete env.ERFMAP_RECONSTRUCTOR;
        if (job.reconstruction.enabled) env.ERFMAP_NODEODM_URL = configuration(job.reconstruction).url;
    }
    return env;
}

module.exports = {configuration, check, environment};
