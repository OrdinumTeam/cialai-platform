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
    export const SESSION_COLORS=[{id:'verde',light:'#1f9d5b',dark:'#3ccf76'}], canMoveSession=()=>true, changeDirectory=async()=>{}, moveSessionBy=()=>{}, renameSession=()=>{}, restart=async()=>{}, setSessionColor=()=>{}, setSessionSubtitle=()=>{}, togglePinned=()=>{};
  export const bracketedPaste=()=>true, closeSession=async()=>{}, fitAndResize=()=>{}, focusTerminal=()=>{}, hostTerminal=()=>{}, hydrate=async()=>{}, insertText=()=>{}, openSession=()=>{}, pasteText=()=>false, releaseTerminal=()=>{}, reopen=()=>{}, requestTerminalControl=async()=>{}, scrollToBottom=()=>{}, selectSession=()=>{}, sendKey=()=>false, submitText=async()=>true, subscribe=()=>()=>{}, terminalHasFocus=()=>false, viewMounted=()=>{}, watchTail=()=>()=>{};`,
  native: `export const hasBridge=()=>true, NATIVE_ONLY_MESSAGE='', invoke=async()=>[];`,
  AgentProfiles: `export default ()=>null;`,
  'phone-navigation': `export const initialPhoneRoute=()=>({pane:'terminal',sessionId:'fixture',path:null}), phoneRoute=state=>state, phoneRouteStorage=()=>null, readPhoneRoute=()=>({pane:'terminal',sessionId:'fixture',path:null}), writePhoneRoute=()=>{};`,
  hooks: `export const useRuntimeEvents=()=>{};`,
  ui: `export const useToast=()=>()=>{}; export const AppModal=()=>null;`,
  NewSessionPopover: `export default ()=>null;`,
  // O menu de acoes e o dialogo de nome sobem o MUI, que exige um tema; os
  // dois tem gate proprio.
  PhoneSessionMenu: `export default ()=>null;`,
  dialogs: `export const NameDialog=()=>null; export const Sheet=()=>null;`,
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

test('a tela do terminal traz o balao que abre a caixa de texto, acima da pilula de voltar ao fim',()=>{
  const html=render({owned:true});
  assert.match(html,/phone-terminal__compose/);
  assert.match(html,/aria-label="Escrever texto para o terminal"/);
  // A caixa so aparece depois do toque; o balao nasce sozinho.
  assert.doesNotMatch(html,/phone-composer__area/);
});
test('sem terminal interativo o balao continua na tela, desabilitado',()=>{
  for(const options of [{},{status:'exited'},{status:'error'}]) {
    const html=render(options);
    const button=html.match(/<button[^>]*phone-terminal__compose[^>]*>/)?.[0];
    assert.ok(button,'o balao nao pode sumir');
    assert.ok(button.includes('disabled=""'),'sem sessao viva o balao nao escreve nada');
  }
});
test('a fileira de nove teclas continua intacta ao lado do balao',()=>{
  const html=render({owned:true});
  for(const key of ['Esc','Tab','Shift Tab','Ctrl C','Seta para cima','Seta para baixo','Enter','Ctrl D','Ctrl L']) assert.ok(html.includes(`aria-label="${key}"`),`tecla ausente: ${key}`);
});

test('o cabecalho do terminal aberto abre o mesmo menu de acoes, no lugar do icone solto de energia',()=>{
  const html=render({owned:true});
  assert.match(html,/aria-label="Ações de Projeto"/);
  assert.doesNotMatch(html,/aria-label="Encerrar sessão"/,'o botao de energia sai do cabecalho e vira item do menu');
  assert.match(html,/aria-label="Arquivos da sessão"/,'o botao de arquivos continua');
});
