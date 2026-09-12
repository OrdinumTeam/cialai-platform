// SPDX-License-Identifier: Apache-2.0
// Render the shipping phone screen with inert session data and no PTY or network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const boundaries = {
  runtime: `export const getSession=()=>fixture.session, getState=()=>({hydrated:true}), orderedSessions=()=>[fixture.session], isDemo=()=>fixture.demo, supportsPhoneTerminal=()=>true, describe=()=>({label:'Em execução'});
    export const closeSession=async()=>{}, fitAndResize=()=>{}, focusTerminal=()=>{}, hostTerminal=()=>{}, hydrate=async()=>{}, insertText=()=>{}, openSession=()=>{}, pasteText=()=>false, releaseTerminal=()=>{}, reopen=()=>{}, requestTerminalControl=async()=>{}, scrollToBottom=()=>{}, selectSession=()=>{}, sendKey=()=>false, subscribe=()=>()=>{}, terminalHasFocus=()=>false, viewMounted=()=>{}, watchTail=()=>()=>{};`,
  native: `export const hasBridge=()=>true, NATIVE_ONLY_MESSAGE='';`,
  'phone-navigation': `export const initialPhoneRoute=()=>({pane:'terminal',sessionId:'fixture',path:null}), phoneRoute=state=>state, phoneRouteStorage=()=>null, readPhoneRoute=()=>({pane:'terminal',sessionId:'fixture',path:null}), writePhoneRoute=()=>{};`,
  hooks: `export const useRuntimeEvents=()=>{};`,
  ui: `export const useToast=()=>()=>{}; export const AppModal=()=>null;`,
  NewSessionPopover: `export default ()=>null;`,
  SessionCard: `export default ()=>null;`,
  PhoneFiles: `export default ()=>null;`,
};
const bundle = await build({ entryPoints:['src/terminals/ui/PhoneWorkbench.jsx'], bundle:true, write:false, format:'cjs', external:['react','lucide-react'], plugins:[{
  name:'phone-workbench-boundaries', setup(api) {
    api.onResolve({filter:/\.(js|jsx)$/}, ({path}) => { const key=path.split('/').at(-1).replace(/\.jsx?$/,''); if(boundaries[key]) return {path:key,namespace:'fixture'}; });
    api.onLoad({filter:/.*/,namespace:'fixture'}, ({path}) => ({contents:boundaries[path],loader:'js'}));
  },
}] });
function render({owned=false,demo=false,status='running'}={}) {
  const fixture={demo,session:{id:'fixture',name:'Projeto',status,viewport:{owned}}};
  const context=vm.createContext({fixture,module:{exports:{}},exports:{},require:createRequire(import.meta.url)});
  vm.runInContext(bundle.outputFiles[0].text,context);
  return renderToStaticMarkup(React.createElement(context.module.exports.default));
}
test('phone without ownership hides the mounted renderer and explains how to take control',()=>{
  const html=render();
  assert.match(html,/phone-terminal__host[^>]*aria-hidden="true"/);
  assert.match(html,/terminal está em outro dispositivo/);
  assert.match(html,/Ajustar à tela e assumir controle/);
  assert.match(html,/disabled=""[^>]*aria-label="Enter"/);
});
test('owned phone terminal and demo keep the renderer visible without the ownership notice',()=>{
  for(const options of [{owned:true},{demo:true}]) {
    const html=render(options);
    assert.match(html,/phone-terminal__host[^>]*aria-hidden="false"/);
    assert.doesNotMatch(html,/terminal está em outro dispositivo/);
    assert.doesNotMatch(html,/Ajustar à tela e assumir controle/);
  }
});
test('exited and failed phone sessions show read-only history with all terminal keys disabled',()=>{
  for(const status of ['exited','error']) {
    const html=render({status});
    assert.match(html,/phone-terminal__host[^>]*aria-hidden="false"/);
    assert.doesNotMatch(html,/terminal está em outro dispositivo|Ajustar à tela e assumir controle/);
    for(const key of ['Esc','Tab','Shift Tab','Ctrl C','Seta para cima','Seta para baixo','Enter','Ctrl D','Ctrl L']) assert.ok(html.includes(`disabled="" aria-label="${key}"`));
  }
});
