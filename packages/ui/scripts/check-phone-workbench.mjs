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
  runtime: `export const getSession=()=>fixture.session, getState=()=>({hydrated:fixture.hydrated??true}), orderedSessions=()=>fixture.sessions??[fixture.session], isDemo=()=>fixture.demo, supportsPhoneTerminal=()=>true, describe=()=>({label:'Em execução'});
    export const SESSION_COLORS=[{id:'verde',light:'#1f9d5b',dark:'#3ccf76'}], canMoveSession=()=>true, launchAgentWhenReady=async()=>{}, changeDirectory=async()=>{}, moveSessionBy=()=>{}, renameSession=()=>{}, restart=async()=>{}, setSessionColor=()=>{}, setSessionSubtitle=()=>{}, togglePinned=()=>{};
  export const applicationCursorKeys=()=>false, blurTerminal=()=>{}, onTerminalFocus=()=>()=>{}, setInputTransform=()=>()=>{};
  export const bracketedPaste=()=>true, closeSession=async()=>{}, fitAndResize=()=>{}, focusTerminal=()=>{}, hostTerminal=()=>{}, hydrate=async()=>{}, insertText=()=>{}, openSession=()=>{}, pasteText=()=>false, releaseTerminal=()=>{}, reopen=()=>{}, requestTerminalControl=async()=>{}, scrollToBottom=()=>{}, selectSession=()=>{}, sendKey=()=>false, submitText=async()=>true, subscribe=()=>()=>{}, terminalHasFocus=()=>false, viewMounted=()=>{}, watchTail=()=>()=>{};`,
  native: `export const hasBridge=()=>true, NATIVE_ONLY_MESSAGE='', invoke=async()=>[];`,
  AgentProfiles: `export default ()=>null;`,
  'phone-navigation': `export const initialPhoneRoute=()=>({pane:'terminal',sessionId:'fixture',path:null}), phoneRoute=state=>state, phoneRouteStorage=()=>null, readPhoneRoute=()=>fixture.route??({pane:'terminal',sessionId:'fixture',path:null}), writePhoneRoute=()=>{};`,
  hooks: `export const useRuntimeEvents=()=>{};`,
  ui: `export const useToast=()=>()=>{}; export const AppModal=()=>null; export const SearchInput=()=>null; export const SegmentedControl=()=>null;`,
  NewSessionFlow: `export default ()=>null;`,
  DirectoryBrowser: `export default ()=>null;`,
  files: `export const baseName=path=>String(path).split('/').at(-1);`,
  // O menu de acoes e o dialogo de nome sobem o MUI, que exige um tema; os
  // dois tem gate proprio.
  PhoneSessionMenu: `export default ()=>null;`,
  dialogs: `export const NameDialog=()=>null; export const Sheet=()=>null;`,
  PhoneSessionCard: `export default ()=>null; export const PhoneSessionSkeleton=()=>null;`,
  PhoneFiles: `export default ()=>null;`,
};
const bundle = await build({ entryPoints:['src/terminals/ui/PhoneWorkbench.jsx'], bundle:true, write:false, format:'cjs', external:['react','lucide-react'], plugins:[{
  name:'phone-workbench-boundaries', setup(api) {
    api.onResolve({filter:/\.(js|jsx)$/}, ({path}) => { const key=path.split('/').at(-1).replace(/\.jsx?$/,''); if(boundaries[key]) return {path:key,namespace:'fixture'}; });
    api.onLoad({filter:/.*/,namespace:'fixture'}, ({path}) => ({contents:boundaries[path],loader:'js'}));
  },
}] });
function render({owned=false,demo=false,status='running',list=false,hydrated=true,sessions}={}) {
  const fixture={demo,hydrated,sessions,route:list?{pane:'list',sessionId:null,path:null}:undefined,session:{id:'fixture',name:'Projeto',status,viewport:{owned}}};
  const context=vm.createContext({fixture,module:{exports:{}},exports:{},require:createRequire(import.meta.url)});
  vm.runInContext(bundle.outputFiles[0].text,context);
  return renderToStaticMarkup(React.createElement(context.module.exports.default));
}
test('phone without ownership hides the mounted renderer and explains how to take control',()=>{
  const html=render();
  assert.match(html,/phone-terminal__host[^>]*aria-hidden="true"/);
  assert.match(html,/terminal está em outro dispositivo/);
  assert.match(html,/Ajustar à tela e assumir controle/);
  assert.match(html,/disabled=""[^>]*aria-label="Esc"/);
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
    for(const key of ['Esc','Tab','Comandos rápidos','Escrever texto para o terminal']) assert.ok(html.includes(`disabled="" aria-label="${key}"`),`tecla habilitada: ${key}`);
  }
});

test('a barra do terminal traz Teclas, os favoritos, comandos rapidos e o botao de enviar',()=>{
  const html=render({owned:true});
  const bar=html.match(/<div class="phone-keybar"[\s\S]*?<\/div>/)?.[0]||'';
  assert.ok(bar,'a barra aparece com o terminal aberto');
  const labels=[...bar.matchAll(/aria-label="([^"]+)"/g)].map(match=>match[1]);
  assert.deepEqual(labels,['Teclas do terminal','Abrir o teclado especial','Esc','Tab','Colar no computador, Ctrl V','Comandos rápidos','Escrever texto para o terminal']);
  // Colar fica à direita do Tab e antes do ⋯, só com o ícone.
  const pasteButton=bar.match(/<button[^>]*aria-label="Colar no computador, Ctrl V"[^>]*>([\s\S]*?)<\/button>/)?.[1]??'';
  assert.match(pasteButton,/<svg/);
  assert.equal(pasteButton.replace(/<[^>]*>/g,'').trim(),'','Colar sem texto na barra');
  assert.match(bar,/phone-keybar__keys[^>]*aria-expanded="false"/);
  // O botão do teclado especial é só o ícone: o nome fica para o leitor de tela.
  const keysButton=bar.match(/<button[^>]*class="phone-keybar__keys"[^>]*>([\s\S]*?)<\/button>/)?.[1]??'';
  assert.match(keysButton,/<svg/);
  assert.equal(keysButton.replace(/<[^>]*>/g,'').trim(),'','sem texto no botão');
  assert.match(bar,/phone-keybar__send/);
  // O balao flutuante saiu: a caixa de texto abre pelo botao rosa da barra.
  assert.doesNotMatch(html,/phone-terminal__compose/);
  // O teclado especial, os comandos e a caixa so aparecem depois do toque.
  assert.doesNotMatch(html,/phone-keys__tabs|phone-quick|phone-composer__area/);
  // A fileira antiga de nove teclas pequenas nao volta.
  assert.doesNotMatch(html,/phone-terminal__keys|aria-label="Ctrl D"/);
});
test('sem terminal interativo a barra continua na tela, com as teclas desabilitadas',()=>{
  for(const options of [{},{status:'exited'},{status:'error'}]) {
    const html=render(options);
    const send=html.match(/<button[^>]*phone-keybar__send[^>]*>/)?.[0];
    assert.ok(send,'o botao de enviar nao pode sumir');
    assert.ok(send.includes('disabled=""'),'sem sessao viva nada e escrito');
    assert.doesNotMatch(html.match(/<button[^>]*phone-keybar__keys[^>]*>/)?.[0]||'',/disabled/,'o teclado especial abre mesmo assim, para consultar');
  }
});

test('o cabecalho do terminal aberto abre o mesmo menu de acoes, no lugar do icone solto de energia',()=>{
  const html=render({owned:true});
  assert.match(html,/aria-label="Ações de Projeto"/);
  assert.doesNotMatch(html,/aria-label="Encerrar sessão"/,'o botao de energia sai do cabecalho e vira item do menu');
  assert.match(html,/aria-label="Arquivos da sessão"/,'o botao de arquivos continua');
});

test('a lista mostra esqueletos enquanto as sessoes chegam e o botao Nova sessao preso ao rodape',()=>{
  const loading=render({list:true,hydrated:false});
  assert.equal(loading.match(/phone-session--skeleton/g)?.length ?? 0, 0, 'o esqueleto vem do card, trocado por nulo aqui');
  assert.match(loading,/aria-busy="true"/);
  assert.match(loading,/Carregando sessões/);
  assert.match(loading,/phone-terminal__quick-button[^>]*>.*Nova sessão/);
  const ready=render({list:true});
  assert.doesNotMatch(ready,/aria-busy/);
  assert.match(ready,/aria-label="Sessões de terminal, 1 sessão"/);
  assert.match(ready,/<h1[^>]*>Terminais<\/h1>/);
  assert.doesNotMatch(ready,/<h1[^>]*>Terminais<\/h1><span/,'a contagem sai do cabecalho');
});
test('sem sessoes a lista convida a abrir uma pasta',()=>{
  const html=render({list:true,sessions:[]});
  assert.match(html,/Nenhuma sessão aberta|phone-terminal__empty/);
});
