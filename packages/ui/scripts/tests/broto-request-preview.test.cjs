// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const vm=require('node:vm');
const React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const {buildSync}=require('esbuild');
const result=buildSync({entryPoints:[path.resolve(__dirname,'../../src/desktop/BrotoRequestPreview.jsx')],bundle:true,write:false,format:'cjs',platform:'node',external:['react']});
const moduleFixture={exports:{}};
vm.runInNewContext(result.outputFiles[0].text,{require,module:moduleFixture,exports:moduleFixture.exports});
const Preview=moduleFixture.exports.default;
test('approval preview shows the bound command summary as escaped plain text',()=>{
  const html=renderToStaticMarkup(React.createElement(Preview,{request:{cmd:'exec',summary:'exec <script>alert(1)</script>\nargs ["--all"]\ndir /workspace'}}));
  assert.match(html,/exec &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html,/args \[&quot;--all&quot;\]/);
  assert.match(html,/dir \/workspace/);
  assert.doesNotMatch(html,/<script>/);
});
test('older pending requests still display the operation verb',()=>{
  assert.match(renderToStaticMarkup(React.createElement(Preview,{request:{cmd:'pty.open'}})),/pty.open/);
});
test('argument summaries read as the command, the typed text or nothing',()=>{
  const render=(request)=>renderToStaticMarkup(React.createElement(Preview,{request}));
  assert.match(render({cmd:'exec',summary:'{"command":"git","args":["status","--short"],"dir":"C:\\\\repo"}'}),/git status --short\nC:\\repo/);
  assert.match(render({cmd:'pty.write',summary:'{"id":3,"text":"ls -la\\r"}'}),/ls -la/);
  assert.equal(render({cmd:'pty.open',summary:'{"cols":80,"rows":24}'}),'');
});

test('file preview shows direction path and size without transfer payload',()=>{
  const html=renderToStaticMarkup(React.createElement(Preview,{request:{cmd:'files.put',summary:JSON.stringify({path:'/home/test/file.txt',size:123,data:'secret-payload',sha256:'hash'})}}));
  assert.match(html,/Enviar arquivo ao Broto/);
  assert.match(html,/file.txt/);
  assert.match(html,/123/);
  assert.doesNotMatch(html,/secret-payload|sha256/);
});
