'use strict';
const defaults = require('../capture-profile.json');

function captureProfile(height) {
    if (height === null || height === undefined) return {...defaults};
    const metres = Number(height);
    if (typeof height === 'boolean' || !String(height).trim() || !Number.isFinite(metres) || metres <= 0 || metres > 10000) {
        throw Object.assign(Error('Capture height must be a positive number in metres above ground (up to 10000).'), {status: 400});
    }
    return {...defaults, height_agl_m: metres, height_source: 'user-supplied'};
}
module.exports = {captureProfile};
