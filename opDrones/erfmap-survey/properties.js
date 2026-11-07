const propertiesDialog = document.getElementById('propertiesDialog');
const propertiesFields = document.getElementById('propertiesFields');
const locationSides = ['Entire feature', 'North side', 'East side', 'South side', 'West side', 'Left side', 'Right side'];
let pendingAddType = null;

function propertyCompatibleTypes(feature) {
    const geometry = kinds[feature.kind][2];
    return Object.entries(featureTypes).filter(([key, type]) => key === 'unknown' || kinds[type.kind][2] === geometry);
}

function propertyOptions(selected, feature) {
    const options = propertyCompatibleTypes(feature);
    const categories = [...new Set(options.map(([, type]) => type.category))];
    return categories.map(category => '<optgroup label="' + esc(category) + '">' + options.filter(([, type]) => type.category === category).map(([key, type]) => '<option value="' + key + '" ' + (key === selected ? 'selected' : '') + '>' + esc(type.label) + '</option>').join('') + '</optgroup>').join('');
}

function propertyFieldMarkup(field, values, disabled = false) {
    const value = values[field.key] ?? field.default ?? '';
    const id = 'tag_' + field.key;
    if (field.type === 'select') {
        return '<label>' + esc(field.label) + '<select id="' + id + '" ' + (disabled ? 'disabled' : '') + '>' + field.options.map(option => '<option value="' + esc(option) + '" ' + (String(option) === String(value) ? 'selected' : '') + '>' + esc(option) + '</option>').join('') + '</select></label>';
    }
    if (field.type === 'number') {
        return '<label>' + esc(field.label) + '<input id="' + id + '" type="number" value="' + esc(value) + '" min="' + field.min + '" max="' + field.max + '" step="' + field.step + '" required></label>';
    }
    return '<label>' + esc(field.label) + '<input id="' + id + '" type="text" value="' + esc(value) + '"></label>';
}

function readTagValues(type) {
    const values = {};
    for (const field of type.fields || []) {
        const input = document.getElementById('tag_' + field.key);
        if (!input) continue;
        values[field.key] = field.type === 'number'
            ? (input.value.trim() === '' ? NaN : Number(input.value))
            : input.value;
    }
    const side = document.getElementById('tag_side');
    if (side) values.side = side.value;
    return values;
}

function renderPropertiesFields(feature, typeKey, values, customColor, colorValue, pending = false, target = propertiesFields) {
    const type = featureTypes[typeKey];
    const point = kinds[featureKindForType(typeKey, values)][2] === 'point';
    const location = pending
        ? '<div class="property-location"><h3>Placement</h3><p>After saving, the item will attach to the cursor. Click the map to place it; draw vertices for continuous items.</p></div>'
        : point
        ? '<div class="property-location"><h3>Location · local metres</h3><p>X is east; Y is south. Coordinates are editable.</p><div class="property-grid coordinate-grid"><label>X<input id="tag_x" type="number" step="0.01" value="' + Number(feature.p[0][0]).toFixed(2) + '" required></label><label>Y<input id="tag_y" type="number" step="0.01" value="' + Number(feature.p[0][1]).toFixed(2) + '" required></label></div></div>'
        : '<div class="property-location"><h3>Locations · local metres</h3><p>Ordered geometry vertices (X east, Y south). Move vertices on the map.</p><pre class="coordinate-list">' + esc(feature.p.map((point, index) => (index + 1) + '.  X ' + Number(point[0]).toFixed(2) + ' m,  Y ' + Number(point[1]).toFixed(2) + ' m').join('\n')) + '</pre><label>Location side<select id="tag_side">' + locationSides.map(side => '<option value="' + side + '" ' + ((values.side || 'Entire feature') === side ? 'selected' : '') + '>' + side + '</option>').join('') + '</select></label></div>';
    const visualColor = customColor ? colorValue : featureColor({ kind: featureKindForType(typeKey, values), itemType: typeKey, tagProperties: values });
    target.innerHTML = '<div class="property-grid"><label>Item name<input id="tag_name" maxlength="100" value="' + esc(feature.name) + '" required></label><label>Item type<select id="propertyType">' + propertyOptions(typeKey, feature) + '</select></label><label class="color-toggle"><span>Color</span><span><input id="tag_customColor" type="checkbox" ' + (customColor ? 'checked' : '') + '> Use custom color</span></label><label>Color<input id="tag_color" type="color" value="' + visualColor + '" ' + (customColor ? '' : 'disabled') + '></label></div><div class="tag-preview"><span id="tag_swatch" style="background:' + visualColor + '"></span><span id="tag_colorLabel">' + (customColor ? 'Custom item color' : 'Color follows the selected type and specifications') + '</span></div><section class="property-specs"><h3>Specifications</h3>' + ((type.fields || []).length ? '<div class="property-grid">' + type.fields.map(field => propertyFieldMarkup(field, values, field.key === 'geometry' && !pending)).join('') + '</div>' : '<p class="property-help">This item has no additional specifications.</p>') + '</section>' + location;
}

function propertyEditorData(feature) {
    const storedType = featureTypes[feature.itemType];
    const typeKey = storedType && kinds[storedType.kind][2] === kinds[feature.kind][2] ? feature.itemType : defaultItemTypeForKind(feature.kind);
    const type = featureTypes[typeKey];
    const values = Object.fromEntries((type.fields || []).map(field => [field.key, feature.tagProperties?.[field.key] ?? field.default]));
    if (typeKey === 'unknown') values.geometry = ({ area: 'Area', line: 'Line', point: 'Point' })[kinds[feature.kind][2]];
    if (feature.kind === 'pavement' && feature.tagProperties?.surface === undefined && values.surface !== undefined) values.surface = 'Sidewalk';
    values.side = feature.tagProperties?.side || 'Entire feature';
    const customColor = /^#[\da-f]{6}$/i.test(feature.color || '');
    const color = customColor ? feature.color : featureColor({ kind: featureKindForType(typeKey, values), itemType: typeKey, tagProperties: values });
    return { typeKey, values, customColor, color };
}

function renderPropertiesPanel() {
    const target = document.getElementById('propertiesPanelFields');
    const feature = site.features[sel];
    if (!target || !feature) return;
    const { typeKey, values, customColor, color } = propertyEditorData(feature);
    renderPropertiesFields(feature, typeKey, values, customColor, color, false, target);
    target.querySelector('#propertyType').dataset.previousType = typeKey;
}

function openProperties() {
    pendingAddType = null;
    view3 = false;
    panMode = false;
    tab = 'Properties';
    folded = false;
    msg = '';
    render();
}

function openNewFeatureProperties(typeKey) {
    const type = featureTypes[typeKey];
    pendingAddType = typeKey;
    const values = Object.fromEntries((type.fields || []).map(field => [field.key, field.default]));
    if (kinds[type.kind][2] !== 'point') values.side = 'Entire feature';
    const feature = { kind: type.kind, itemType: typeKey, name: type.label, tagProperties: values };
    const color = featureColor(feature);
    renderPropertiesFields(feature, typeKey, values, false, color, true);
    document.getElementById('propertyType').dataset.previousType = typeKey;
    document.getElementById('propertiesMessage').textContent = '';
    if (!propertiesDialog.open) propertiesDialog.showModal();
    document.getElementById('tag_name').focus();
}

function updateTagPreview() {
    const typeKey = document.getElementById('propertyType')?.value;
    const type = featureTypes[typeKey];
    if (!type) return;
    const custom = document.getElementById('tag_customColor').checked;
    const colorInput = document.getElementById('tag_color');
    const values = readTagValues(type);
    const color = custom ? colorInput.value : featureColor({ kind: featureKindForType(typeKey, values), itemType: typeKey, tagProperties: values });
    colorInput.disabled = !custom;
    if (!custom) colorInput.value = color;
    document.getElementById('tag_swatch').style.background = color;
    document.getElementById('tag_colorLabel').textContent = custom ? 'Custom item color' : 'Color follows the selected type and specifications';
}

document.addEventListener('change', event => {
    if (event.target.id === 'propertyType') {
        const previousTypeKey = event.target.dataset.previousType || pendingAddType;
        const pending = pendingAddType !== null;
        const feature = pending ? { kind: featureTypes[previousTypeKey].kind, name: document.getElementById('tag_name').value } : site.features[sel];
        if (!feature) return;
        const previous = readTagValues(featureTypes[previousTypeKey] || featureTypes[defaultItemTypeForKind(feature.kind)]);
        const type = featureTypes[event.target.value];
        const nextName = pending && feature.name === featureTypes[previousTypeKey].label ? type.label : feature.name;
        const values = Object.fromEntries((type.fields || []).map(field => [field.key, field.default]));
        if (event.target.value === 'unknown') values.geometry = ({ area: 'Area', line: 'Line', point: 'Point' })[kinds[feature.kind][2]];
        values.side = previous.side || 'Entire feature';
        const custom = document.getElementById('tag_customColor').checked;
        const target = event.target.closest('#propertiesPanelFields') || propertiesFields;
        renderPropertiesFields({ ...feature, kind: featureKindForType(event.target.value, values), name: nextName }, event.target.value, values, custom, document.getElementById('tag_color').value, pending, target);
        target.querySelector('#propertyType').dataset.previousType = event.target.value;
        if (pending) pendingAddType = event.target.value;
        updateTagPreview();
    } else if (event.target.id.startsWith('tag_')) {
        updateTagPreview();
    }
});

document.addEventListener('input', event => {
    if (event.target.id.startsWith('tag_') && event.target.id !== 'tag_name' && event.target.id !== 'tag_x' && event.target.id !== 'tag_y') updateTagPreview();
});

document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.id === 'closeProperties' || button.id === 'cancelProperties') {
        pendingAddType = null;
        propertiesDialog.close();
        return;
    }
    const panelEdit = button.id === 'applyPanelProperties';
    if (button.id !== 'applyProperties' && !panelEdit) return;
    const typeKey = document.getElementById('propertyType').value;
    const type = featureTypes[typeKey];
    const adding = pendingAddType !== null;
    const values = readTagValues(type);
    const nextKind = featureKindForType(typeKey, values);
    const feature = adding ? { kind: nextKind } : site.features[sel];
    const name = document.getElementById('tag_name').value.trim();
    const message = panelEdit ? document.getElementById('propertiesPanelMessage') : document.getElementById('propertiesMessage');
    if (!feature || !name) {
        message.textContent = 'Give this item a name before saving.';
        return;
    }
    if ((type.fields || []).some(field => field.type === 'number' && (!Number.isFinite(values[field.key]) || values[field.key] < field.min || values[field.key] > field.max))) {
        message.textContent = 'Check the numeric specifications and keep them within the shown limits.';
        return;
    }
    let point = null;
    if (!adding && kinds[nextKind][2] === 'point') {
        const x = document.getElementById('tag_x').value.trim();
        const y = document.getElementById('tag_y').value.trim();
        point = [x === '' ? NaN : Number(x), y === '' ? NaN : Number(y)];
        if (!point.every(Number.isFinite) || point[0] < 0 || point[0] > site.w || point[1] < 0 || point[1] > site.h) {
            message.textContent = 'Point coordinates must be within the site in local metres.';
            return;
        }
    }
    const useCustomColor = document.getElementById('tag_customColor').checked;
    const color = document.getElementById('tag_color').value;
    if (adding) {
        const item = { kind: nextKind, itemType: typeKey, name, tagProperties: values };
        if (kinds[nextKind][2] !== 'point' && !item.tagProperties.side) item.tagProperties.side = 'Entire feature';
        if (useCustomColor) item.color = color;
        pendingAddType = null;
        beginFeaturePlacement(item);
        propertiesDialog.close();
        return;
    }
    checkpoint();
    feature.kind = nextKind;
    feature.itemType = typeKey;
    feature.name = name;
    feature.tagProperties = values;
    if (useCustomColor) feature.color = color;
    else delete feature.color;
    if (point) feature.p = [point];
    feature.source = 'Edited';
    commit();
    if (!panelEdit && propertiesDialog.open) propertiesDialog.close();
});

propertiesDialog.addEventListener('click', event => {
    if (event.target === propertiesDialog) propertiesDialog.close();
});
propertiesDialog.addEventListener('close', () => {
    pendingAddType = null;
});
