// node --test: conversion from reviewed proposals to erfMap's scenario format and the GLB export.
const test = require('node:test');
const assert = require('node:assert');
const {restore, kinds} = require('../erfmap-survey/model');
const S = require('../erfmap-intake/shared');

const labels = Object.entries(kinds).map(([kind, [label, color, geometry]]) => ({kind, label, color, geometry}));
const square = [[10, 10], [20, 10], [20, 18], [10, 18]];
const geometry = {
    scale: {m_per_px: 0.02, markers: 2, spread: 0.01, origin_px: [0, 0]},
    features: [
        {id: 'G1', kind: 'unknown', predicted_kind: null, geometry: 'area', p: square, region: square, confidence: null, frames: ['f0001'], flags: ['unlabelled']},
        {id: 'G2', kind: 'grass', predicted_kind: 'grass', geometry: 'area', p: [[0, 0], [8, 0], [8, 6], [0, 6]], region: [[0, 0], [8, 0], [8, 6], [0, 6]], confidence: 0.8, frames: ['f0002', 'f0003'], flags: []},
        {id: 'G3', kind: 'unknown', predicted_kind: null, geometry: 'area', p: [[30, 0], [40, 1], [40, 2], [30, 1]], region: [[30, 0], [40, 1], [40, 2], [30, 1]], confidence: null, frames: ['f0004'], flags: [], width_m: 1.2},
    ],
};
const job = {id: 'abc123abc123', name: 'flight.mp4', original: {name: 'flight.mp4'}};

test('only accepted features are exported, with provenance, and the result passes restore()', () => {
    const edits = {G1: {kind: 'building', height: 6, status: 'accepted'}, G2: {status: 'rejected'}, G3: {kind: 'path', status: 'accepted'}};
    const features = S.reviewedFeatures(geometry, edits, labels);
    const site = restore(S.buildSite({job, geometry, features, labels}));
    assert.deepStrictEqual(site.features.map(f => f.kind), ['building', 'path']);
    const building = site.features[0];
    assert.strictEqual(building.height, 6);
    assert.strictEqual(building.source, 'Drone intake');
    assert.strictEqual(building.intake.reviewStatus, 'accepted');
    assert.strictEqual(building.intake.heightSource, 'reviewer estimate, not measured');
    assert.deepStrictEqual(building.intake.frames, ['f0001']);
    assert.strictEqual(site.samples.length, 0, 'no elevation is invented');
    assert.strictEqual(site.localScale.unreferenced, true);
    assert.strictEqual(site.origin, undefined, 'no geographic origin is invented');
    // Relabelling an area as a path turns the region into a two-point line along its long axis.
    assert.strictEqual(site.features[1].p.length, 2);
    assert.strictEqual(site.features[1].tagProperties.width, 1.2);
    // Coordinates are shifted to a 2 m margin.
    assert.strictEqual(Math.min(...site.features.flatMap(f => f.p.map(p => p[0]))), 2);
});

test('unreviewed proposals are not exported', () => {
    const site = S.buildSite({job, geometry, features: S.reviewedFeatures(geometry, {}, labels), labels});
    assert.strictEqual(site.features.length, 0);
});

test('point labels collapse a region to its centroid', () => {
    const [f] = S.reviewedFeatures({...geometry, features: [geometry.features[0]]}, {G1: {kind: 'tree'}}, labels);
    assert.deepStrictEqual(f.p.map(p => p.map(v => +v.toFixed(6))), [[15, 14]]);
});

test('ear clipping covers a concave polygon exactly', () => {
    const poly = [[0, 0], [4, 0], [4, 4], [2, 1], [0, 4]];
    const tri = S.triangulate(poly);
    const area = t => Math.abs((poly[t[1]][0] - poly[t[0]][0]) * (poly[t[2]][1] - poly[t[0]][1]) - (poly[t[2]][0] - poly[t[0]][0]) * (poly[t[1]][1] - poly[t[0]][1])) / 2;
    assert.strictEqual(tri.length, 3);
    assert.strictEqual(tri.reduce((s, t) => s + area(t), 0), 10);
});

test('GLB has a valid header, JSON chunk and flat-elevation labelling', () => {
    const features = S.reviewedFeatures(geometry, {G1: {kind: 'building', height: 6, status: 'accepted'}, G2: {status: 'accepted'}}, labels);
    const site = S.buildSite({job, geometry, features, labels});
    const glb = Buffer.from(S.buildGlb(site, labels));
    assert.strictEqual(glb.readUInt32LE(0), 0x46546C67);
    assert.strictEqual(glb.readUInt32LE(4), 2);
    assert.strictEqual(glb.readUInt32LE(8), glb.length);
    const jsonLength = glb.readUInt32LE(12);
    const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString());
    assert.match(gltf.asset.extras.elevation, /^flat/);
    assert.strictEqual(gltf.nodes.length, 3);   // extent plane + two features
    const building = gltf.accessors[gltf.meshes[gltf.nodes[1].mesh].primitives[0].attributes.POSITION];
    assert.strictEqual(building.max[1], 6);
    const summary = S.modelSummary(site, labels);
    assert.strictEqual(summary.contours.available, false);
    assert.strictEqual(summary.features[0].heightSource, 'reviewer estimate, not measured');
});

test('per-photo calibration travels with each feature into the scenario', () => {
    const cal = id => ({id, metres: 1.524, label: 'sidewalk width', segment_px: 150, m_per_px: 0.01016, distance_from_reference_m: 3.2, flags: []});
    const perImage = {
        scale: {mode: 'per-image', m_per_px: 0.01, origin_px: [0, 0], references: 2,
            images: [{frame: 'f0001', source: 'IMG_1.jpg', reference: 'D1', metres: 1.524, label: 'sidewalk width', segment_px: 150, m_per_px: 0.01016, flags: []},
                {frame: 'f0002', source: 'IMG_2.jpg', reference: 'D2', metres: 3, label: 'tape', segment_px: 200, m_per_px: 0.015, flags: ['reference end near the photo edge, where lens distortion is strongest']}]},
        features: [
            {id: 'G1', kind: 'grass', predicted_kind: 'grass', geometry: 'area', p: square, region: square, confidence: 0.7, frames: ['f0001'], flags: [], image: {frame: 'f0001', source: 'IMG_1.jpg'}, calibration: cal('D1')},
            {id: 'G2', kind: 'path', predicted_kind: 'path', geometry: 'line', p: [[30, 5], [36, 13]], region: square, confidence: 0.7, frames: ['f0002'], flags: [], width_m: 1.5, image: {frame: 'f0002', source: 'IMG_2.jpg'}, calibration: cal('D2')},
        ],
    };
    const features = S.reviewedFeatures(perImage, {G1: {status: 'accepted'}, G2: {status: 'accepted'}}, labels);
    assert.deepStrictEqual(features[0].size, {area_m2: 80});
    assert.deepStrictEqual(features[1].size, {length_m: 10});
    const site = restore(S.buildSite({job: {...job, original: {name: 'IMG_1.jpg'}}, geometry: perImage, features, labels}));
    assert.strictEqual(site.features[0].intake.sourceImage, 'IMG_1.jpg');
    assert.strictEqual(site.features[0].intake.calibration.id, 'D1');
    assert.strictEqual(site.features[1].intake.calibration.id, 'D2');
    assert.deepStrictEqual(site.features[1].intake.approximateSize, {length_m: 10});
    assert.strictEqual(site.localScale.images.length, 2);
    assert.match(site.localScale.limits, /Approximate/);
});
