// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const vm=require('node:vm');
const React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const {buildSync}=require('esbuild');
const bundle=buildSync({entryPoints:[path.resolve(__dirname,'../../src/broto/main.jsx')],bundle:true,write:false,format:'cjs',platform:'node',external:['react','react-dom/client'],loader:{'.css':'empty','.png':'dataurl'}}).outputFiles[0].text;
const labels={
 'pt-BR':['Arquivo recebido','Arquivo enviado','Falha ao receber arquivo','Falha ao enviar arquivo'],
 en:['File received','File sent','Failed to receive file','Failed to send file'],
 es:['Archivo recibido','Archivo enviado','Error al recibir archivo','Error al enviar archivo'],
};
for(const [locale,expected] of Object.entries(labels)) {
 for(const [index,cmd,outcome] of [[0,'files.put','ok'],[1,'files.get','ok'],[2,'files.put','error'],[3,'files.get','error']]) {
 test(`real monitor renders ${cmd} ${outcome} in ${locale}`,()=>{
  const mod={exports:{}};
  vm.runInNewContext(bundle,{module:mod,exports:mod.exports,require:name=>name==='react-dom/client'?{createRoot:()=>({render(){}})}:require(name),document:{getElementById:()=>({}),documentElement:{dataset:{}}},__CIALAI_SHELL__:{locale}});
   const html=renderToStaticMarkup(React.createElement(mod.exports.MonitorScreen,{status:{state:'connected',host:'Host de teste',transport:'direct',activity:[{ts:'2026-10-28T12:00:00Z',cmd,outcome,actor:'ai',path:'/fixture/<file>.txt',code:outcome==='error'?'file_io_failed':undefined,data:'SECRET_FILE_CONTENT'}]},busy:false,failed:false,onRun(){}}));
   assert.ok(html.includes(expected[index]),`expected localized outcome ${expected[index]}`);
   assert.ok(html.includes('/fixture/&lt;file&gt;.txt'),'escaped file path is visible');
   assert.doesNotMatch(html,/SECRET_FILE_CONTENT|<file>/);
   if(outcome==='error') { assert.ok(!html.includes(expected[index-2]),'failed transfer must never use success wording'); assert.match(html,/file_io_failed/); }
 });
 }
}
