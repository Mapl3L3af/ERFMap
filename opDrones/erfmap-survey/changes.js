// A commit includes only features and project fields touched by that edit.
const projectChanges = (() => {
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const index = site => new Map(site.features.map(f => [f._syncId, f]));
    const fields = ['name','demo','w','h','samples','origin','contours','showContours','pedestrians','environment'];
    function diff(previous, next) {
        const before = index(previous), after = index(next);
        const put = next.features.filter(f => !equal(before.get(f._syncId), f));
        const remove = [...before.keys()].filter(id => !after.has(id));
        const meta = Object.fromEntries(fields.filter(k => !equal(previous[k], next[k])).map(k => [k, next[k] ?? null]));
        if (put.length || remove.length || Object.keys(meta).length) return {put, remove, meta};
    }
    function apply(site, patch) {
        const features = index(site);
        for (const id of patch.remove) features.delete(id);
        for (const feature of patch.put) {
            if (typeof feature._syncId !== 'string' || !feature._syncId.length) throw Error('Missing feature ID.');
            features.set(feature._syncId, feature);
        }
        const next = {...site, features: [...features.values()]};
        for (const key of fields) if (Object.hasOwn(patch.meta,key)) {
            if (patch.meta[key] === null) delete next[key]; else next[key] = patch.meta[key];
        }
        return next;
    }
    return {diff, apply};
})();
if (typeof module !== 'undefined') module.exports = projectChanges;
