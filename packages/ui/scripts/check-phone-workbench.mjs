// SPDX-License-Identifier: Apache-2.0
// Render the shipping phone screen with inert session data and no PTY or network.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const boundaries = {
  runtime: `export const getSession=()=>fixture.session, getState=()=>({hydrated:fixture.hydrated??true}), orderedSessions=()=>fixture.sessions??[fixture.session], isDemo=()=>fixture.demo, supportsPhoneTerminal=()=>true, describe=()=>({label:'Em execução'});
    export const SESSION_COLORS=[{id:'verde',light:'#1f9d5b',dark:'#3ccf76'}], canMoveSession=()=>true, launchAgentWhenReady=async()=>{}, changeDirectory=async()=>{}, moveSessionBy=()=>{}, renameSession=()=>{}, restart=async()=>{}, setSessionColor=()=>{}, setSessionIcon=()=>{}, setSessionSubtitle=()=>{}, togglePinned=()=>{};
  export const applicationCursorKeys=()=>false, blurTerminal=()=>{}, onTerminalFocus=()=>()=>{}, setInputTransform=()=>()=>{};
  export const bracketedPaste=()=>true, closeSession=async()=>{}, fitAndResize=()=>{}, focusTerminal=()=>{}, hostTerminal=()=>{}, hydrate=async()=>{}, insertText=()=>{}, openSession=()=>{}, pasteText=()=>false, releaseTerminal=()=>{}, reopen=()=>{}, requestTerminalControl=async()=>{}, scrollToBottom=()=>{}, selectSession=()=>{}, sendKey=()=>false, submitText=async()=>true, subscribe=()=>()=>{}, terminalAttaching=()=>false, terminalHasFocus=()=>false, viewMounted=()=>{}, watchTail=()=>()=>{};`,
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
    api.onResolve({filter:/\.svg\?raw$/}, ({path}) => ({path,namespace:'glyph'}));
    api.onLoad({filter:/.*/,namespace:'glyph'}, () => ({contents:'export default "<svg></svg>";',loader:'js'}));
    api.onResolve({filter:/\.(js|jsx)$/}, ({path}) => { const key=path.split('/').at(-1).replace(/\.jsx?$/,''); if(boundaries[key]) return {path:key,namespace:'fixture'}; });
    api.onLoad({filter:/.*/,namespace:'fixture'}, ({path}) => ({contents:boundaries[path],loader:'js'}));
  },
}] });
function render({owned=false,demo=false,status='running',list=false,files=false,hydrated=true,sessions,color=null,icon=null}={}) {
  const fixture={demo,hydrated,sessions,route:list?{pane:'list',sessionId:null,path:null}:files?{pane:'files',sessionId:'fixture',path:null}:undefined,session:{id:'fixture',name:'Projeto',status,viewport:{owned},color,icon}};
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
    for(const key of ['Enter','Esc','Ctrl C, interromper','Comandos rápidos','Escrever texto para o terminal']) assert.ok(html.includes(`disabled="" aria-label="${key}"`),`tecla habilitada: ${key}`);
  }
});

test('a barra do terminal traz Teclas, os favoritos, comandos rapidos e o botao de enviar',()=>{
  const html=render({owned:true});
  const bar=html.match(/<div class="phone-keybar"[\s\S]*?<\/div>/)?.[0]||'';
  assert.ok(bar,'a barra aparece com o terminal aberto');
  const labels=[...bar.matchAll(/aria-label="([^"]+)"/g)].map(match=>match[1]);
  assert.deepEqual(labels,['Teclas do terminal','Teclado do aparelho','Enter','Esc','Ctrl C, interromper','Colar no computador, Ctrl V','Abrir o teclado especial','Comandos rápidos','Escrever texto para o terminal']);
  // Enter vai só com o ícone; os atalhos empilham o Ctrl sobre a letra.
  const enterButton=bar.match(/<button[^>]*aria-label="Enter"[^>]*>([\s\S]*?)<\/button>/)?.[1]??'';
  assert.match(enterButton,/<svg/);
  for(const [label,letter] of [['Ctrl C, interromper','C'],['Colar no computador, Ctrl V','V']]) {
    const button=bar.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)<\\/button>`))?.[1]??'';
    assert.match(button,new RegExp(`phone-keybar__combo" aria-hidden="true"><small>Ctrl</small>${letter}<`),label);
  }
  assert.match(bar,/phone-keybar__keys[^>]*aria-expanded="false"/);
  // O teclado do aparelho abre pela barra, sem tocar no terminal.
  assert.match(bar,/phone-keybar__native/);
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
  assert.doesNotMatch(ready,/<h1[^>]*>Terminais<\/h1>(<\/div>)?<span/,'a contagem sai do cabecalho');
});
test('sem sessoes a lista convida a abrir uma pasta',()=>{
  const html=render({list:true,sessions:[]});
  assert.match(html,/Nenhuma sessão aberta|phone-terminal__empty/);
});

test('a pagina avisa a casca qual painel esta na tela, com a previa contando como arquivos',async()=>{
  const source=await readFile('src/terminals/ui/PhoneWorkbench.jsx','utf8');
  assert.match(source,/import \{[^}]*\bpostView\b[^}]*\} from '\.\.\/\.\.\/lib\/shell\.js'/);
  assert.match(source,/postView\(pane === 'list' \? 'list' : pane === 'terminal' \? 'terminal' : 'files'\)/);
  assert.match(source,/postView\(pane === 'list'/);
});

test('com a sessao aberta, cabecalho e painel ficam no tom dela, e a lista no rosa',()=>{
  const plain=render({owned:true});
  const body=plain.match(/<div class="phone-terminal__body[^"]*"[^>]*>/)?.[0]||'';
  assert.match(body,/class="phone-terminal__body session-scope"/);
  // Sem cor, o tom resolvido e o rosa do Cialai, nunca vazio.
  assert.match(body,/--session-accent-light:#E23B84/);
  assert.match(body,/--session-on-accent-light:#FFFFFF/);
  const blue=render({owned:true,color:'azul'}).match(/<div class="phone-terminal__body[^"]*"[^>]*>/)?.[0]||'';
  assert.match(blue,/--session-accent-light:#1A4FA0/);
  // O embrulho envolve o cabecalho e a barra de teclas.
  const inside=plain.slice(plain.indexOf('phone-terminal__body'));
  assert.ok(inside.indexOf('phone-terminal__toolbar')>0 && inside.indexOf('phone-keybar')>0);
  const list=render({list:true});
  assert.match(list,/<div class="phone-terminal__body">/,'a lista nao leva tom de sessao');
  assert.doesNotMatch(list,/session-scope|--session-accent/);
});
test('o icone da sessao vem antes do titulo do terminal aberto',()=>{
  const html=render({owned:true,icon:'globe'});
  assert.match(html,/<div class="phone-terminal__title"><span class="session-icon session-icon--custom phone-terminal__icon"[^>]*>[\s\S]*?<\/span><h1[^>]*>Projeto<\/h1><\/div>/);
  const fallback=render({owned:true});
  assert.match(fallback,/phone-terminal__title"><span class="session-icon session-icon--default phone-terminal__icon"/);
  const list=render({list:true});
  assert.doesNotMatch(list,/session-icon/,'a lista nao tem icone de sessao no titulo');
  // Nos arquivos o nome da sessao vai no subtitulo, com o icone na frente, e o tom continua.
  const files=render({files:true,icon:'globe',color:'azul'});
  assert.match(files,/phone-terminal__body session-scope" style="--session-accent-light:#1A4FA0;/);
  assert.match(files,/<span><span class="session-icon session-icon--custom phone-terminal__icon"[^>]*>[\s\S]*?<\/span>Projeto<\/span>/);
});
test('botoes do cabecalho e a barra de teclas usam o tom da sessao',async()=>{
  const css=await readFile('src/views/Terminais.css','utf8');
  assert.match(css,/\[data-form-factor="phone"\] \.phone-terminal__body \{ display: contents; \}/);
  assert.match(css,/\[data-form-factor="phone"\] \.session-scope \.phone-terminal__toolbar \.mac-tool \{ background: var\(--session-accent-light\); color: var\(--session-on-accent-light\); \}/);
  assert.match(css,/\.session-scope \.phone-terminal__toolbar \.mac-tool:not\(:disabled\):active \{ background: color-mix\(in srgb, var\(--session-accent-light\)/);
  const rule=(selector)=>css.split('\n').find(line=>line.startsWith(`[data-form-factor="phone"] ${selector} {`))||'';
  assert.match(rule('.phone-keybar__native'),/background: var\(--session-accent-soft,[^)]*\)\) !important; color: var\(--session-accent-text,/);
  assert.match(rule('.phone-keybar__keys.is-armed'),/background: var\(--session-accent,[^)]*\)\) !important; color: var\(--session-on-accent,/);
  assert.match(rule('.phone-keybar__send'),/background: var\(--session-accent,[^)]*\)\) !important; color: var\(--session-on-accent,/);
  // O icone do cabecalho e solto, no texto do tom.
  assert.match(css,/\[data-form-factor="phone"\] \.phone-terminal__heading \.session-icon \{ display: inline-flex; margin: 0; color: var\(--session-accent-text\); \}/);
  // As barras do indicador no subtitulo voltam a aparecer.
  assert.match(css,/span\.terminais-activity\.phone-terminal__activity \{ width: 11px; height: 10px; gap: 2px;/);
});
