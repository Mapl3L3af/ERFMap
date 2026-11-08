const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function analysis(expression) {
    const source = ['model.js', 'analysis.js'].map(f => fs.readFileSync(path.join(__dirname, '../erfmap-survey', f), 'utf8')).join('\n');
    return vm.runInNewContext(source + '\n' + expression);
}
test('green-space quantities use polygon area and tree counts', () => {
    const html=analysis(`designAnalysisDetails('Green space',{w:100,h:100,features:[{kind:'grass',p:rect(0,0,10,20)},{kind:'canopy',p:rect(0,0,5,5)},{kind:'tree',p:[[2,2]]}]})`);
    assert.match(html,/200 m² · 2%/);
    assert.match(html,/25 m² · 0.3%/);
    assert.match(html,/Trees per hectare<\/span><b>1/);
});
