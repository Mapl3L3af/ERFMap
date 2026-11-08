const test = require('node:test');
const assert = require('node:assert/strict');
const {demo, kinds} = require('../erfmap-survey/model.js');
const scoring = require('../erfmap-survey/scoring.js');

function site() {
    const s = demo();
    s.features.forEach((f, i) => { f._syncId = 'f' + i; });
    return s;
}
const add = (s, f) => { s.features.push({source: 'Proposed', _syncId: 'p' + s.features.length, ...f}); return s; };

test('no proposals means no changes and zero deltas', () => {
    const r = scoring.evaluate(site(), {kinds});
    assert.equal(r.changes.length, 0);
    assert.equal(r.totals.cost.mid, 0);
    assert.equal(r.totals.ecology.mid, 0);
});

test('cost comes from quantities times editable unit rates, with a range', () => {
    const s = add(site(), {kind: 'pavement', p: [[60, 50], [70, 50], [70, 60], [60, 60]], name: 'Plaza'});
    const r = scoring.evaluate(s, {kinds});
    assert.equal(r.changes[0].cost.mid, 100 * scoring.RATES.pavement.rate);
    assert.ok(r.changes[0].cost.low < r.changes[0].cost.mid && r.changes[0].cost.high > r.changes[0].cost.mid);
    s.scoring = {rates: {pavement: 10}};
    assert.equal(scoring.evaluate(s, {kinds}).changes[0].cost.mid, 1000);
});

test('paving over lawn loses permeable ground and vegetation; a tree gains canopy', () => {
    const plaza = scoring.evaluate(add(site(), {kind: 'pavement', p: [[60, 50], [75, 50], [75, 60], [60, 60]]}), {kinds}).changes[0];
    assert.ok(plaza.permeable < -100 && plaza.vegetation < -100);
    assert.ok(plaza.ecology.mid < 0);
    const tree = scoring.evaluate(add(site(), {kind: 'tree', p: [[59, 40]], tagProperties: {maxGrowth: 18}}), {kinds}).changes[0];
    assert.ok(tree.ecology.mid > 0);
    assert.ok(tree.ecology.low <= tree.ecology.mid && tree.ecology.mid <= tree.ecology.high);
});

test('benches and shade by paths raise satisfaction and likely activity', () => {
    const r = scoring.evaluate(add(site(), {kind: 'bench', p: [[30, 46]]}), {kinds});
    assert.ok(r.changes[0].satisfaction.mid > 0);
    assert.ok(r.changes[0].activity.mid > 0);
    const shade = scoring.evaluate(add(site(), {kind: 'tree', p: [[70, 46]], tagProperties: {maxGrowth: 18}}), {kinds}).changes[0];
    assert.ok(shade.satisfaction.mid > 0, 'a tree beside the central walk shades it');
});

test('a disconnected path lowers connectivity', () => {
    const r = scoring.evaluate(add(site(), {kind: 'path', p: [[100, 70], [115, 70]], tagProperties: {width: 1.8, surface: 'Concrete'}}), {kinds});
    assert.ok(r.scenario.parts.connectivity < r.baseline.parts.connectivity);
});

test('removals and edits are compared against a saved baseline', () => {
    const s = site();
    s.scoring = {baseline: {at: 'now', features: JSON.parse(JSON.stringify(s.features))}};
    s.features = s.features.filter(f => f.kind !== 'bench');
    s.features.find(f => f.name === 'East pavilion').p = [[82, 13], [110, 13], [110, 29], [82, 29]];
    const r = scoring.evaluate(s, {kinds});
    assert.deepEqual(r.changes.map(c => c.type).sort(), ['edited', 'removed']);
    const removed = r.changes.find(c => c.type === 'removed');
    assert.equal(removed.cost.mid, scoring.RATES.removeItem.rate);
    assert.ok(removed.satisfaction.mid < 0);
    const edited = r.changes.find(c => c.type === 'edited');
    assert.ok(edited.cost.mid > 5 * 16 * scoring.RATES.building.rate);       // the added 80 m² at least
});

test('rubric, assumptions and uncertainty are reported', () => {
    const r = scoring.evaluate(add(site(), {kind: 'tree', p: [[59, 40]], intake: {confidence: .4}}), {kinds});
    assert.ok(r.rubric.length >= 4);
    assert.ok(r.assumptionNotes.length >= 4);
    assert.ok(r.changes[0].notes.some(n => /confidence 40%/.test(n)));
    const spread = r.changes[0].cost.high / r.changes[0].cost.mid;
    assert.ok(Math.abs(spread - 1.5) < 1e-9, 'low confidence widens the cost range to ±50%');
});
