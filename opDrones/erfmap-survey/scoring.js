// Proposal scoring: each proposed change is compared against current conditions.
// Everything here is a transparent estimate from measurable map quantities, with
// editable unit rates and stated assumptions. It is not a design review.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined') module.exports = api; else root.proposalScoring = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    // Cost per unit, in dollars. Areas are per m², lines per m (or per m² of a
    // line with a width), points per item. Editable in the Score panel.
    const RATES = {
        building: {label: 'Building', unit: 'm²', rate: 2500},
        pavement: {label: 'Paving / plaza', unit: 'm²', rate: 120},
        road: {label: 'Road surface', unit: 'm²', rate: 150},
        roadLine: {label: 'Road', unit: 'm²', rate: 150},
        path: {label: 'Hard path', unit: 'm²', rate: 95},
        softPath: {label: 'Dirt / desire path', unit: 'm²', rate: 25},
        crossing: {label: 'Crossing', unit: 'm', rate: 200},
        grass: {label: 'Lawn / garden', unit: 'm²', rate: 15},
        shrub: {label: 'Shrub planting', unit: 'm²', rate: 45},
        soil: {label: 'Bare soil', unit: 'm²', rate: 5},
        water: {label: 'Pond / water', unit: 'm²', rate: 300},
        canopy: {label: 'Canopy planting', unit: 'm²', rate: 60},
        greenroof: {label: 'Green roof', unit: 'm²', rate: 250},
        solar: {label: 'Solar panels', unit: 'm²', rate: 400},
        fence: {label: 'Fence', unit: 'm', rate: 80},
        tree: {label: 'Tree', unit: 'each', rate: 650},
        bush: {label: 'Bush', unit: 'each', rate: 60},
        bench: {label: 'Bench', unit: 'each', rate: 1500},
        light: {label: 'Light post', unit: 'each', rate: 4000},
        bin: {label: 'Bin', unit: 'each', rate: 800},
        fountain: {label: 'Drinking fountain', unit: 'each', rate: 3500},
        drainage: {label: 'Drain', unit: 'each', rate: 1200},
        birdhouse: {label: 'Bird / bat house', unit: 'each', rate: 150},
        dangerSign: {label: 'Sign', unit: 'each', rate: 200},
        removeArea: {label: 'Removal (areas)', unit: 'm²', rate: 60},
        removeLine: {label: 'Removal (lines)', unit: 'm', rate: 20},
        removeItem: {label: 'Removal (items)', unit: 'each', rate: 250},
        removeTree: {label: 'Tree removal', unit: 'each', rate: 900},
    };
    const ASSUMPTIONS = {
        rateUncertainty: .3,          // ± share on every unit rate
        lowConfidence: .7,            // features below this model confidence widen ranges
        crownRadius: .25,             // tree crown radius as a share of its maximum growth
        shadeReach: 1,                // shade counts within the crown radius times this
        accessReach: 10,              // metres from an access point or amenity to a path
        joinTolerance: 1.5,           // metres: path ends this close count as connected
        visitsPerDay: 200,            // baseline visits per day for the activity estimate
    };
    const PERMEABLE = new Set(['grass', 'shrub', 'soil', 'water']);
    const IMPERVIOUS = new Set(['building', 'pavement', 'road']);
    const SOFT_PATHS = new Set(['Dirt', 'Desire path']);
    const VEGETATION = new Set(['grass', 'shrub', 'canopy', 'greenroof']);
    const RUBRIC = [
        {score: 'Ecology', weight: '0–100', parts: [
            ['Permeable ground share', 40, 'grass, shrubs, soil and water minus hard paths laid over them'],
            ['Vegetation share', 40, 'lawn, shrubs, canopy, green roofs and tree crowns, capped at the site area'],
            ['Tree canopy cover', 20, 'full marks at 30% of the site under crowns']]},
        {score: 'Satisfaction', weight: '0–100', parts: [
            ['Access', 25, 'access points and amenities within reach of the main connected path network'],
            ['Shade', 20, 'share of path length under a tree crown'],
            ['Seating', 20, 'full marks at 2 benches per 100 m of path'],
            ['Connectivity', 20, 'share of path length in the largest connected network'],
            ['Lighting', 15, 'full marks at 3 lights per 100 m of path']]},
        {score: 'Likely activity', weight: 'visits/day', parts: [
            ['Satisfaction ratio', 100, 'baseline visits × scenario satisfaction ÷ baseline satisfaction']]},
        {score: 'Cost', weight: '$', parts: [
            ['Quantities × unit rates', 100, 'added items at build rates, removed items at removal rates, edits by changed quantity']]},
    ];

    // ---------------------------------------------------------------- geometry
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const segs = p => p.slice(1).map((q, i) => [p[i], q]);
    const length = p => segs(p).reduce((s, [a, b]) => s + dist(a, b), 0);
    const polyArea = p => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - a[1] * b[0]; }, 0)) / 2;
    function inside(p, poly) {
        let hit = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const a = poly[i], b = poly[j];
            if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
        }
        return hit;
    }
    function segPoint(p, a, b) {
        const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
        const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
        return dist(p, [a[0] + t * dx, a[1] + t * dy]);
    }
    function crosses(a, b, c, d) {
        const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
        return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
    }
    function along(p, step) {
        const out = [];
        for (const [a, b] of segs(p)) {
            const n = Math.max(1, Math.ceil(dist(a, b) / step));
            for (let i = 0; i < n; i++) out.push([a[0] + (b[0] - a[0]) * (i + .5) / n, a[1] + (b[1] - a[1]) * (i + .5) / n, dist(a, b) / n]);
        }
        return out;
    }

    const geometryOf = (f, kinds) => (kinds && kinds[f.kind] ? kinds[f.kind][2] : f.p.length === 1 ? 'point' : 'area');
    const widthOf = f => Number(f.tagProperties?.width) || (f.kind === 'roadLine' ? 6 : f.kind === 'path' ? 1.8 : 1);
    const isPathway = f => ['path', 'crossing'].includes(f.kind) || (f.kind === 'roadLine' && f.tagProperties?.surface === 'Sidewalk');
    const crown = (f, a) => Math.max(1, (Number(f.tagProperties?.maxGrowth) || 12) * a.crownRadius);

    // Quantity and rate key for one feature.
    function quantity(f, kinds) {
        const g = geometryOf(f, kinds);
        if (g === 'point') return {amount: 1, unit: 'each', key: f.kind};
        if (g === 'line') {
            if (f.kind === 'crossing' || f.kind === 'fence') return {amount: length(f.p), unit: 'm', key: f.kind};
            const soft = f.kind === 'path' && SOFT_PATHS.has(f.tagProperties?.surface);
            return {amount: length(f.p) * widthOf(f), unit: 'm²', key: soft ? 'softPath' : f.kind, length: length(f.p)};
        }
        return {amount: polyArea(f.p), unit: 'm²', key: f.kind};
    }

    // ---------------------------------------------------------------- measures
    function measure(features, site, kinds, a) {
        const siteArea = Math.max(1, site.w * site.h);
        const areaOf = k => features.filter(f => f.kind === k && geometryOf(f, kinds) === 'area').reduce((s, f) => s + polyArea(f.p), 0);
        const permeablePolys = features.filter(f => PERMEABLE.has(f.kind) && geometryOf(f, kinds) === 'area');
        let permeable = permeablePolys.reduce((s, f) => s + polyArea(f.p), 0), paved = 0;
        let impervious = features.filter(f => IMPERVIOUS.has(f.kind) && geometryOf(f, kinds) === 'area').reduce((s, f) => s + polyArea(f.p), 0);
        // Hard areas and lines laid over permeable ground take that ground away.
        for (const f of features.filter(f => IMPERVIOUS.has(f.kind) && geometryOf(f, kinds) === 'area')) {
            const xs = f.p.map(q => q[0]), ys = f.p.map(q => q[1]);
            const step = Math.max(.5, Math.sqrt(polyArea(f.p) / 400));
            for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step)
                for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step)
                    if (inside([x, y], f.p) && permeablePolys.some(poly => poly !== f && inside([x, y], poly.p))) paved += step * step;
        }
        for (const f of features.filter(f => (f.kind === 'path' && !SOFT_PATHS.has(f.tagProperties?.surface)) || f.kind === 'roadLine')) {
            for (const [x, y, l] of along(f.p, 2)) {
                const covered = l * widthOf(f);
                impervious += covered;
                if (permeablePolys.some(poly => inside([x, y], poly.p))) paved += covered;
            }
        }
        permeable = Math.max(0, permeable - paved);
        const trees = features.filter(f => f.kind === 'tree');
        const crownArea = trees.reduce((s, f) => s + Math.PI * crown(f, a) ** 2, 0) + areaOf('canopy');
        const vegetation = Math.max(0, Math.min(siteArea, [...VEGETATION].reduce((s, k) => s + areaOf(k), 0) + trees.reduce((s, f) => s + Math.PI * crown(f, a) ** 2, 0) + features.filter(f => f.kind === 'bush').length * 1.5 - paved));

        // Path network: segments joined when they touch, cross or end close by.
        const paths = features.filter(isPathway).filter(f => f.p.length >= 2);
        const parts = paths.flatMap(f => segs(f.p).map(s => ({s, f, len: dist(...s)})));
        const parent = parts.map((_, i) => i), find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
        for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
            const [a1, b1] = parts[i].s, [a2, b2] = parts[j].s, tol = a.joinTolerance;
            if (crosses(a1, b1, a2, b2) || Math.min(segPoint(a1, a2, b2), segPoint(b1, a2, b2), segPoint(a2, a1, b1), segPoint(b2, a1, b1)) <= tol)
                parent[find(i)] = find(j);
        }
        const groups = new Map();
        parts.forEach((p, i) => groups.set(find(i), (groups.get(find(i)) || 0) + p.len));
        const pathLength = parts.reduce((s, p) => s + p.len, 0);
        const mainRoot = [...groups.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
        const mainLength = mainRoot === undefined ? 0 : groups.get(mainRoot);
        const nearMain = p => parts.some((q, i) => find(i) === mainRoot && segPoint(p, ...q.s) <= a.accessReach);
        const targets = features.filter(f => ['entrance', 'destination', 'bench', 'bin', 'fountain', 'light'].includes(f.kind));
        const reached = targets.filter(f => nearMain(f.p[0])).length;
        const canopyPolys = features.filter(f => f.kind === 'canopy' && geometryOf(f, kinds) === 'area');
        let shaded = 0;
        for (const part of parts) for (const [x, y, l] of along(part.s, 2))
            if (trees.some(t => dist([x, y], t.p[0]) <= crown(t, a) * a.shadeReach) || canopyPolys.some(c => inside([x, y], c.p))) shaded += l;
        const benches = features.filter(f => f.kind === 'bench').length, lights = features.filter(f => f.kind === 'light').length;
        const per100 = n => pathLength > 0 ? n / pathLength * 100 : 0;

        const m = {
            siteArea, permeable, impervious, vegetation, crownArea, trees: trees.length, pathLength, mainLength,
            networks: groups.size, benches, lights, accessTargets: targets.length, accessReached: reached, shadedLength: shaded,
        };
        const share = (x, y) => (y > 0 ? x / y : 0);
        m.parts = {
            permeable: 40 * Math.min(1, share(permeable, siteArea)),
            vegetation: 40 * Math.min(1, share(vegetation, siteArea)),
            canopy: 20 * Math.min(1, share(crownArea, siteArea) / .3),
            access: 25 * (targets.length ? share(reached, targets.length) : pathLength > 0 ? 1 : 0),
            shade: 20 * share(shaded, pathLength),
            seating: 20 * Math.min(1, per100(benches) / 2),
            connectivity: 20 * share(mainLength, pathLength),
            lighting: 15 * Math.min(1, per100(lights) / 3),
        };
        m.ecology = m.parts.permeable + m.parts.vegetation + m.parts.canopy;
        m.satisfaction = m.parts.access + m.parts.shade + m.parts.seating + m.parts.connectivity + m.parts.lighting;
        return m;
    }

    // ---------------------------------------------------------------- changes
    const keyOf = (f, i) => f._syncId || 'feature-' + i + '-' + f.kind;
    const strip = f => JSON.stringify({kind: f.kind, p: f.p, tagProperties: f.tagProperties || null, height: f.height ?? null, itemType: f.itemType || null});
    function baselineFeatures(site) {
        if (Array.isArray(site.scoring?.baseline?.features)) return site.scoring.baseline.features;
        return site.features.filter(f => f.source !== 'Proposed');
    }
    function changes(site) {
        const before = baselineFeatures(site), after = site.features;
        const b = new Map(before.map((f, i) => [keyOf(f, i), f])), a = new Map(after.map((f, i) => [keyOf(f, i), f]));
        const out = [];
        for (const [id, f] of a) {
            if (!b.has(id)) out.push({id, type: 'added', feature: f});
            else if (strip(b.get(id)) !== strip(f)) out.push({id, type: 'edited', feature: f, previous: b.get(id)});
        }
        for (const [id, f] of b) if (!a.has(id)) out.push({id, type: 'removed', feature: f});
        return {before, out};
    }
    function costOf(change, kinds, rates) {
        const rate = k => (rates[k] ?? RATES[k]?.rate ?? 0);
        const f = change.feature, q = quantity(f, kinds);
        if (change.type === 'added') return {amount: q.amount * rate(q.key), detail: fmt(q.amount) + ' ' + q.unit + ' × $' + fmt(rate(q.key)) + ' (' + (RATES[q.key]?.label || q.key) + ')'};
        if (change.type === 'removed') {
            const key = f.kind === 'tree' ? 'removeTree' : q.unit === 'each' ? 'removeItem' : q.unit === 'm' || q.length ? 'removeLine' : 'removeArea';
            const amount = key === 'removeLine' ? (q.length ?? q.amount) : q.amount;
            return {amount: amount * rate(key), detail: fmt(amount) + ' ' + RATES[key].unit + ' × $' + fmt(rate(key)) + ' (' + RATES[key].label + ')'};
        }
        const p = quantity(change.previous, kinds);
        const grown = Math.max(0, q.amount - (p.key === q.key ? p.amount : 0));
        const rework = .1 * q.amount * rate(q.key);
        return {amount: grown * rate(q.key) + rework, detail: (grown ? fmt(grown) + ' ' + q.unit + ' added × $' + fmt(rate(q.key)) + ' + ' : '') + '10% rework of the edited item'};
    }
    const fmt = v => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : (+v.toFixed(1)).toString());
    function apply(before, change) {
        if (change.type === 'added') return [...before, change.feature];
        const id = change.id;
        return before.flatMap((f, i) => keyOf(f, i) !== id ? [f] : change.type === 'removed' ? [] : [change.feature]);
    }

    // ---------------------------------------------------------------- evaluate
    function evaluate(site, options = {}) {
        const kinds = options.kinds || null;
        const rates = {...Object.fromEntries(Object.entries(RATES).map(([k, v]) => [k, v.rate])), ...(site.scoring?.rates || {}), ...(options.rates || {})};
        const a = {...ASSUMPTIONS, ...(site.scoring?.assumptions || {}), ...(options.assumptions || {})};
        // Optimistic and pessimistic readings of the same plan bound the scores.
        const low = {...a, crownRadius: a.crownRadius * .7, shadeReach: .8, accessReach: a.accessReach * .6, joinTolerance: a.joinTolerance * .5};
        const high = {...a, crownRadius: a.crownRadius * 1.3, shadeReach: 1.2, accessReach: a.accessReach * 1.5, joinTolerance: a.joinTolerance * 2};
        const {before, out} = changes(site);
        const measured = features => ({mid: measure(features, site, kinds, a), low: measure(features, site, kinds, low), high: measure(features, site, kinds, high)});
        const base = measured(before), now = measured(site.features);
        const delta = (x, y, k) => {
            const values = ['low', 'mid', 'high'].map(v => y[v][k] - x[v][k]);
            return {mid: values[1], low: Math.min(...values), high: Math.max(...values)};
        };
        const activity = (x, y) => {
            const r = v => (x[v].satisfaction > 0 ? y[v].satisfaction / x[v].satisfaction : y[v].satisfaction > 0 ? 1.5 : 1) * a.visitsPerDay - a.visitsPerDay;
            const values = ['low', 'mid', 'high'].map(r);
            return {mid: values[1], low: Math.min(...values), high: Math.max(...values)};
        };
        const scored = out.map(change => {
            const after = measured(apply(before, change));
            const cost = costOf(change, kinds, rates);
            const confidence = change.feature.intake?.confidence;
            const unsure = typeof confidence === 'number' && confidence < a.lowConfidence;
            const spread = a.rateUncertainty + (unsure ? .2 : 0);
            const notes = [];
            if (unsure) notes.push('Model confidence ' + Math.round(confidence * 100) + '%: quantity may be off; range widened.');
            if (geometryOf(change.feature, kinds) === 'area' && change.feature.kind === 'grass') notes.push('Lawn area may overlap paths drawn on top; permeable gain is net of hard paths.');
            return {
                id: change.id, type: change.type, kind: change.feature.kind, name: change.feature.name || RATES[change.feature.kind]?.label || change.feature.kind,
                quantity: quantity(change.feature, kinds),
                cost: {mid: cost.amount, low: cost.amount * (1 - spread), high: cost.amount * (1 + spread), detail: cost.detail},
                ecology: delta(base, after, 'ecology'), satisfaction: delta(base, after, 'satisfaction'), activity: activity(base, after),
                permeable: after.mid.permeable - base.mid.permeable, vegetation: after.mid.vegetation - base.mid.vegetation, notes,
            };
        });
        const totalCost = scored.reduce((s, c) => ({mid: s.mid + c.cost.mid, low: s.low + c.cost.low, high: s.high + c.cost.high}), {mid: 0, low: 0, high: 0});
        const warnings = [];
        if (!site.scoring?.baseline) warnings.push('Current conditions are every item not marked Proposed. Set a baseline to compare against a saved state instead.');
        if (!base.mid.pathLength) warnings.push('No paths in current conditions: shade, seating, lighting and connectivity have nothing to measure against.');
        if (site.localScale?.unreferenced) warnings.push('Survey is locally scaled from a measured distance, so areas and lengths carry that scale error.');
        return {
            baseline: base.mid, scenario: now.mid, changes: scored,
            totals: {cost: totalCost, ecology: delta(base, now, 'ecology'), satisfaction: delta(base, now, 'satisfaction'), activity: activity(base, now),
                ecologyScore: {before: base.mid.ecology, after: now.mid.ecology}, satisfactionScore: {before: base.mid.satisfaction, after: now.mid.satisfaction}},
            rates, assumptions: a, rubric: RUBRIC, warnings,
            assumptionNotes: [
                'Unit rates are planning placeholders in US dollars; replace them with local quotes.',
                'Cost ranges add ±' + Math.round(a.rateUncertainty * 100) + '% to every rate, plus ±20% for items detected with low model confidence.',
                'Tree crowns are circles with radius ' + a.crownRadius + ' × maximum growth; the low and high cases use ±30%.',
                'Access counts entrances, destinations and amenities within ' + a.accessReach + ' m of the main path network.',
                'Likely activity scales ' + a.visitsPerDay + ' baseline visits/day by the change in satisfaction. It is a proxy, not a forecast.',
                'Ecology and satisfaction are 0–100 indices from the rubric; each change is scored on its own against current conditions, so changes that work together can score more as a set.',
            ],
        };
    }
    return {RATES, ASSUMPTIONS, RUBRIC, evaluate, measure, changes, quantity};
});
