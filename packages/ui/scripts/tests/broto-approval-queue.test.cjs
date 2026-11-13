// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const vm=require('node:vm');
const fs=require('node:fs');
const {buildSync}=require('esbuild');
const bundle=buildSync({entryPoints:[path.resolve(__dirname,'../../src/desktop/BrotoApprovals.jsx')],bundle:true,write:false,format:'cjs',platform:'node',external:['react']});
const mod={exports:{}};
vm.runInNewContext(bundle.outputFiles[0].text,{require,module:mod,exports:mod.exports,TextDecoder,TextEncoder,URL});
test('approval queue preserves every request and clamps navigation after a decision',()=>{
  assert.equal(typeof mod.exports.approvalQueues,'function');
  const requests=[{id:3,deviceId:'alpha'},{id:4,deviceId:'beta'},{id:5,deviceId:'alpha'}];
  let queues=mod.exports.approvalQueues(requests,{alpha:5});
  assert.equal(queues.length,2);
  const alpha=queues.find(q=>q.deviceId==='alpha');
  assert.equal(alpha.requests.length,2);
  assert.equal(alpha.selected.id,5);
  assert.equal(alpha.position,2);
  queues=mod.exports.approvalQueues(requests.filter(r=>r.id!==5),{alpha:5});
  assert.equal(queues.find(q=>q.deviceId==='alpha').selected.id,3);
});
test('Devices keeps the complete AI request list',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../../src/desktop/Brotos.jsx'),'utf8');
  assert.match(source,/<BrotoApprovals\s+allRequests\b/);
});
test('file activity uses catalog labels in all three languages',async()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../../src/broto/main.jsx'),'utf8');
  const keys=vm.runInNewContext('('+source.match(/const ACTIVITY_KEYS = (\{[^\n]+\});/)[1]+')');
  assert.equal(keys['files.put'],'broto.activity.files.put');
  assert.equal(keys['files.get'],'broto.activity.files.get');
  for(const lang of ['pt-BR','en','es']) {
    const file=path.resolve(__dirname,`../../../i18n/src/locales/${lang}/broto.js`);
    const text=fs.readFileSync(file,'utf8');
    assert.match(text,/"broto.activity.files.put"/);
    assert.match(text,/"broto.activity.files.get"/);
  }
});
