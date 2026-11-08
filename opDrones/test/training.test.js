const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {createTraining} = require('../intake/training');

test('training activates only successful models and restores them after restart', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'erf-training-'));
    const previous = process.env.ERFMAP_SEGFORMER_MODEL;
    t.after(() => { fs.rmSync(directory,{recursive:true,force:true}); if(previous===undefined)delete process.env.ERFMAP_SEGFORMER_MODEL;else process.env.ERFMAP_SEGFORMER_MODEL=previous; });
    let child, output;
    const service = createTraining({directory,readBody:async()=>({format:'erfmap-semantic-annotations',images:[{}],annotations:[{}],categories:[]}),launch:(_python,args)=>{
        output=args[3];child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();return child;
    }});
    const call = async method => {let result;await service.route({method},{setHeader(){},writeHead(){},end(value){result=JSON.parse(value);}},new URL('http://localhost/api/training'));return result;};
    assert.equal((await call('POST')).status,'training');
    await assert.rejects(call('POST'),{status:409});
    child.stderr.emit('data',Buffer.from('dependency missing'));
    child.emit('close',1);
    assert.equal((await call('GET')).status,'failed');
    assert.equal(process.env.ERFMAP_SEGFORMER_MODEL,previous);
    await call('POST');
    fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'config.json'),'{}');
    child.stdout.emit('data',Buffer.from('{"message":"Epoch 1"}\n'));
    assert.equal((await call('GET')).message,'Epoch 1');
    child.emit('close',0);
    assert.equal((await call('GET')).status,'complete');
    assert.equal(process.env.ERFMAP_SEGFORMER_MODEL,output);
    delete process.env.ERFMAP_SEGFORMER_MODEL;
    createTraining({directory,readBody:async()=>({})});
    assert.equal(process.env.ERFMAP_SEGFORMER_MODEL,output);
});
