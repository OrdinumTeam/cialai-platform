// SPDX-License-Identifier: Apache-2.0
// Runs the real Cialai runtime with in-memory PTY and renderer boundaries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const mocks = {
  native: `export const isTauri = () => fixture.desktop; export const hasBridge = () => true;
    export const NATIVE_ONLY_MESSAGE = 'macOS'; export const invoke = (cmd,args) => fixture.invoke(cmd,args);
    export const listen = async (event,handler) => {fixture.listeners.set(event,handler); return () => fixture.listeners.delete(event);}; export const createChannel = async (onmessage) => ({onmessage});
    export const chooseDirectory = async () => null;`,
  renderer: `const off = () => ({dispose(){}}); export class Terminal {
    constructor(options) { this.options=options; this.cols=options.cols; this.rows=options.rows;
      this.parser={registerOscHandler:off}; this.buffer={active:{}}; }
    onData=off; onBinary=off; onBell=off; onResize(handler){this.resizeHandler=handler;return {dispose(){}};}
    open(parent) { this.element={isConnected:true,parentElement:parent,addEventListener(){}}; }
    loadAddon(addon){addon.term=this;} attachCustomKeyEventHandler(){} write(data, done){fixture.output.push(...data);done?.();} resize(cols,rows){this.cols=cols;this.rows=rows;this.resizeHandler?.({cols,rows});}
    reset(){fixture.output=[];} focus(){} dispose(){}
  } export class FitAddon {fit(){this.term.resize(45,28);} proposeDimensions(){return {cols:45,rows:28};}} export class SearchAddon {} export class WebglAddon {onContextLoss(){} dispose(){}} export class WebLinksAddon {}`,
  downloads: 'export const openExternal = async () => {};',
  theme: 'export const buildTheme = () => ({}); export const terminalFont = () => "mono"; export const watchTheme = () => () => {};',
  files: 'export const baseName = p => p.split("/").at(-1); export const fs = {}; export const isInside=()=>false; export const shellQuote=p=>p;',
  layout: 'export const getLayout = () => ({fontSize:13}); export const subscribeLayout = () => () => {};',
  remote: 'export const state = () => fixture.remoteState; export const subscribeState = handler => {fixture.remoteListener=handler; return () => {};};',
  shell: 'export const isPhone = () => !fixture.desktop; export const onShellLock = () => () => {};',
};
const bundle = (entry) => build({
  entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'runtime',
  plugins: [{ name: 'runtime-boundaries', setup(api) {
    api.onResolve({ filter: /./ }, ({ path }) => {
      if (path.startsWith('@xterm/')) return { path: 'renderer', namespace: 'fixture' };
      const key = path.split('/').at(-1)?.replace(/\.js$/, '');
      if (mocks[key]) return { path: key, namespace: 'fixture' };
    });
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path], loader: 'js' }));
  } }],
});

const output = await bundle('src/terminals/runtime.js');

function scenario({ saved = [], alive = [], desktop = true, storageEntries } = {}) {
  let clock = 0; let timerId = 0;
  const timers = new Map();
  const storageKey = desktop ? 'cialai_terminals' : 'cialai_terminals_phone';
  const initialStore = JSON.stringify({version:2, sessions:saved, selectedId:saved[0]?.id, recent:[]});
  const storage = new Map(storageEntries || [[storageKey, initialStore]]);
  const fixture = { desktop, remoteState: {status:'connected',features:['terminal-mobile-v1']}, alive: [...alive], calls: [], listeners: new Map(), output: [], async invoke(cmd, args) {
    this.calls.push({cmd,args});
    if (cmd === 'pty_list') return this.alive.map(item => ({...item}));
    if (cmd === 'pty_attach') { const info=this.alive.find(item=>item.id===args.id); if (!info) throw new Error('exited'); return {...info}; }
    if (cmd === 'pty_kill') { this.alive=this.alive.filter(item=>item.id!==args.id); return; }
    if (cmd === 'pty_presentation') return;
    if (cmd === 'pty_spawn') { const id = Math.max(0,...this.alive.map(item=>item.id))+1; const info={id,pid:1000+id,tag:args.tag,cwd:args.cwd,cols:120,rows:32,view:{id,cols:120,rows:32,owner:'local',leaseId:1,revision:1}}; this.alive.push(info); return {...info}; }
    if (cmd === 'pty_view_claim' || cmd === 'pty_view_renew') { const info=this.alive.find(item=>item.id===args.id); if (!info) throw new Error('exited'); info.view={id:args.id,cols:args.cols,rows:args.rows,owner:'remote',leaseId:cmd==='pty_view_claim' ? (info.view?.leaseId||0)+1 : args.leaseId,revision:(info.view?.revision||0)+1}; return {...info.view}; }
    if (cmd === 'pty_view_release') return;
    if (cmd === 'pty_metrics' || cmd === 'ai_usage') return [];
    if (cmd === 'pty_saved') return this.saved?.[args.tag] ?? null;
    if (cmd === 'pty_saved_history') return new Uint8Array(this.history?.[args.tag] || []).buffer;
    if (cmd === 'pty_write' || cmd === 'pty_prune' || cmd === 'pty_forget') return;
    throw new Error('Unexpected boundary call: '+cmd);
  } };
  const timer = (fn, ms, repeat=0) => { const id=++timerId; timers.set(id,{fn,at:clock+ms,repeat}); return id; };
  const context = vm.createContext({ fixture, console, URLSearchParams, Uint8Array, ArrayBuffer,
    setTimeout:(fn,ms=0)=>timer(fn,ms), clearTimeout:id=>timers.delete(id),
    setInterval:(fn,ms)=>timer(fn,ms,ms), clearInterval:id=>timers.delete(id),
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    window:{location:{search:''},addEventListener(){},devicePixelRatio:1,matchMedia:()=>({addEventListener(){},removeEventListener(){}})},
    document:{hasFocus:()=>true,visibilityState:'visible',addEventListener(){},body:{appendChild(){}},createElement:()=>({isConnected:true,setAttribute(){},appendChild(child){child.parentElement=this;}})},
  });
  vm.runInContext(output.outputFiles[0].text, context);
  async function advance(ms) {
    const until=clock+ms;
    for (;;) {
      const due=[...timers.entries()].filter(([,entry])=>entry.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];
      if (!due) break;
      const [id,entry]=due; clock=entry.at; timers.delete(id);
      if (entry.repeat) timers.set(id,{...entry,at:clock+entry.repeat});
      await entry.fn();
      for (let i=0;i<12;i++) await Promise.resolve();
    }
    clock=until;
  }
  return { runtime: context.runtime, fixture, advance, storage };
}
const mac = {id:1,pid:1001,tag:'mac-session',cwd:'/fixture/mac',cols:120,rows:32};
const phone = {id:2,pid:1002,tag:'phone-session',cwd:'/fixture/phone',cols:80,rows:24};
const settle = async () => { for (let i=0;i<30;i++) await Promise.resolve(); };
const host = () => ({getBoundingClientRect:()=>({width:350,height:480,bottom:480}),appendChild(child){child.parentElement=this;}});

test('phone exit and error reflow retained history locally without remote resize or control calls',async()=>{
  const s=scenario({desktop:false,alive:[{...mac,view:{id:1,owner:'local',leaseId:1,revision:1,cols:120,rows:32}}]});
  await s.runtime.hydrate();
  const session=s.runtime.getSession('mac-session');
  s.runtime.hostTerminal(session.id,host()); await settle();
  s.fixture.listeners.get('pty://view')({id:1,owner:'local',leaseId:9,revision:99,cols:120,rows:32});
  session.term.write('final output');
  const after=s.fixture.calls.length;
  s.fixture.listeners.get('pty://exit')({id:1,code:0}); await s.advance(500);
  assert.equal(session.status,'exited'); assert.equal(session.term.cols,45);
  assert.equal(s.fixture.output.join(''),'final output');
  s.runtime.releaseTerminal(session.id);
  session.term.resize(120,32);
  s.runtime.hostTerminal(session.id,host()); await settle();
  assert.equal(session.term.cols,45,'Returning to history must fit without waiting for a size change');
  const original=s.fixture.invoke.bind(s.fixture);
  s.fixture.invoke=(cmd,args)=>{if(cmd==='pty_spawn') return Promise.reject(new Error('failed fixture'));return original(cmd,args);};
  session.term.resize(120,32);
  s.runtime.reopen(session.id); await settle();
  assert.equal(session.status,'error'); assert.equal(session.term.cols,45);
  assert.equal(s.fixture.calls.slice(after).some(call=>['pty_resize','pty_view_claim','pty_view_renew','pty_write'].includes(call.cmd)),false);
});

test('reused PTY ID adopts the replacement process view even after high old revisions', async () => {
  const s = scenario({desktop:false,alive:[{...mac,view:{id:1,owner:'local',leaseId:8,revision:50,cols:120,rows:32}}]});
  await s.runtime.hydrate();
  const session = s.runtime.getSession('mac-session');
  const oldView = session.viewport;
  s.fixture.alive = [{...mac,pid:2001,cols:45,rows:28,view:{id:1,owner:'remote',leaseId:2,revision:2,cols:45,rows:28}}];
  await s.advance(3200);
  assert.notEqual(session.viewport, oldView);
  assert.equal(session.viewport.latest.revision,2);
  assert.equal(session.term.cols,45);
  assert.equal(session.pid,2001);
  assert.equal(s.fixture.calls.some(call=>call.cmd==='pty_view_release'),false);
});

test('connection loss retires pending claims and input before a same-ID replacement reconnects', async () => {
  const s = scenario({desktop:false,alive:[{...mac,view:{id:1,owner:'local',leaseId:8,revision:50,cols:120,rows:32}}]});
  await s.runtime.hydrate();
  const session=s.runtime.getSession('mac-session'); const original=s.fixture.invoke.bind(s.fixture);
  let grant;
  s.fixture.invoke=(cmd,args)=>cmd==='pty_view_claim' ? new Promise(resolve=>{grant=resolve;}) : original(cmd,args);
  session.host=host();
  const claim=s.runtime.requestTerminalControl(session.id);
  s.runtime.insertText(session.id,'input for the old process');
  s.fixture.remoteState={status:'disconnected',features:[]}; s.fixture.remoteListener(s.fixture.remoteState);
  s.fixture.alive=[{...mac,pid:2001,view:{id:1,owner:'local',leaseId:1,revision:1,cols:120,rows:32}}];
  s.fixture.invoke=original;
  s.fixture.remoteState={status:'connected',features:['terminal-mobile-v1']}; s.fixture.remoteListener(s.fixture.remoteState);
  await settle();
  grant({id:1,owner:'remote',leaseId:9,revision:51,cols:45,rows:28}); await claim;
  await settle();
  assert.equal(session.pid,2001);
  assert.equal(session.viewport.latest.revision,2);
  assert.equal(session.viewport.owned,true);
  assert.equal(s.fixture.calls.some(call=>call.cmd==='pty_view_release'),false);
  assert.equal(s.fixture.calls.some(call=>call.cmd==='pty_write'),false,'Pending input belongs only to its original process');
});

test('visible phone spawn and reopen apply the server view and claim measured dimensions', async () => {
  const s=scenario({desktop:false}); await s.runtime.hydrate();
  const id=s.runtime.openSession('/fixture/phone');
  s.runtime.hostTerminal(id,host());
  await settle();
  let session=s.runtime.getSession(id);
  assert.equal(session.status,'running');
  assert.equal(session.viewport?.owned,true);
  assert.equal(session.term.cols,45);
  assert.equal(s.fixture.calls.filter(call=>call.cmd==='pty_view_claim').length,1);
  s.fixture.listeners.get('pty://exit')({id:session.ptyId,code:0});
  await s.advance(500);
  s.runtime.reopen(id); await settle();
  assert.equal(session.status,'running');
  assert.equal(session.viewport?.owned,true);
  assert.equal(s.fixture.calls.filter(call=>call.cmd==='pty_view_claim').length,2);
});

test('phone spawn completed after leaving does not claim an invisible terminal', async () => {
  const s=scenario({desktop:false}); await s.runtime.hydrate();
  const id=s.runtime.openSession('/fixture/phone');
  s.runtime.hostTerminal(id,host()); s.runtime.releaseTerminal(id);
  await settle();
  assert.equal(s.runtime.getSession(id).viewport?.latest?.revision,1);
  assert.equal(s.fixture.calls.some(call=>call.cmd==='pty_view_claim'),false);
});

test('identical metadata republishes for a replacement PTY despite late old publication success', async () => {
  const s=scenario({alive:[mac],saved:[{id:'mac-session',cwd:'/fixture/mac',name:'Meu terminal',subtitle:'Equipe'}]});
  const original=s.fixture.invoke.bind(s.fixture); let finishOld; let publications=0;
  s.fixture.invoke=async(cmd,args)=>{ if(cmd==='pty_presentation'){publications++; if(publications===1) return new Promise(resolve=>{finishOld=resolve;}); if(publications===2) throw new Error('retry fixture');} return original(cmd,args); };
  await s.runtime.hydrate(); await s.advance(150);
  s.fixture.alive=[{...mac,pid:2001}];
  await s.advance(3200);
  assert.equal(publications,2);
  finishOld(); await settle();
  s.runtime.persist(); await s.advance(150);
  assert.equal(publications,3,'Old completion cannot suppress retry for the new process');
  await s.runtime.restart('mac-session'); await settle(); await s.advance(150);
  assert.equal(publications,4,'Same card metadata must be published again after replacing PTY ID');
});

test('desktop reload adopts a live iPhone PTY absent from local storage without killing it', async () => {
  const s=scenario({alive:[phone]}); await s.runtime.hydrate(); await s.advance(150);
  assert.equal(s.fixture.alive.length,1, 'Reload must preserve the live remote shell');
  const sessions=s.runtime.getState().sessions;
  assert.equal(sessions.length,1); assert.equal(sessions[0].ptyId,2); assert.equal(sessions[0].status,'running');
  assert.equal(s.fixture.calls.some(call=>call.cmd==='pty_kill'),false);
  assert.equal(JSON.parse(s.storage.get('cialai_terminals')).sessions[0].id,'phone-session');
});

test('desktop discovers new iPhone sessions after initial hydration and preserves local metadata', async () => {
  const s=scenario({alive:[mac],saved:[{id:'mac-session',cwd:'/fixture/mac',name:'My work',customName:true,pinned:true}]});
  await s.runtime.hydrate(); await s.advance(150);
  s.fixture.alive.push(phone); await s.advance(4000);
  const sessions=s.runtime.getState().sessions;
  assert.equal(sessions.length,2); assert.equal(sessions[0].name,'My work'); assert.equal(sessions[0].pinned,true);
  assert.equal(sessions[1].ptyId,2); assert.equal(sessions[1].status,'running');
  await s.advance(4000); assert.equal(s.runtime.getState().sessions.length,2,'Polling must not duplicate sessions');
  assert.equal(s.fixture.calls.filter(call=>call.cmd==='pty_attach'&&call.args.id===2).length,1);
  assert.equal(s.fixture.calls.some(call=>call.cmd==='pty_kill'),false);
});

test('an initially empty desktop discovers the first PTY opened on the phone', async () => {
  const s=scenario(); await s.runtime.hydrate();
  s.fixture.alive.push(phone); await s.advance(4000);
  assert.equal(s.runtime.getState().sessions[0]?.ptyId,2);
  assert.equal(s.runtime.getState().selectedId,'phone-session');
});

test('phone adopts the Mac card presentation and order, without publishing over it', async () => {
  const s = scenario({desktop:false,alive:[
    {...mac,presentation:{name:'Geral',subtitle:'Equipe',color:'ordinum',pinned:true,order:1}},
    {...phone,presentation:{name:'Servidor',subtitle:'Plantão',color:'verde',pinned:false,order:0}},
  ]});
  await s.runtime.hydrate(); await s.advance(150);
  const sessions = s.runtime.orderedSessions();
  assert.equal(sessions[0].name, 'Geral'); assert.equal(sessions[0].subtitle, 'Equipe');
  assert.equal(sessions[0].pinned, true); assert.equal(sessions[1].name, 'Servidor');
  assert.equal(s.fixture.calls.some(call => call.cmd === 'pty_presentation'), false);
});

test('desktop publishes only card presentation with local metadata authoritative', async () => {
  const s = scenario({alive:[{...mac,presentation:{name:'Remote name'}}],saved:[{id:'mac-session',cwd:'/fixture/mac',name:'Meu terminal',subtitle:'Revisão',customName:true,pinned:true}]});
  await s.runtime.hydrate(); await s.advance(150);
  const call = s.fixture.calls.find(call => call.cmd === 'pty_presentation');
  assert.equal(call?.args.presentation.name, 'Meu terminal');
  assert.equal(call.args.presentation.subtitle, 'Revisão');
  assert.deepEqual(Object.keys(call.args.presentation).sort(), ['color','name','order','pinned','subtitle']);
});

test('a stale discovery response cannot mark a newly spawned local PTY as exited', async () => {
  const s=scenario(); await s.runtime.hydrate();
  const original=s.fixture.invoke.bind(s.fixture);
  let finishList;
  s.fixture.invoke=async(cmd,args)=>{
    if (cmd==='pty_list') return new Promise(resolve=>{finishList=resolve;});
    if (cmd==='pty_spawn') return {...mac,tag:args.tag};
    return original(cmd,args);
  };
  await s.advance(3000);
  const id=s.runtime.openSession('/fixture/mac');
  for(let i=0;i<12;i++) await Promise.resolve();
  assert.equal(s.runtime.getSession(id).status,'running');
  finishList([]);
  for(let i=0;i<12;i++) await Promise.resolve();
  assert.equal(s.runtime.getSession(id).status,'running');
});

test('desktop restores saved history and resumes the agent once the new shell is quiet', async () => {
  const conversation = 'ef374958-11c4-4e44-8fce-798df3af068e';
  const s = scenario({ saved: [{ id: 'lost-session', cwd: '/fixture/lost', name: 'Perdida' }] });
  s.fixture.saved = { 'lost-session': { tag: 'lost-session', cwd: '/fixture/lost', cols: 100, rows: 30, updatedAtMs: 0, historyBytes: 5,
    resume: { agent: 'Claude Code', sessionId: conversation, command: `claude --resume ${conversation}` } } };
  s.fixture.history = { 'lost-session': [...Buffer.from('antes')] };
  const text = () => s.fixture.output.map(value => typeof value === 'number' ? String.fromCharCode(value) : value).join('');
  await s.runtime.hydrate(); await settle();
  const session = s.runtime.getSession('lost-session');
  assert.equal(session.status, 'disconnected');
  assert.match(text(), /antes/);
  assert.match(text(), /Histórico restaurado/);
  assert.equal(session.saved.resume.agent, 'Claude Code');
  assert.equal(JSON.stringify(s.fixture.calls.find(call => call.cmd === 'pty_prune')?.args), JSON.stringify({ keep: ['lost-session'] }));
  const reopening = s.runtime.reopen('lost-session'); await settle();
  assert.equal(session.status, 'running');
  assert.equal(s.fixture.calls.some(call => call.cmd === 'pty_write'), false, 'Nothing is typed before the shell prints its prompt');
  s.fixture.calls.find(call => call.cmd === 'pty_spawn').args.onOutput.onmessage(new Uint8Array([36, 32]));
  await s.advance(1500); await reopening;
  assert.equal(JSON.stringify(s.fixture.calls.filter(call => call.cmd === 'pty_write').map(call => call.args)), JSON.stringify([{ id: session.ptyId, data: `claude --resume ${conversation}\r` }]));
});

test('the shell learns where the xterm cursor stands, below the history kept by a restart', async () => {
  const s = scenario();
  await s.runtime.hydrate();
  const id = s.runtime.openSession('/fixture/mac');
  await settle();
  const spawns = () => s.fixture.calls.filter(call => call.cmd === 'pty_spawn');
  assert.deepEqual([spawns().at(-1).args.cursorRow, spawns().at(-1).args.cursorCol], [1, 1]);
  s.runtime.getSession(id).term.buffer.active = { cursorY: 6, cursorX: 3 };
  await s.runtime.restart(id); await settle();
  assert.equal(spawns().length, 2);
  assert.deepEqual([spawns().at(-1).args.cursorRow, spawns().at(-1).args.cursorCol], [7, 4]);
});

test('closing a desktop session forgets its saved history', async () => {
  const s = scenario({ alive: [mac], saved: [{ id: 'mac-session', cwd: '/fixture/mac' }] });
  await s.runtime.hydrate(); await settle();
  assert.equal(await s.runtime.closeSession('mac-session'), true);
  assert.equal(JSON.stringify(s.fixture.calls.filter(call => call.cmd === 'pty_forget').map(call => call.args)), JSON.stringify([{ tag: 'mac-session' }]));
});

test('desktop migrates the legacy terminal store once when the Cialai key is empty', async () => {
  const legacy = JSON.stringify({ version: 2, sessions: [{ id: 'legacy', cwd: '/fixture/legacy' }], selectedId: 'legacy', recent: [] });
  const s = scenario({ alive: [{ ...mac, tag: 'legacy', cwd: '/fixture/legacy' }], storageEntries: [['oc_terminals', legacy]] });
  await s.runtime.hydrate(); await s.advance(150);
  assert.equal(s.runtime.getState().selectedId, 'legacy');
  assert.equal(JSON.parse(s.storage.get('cialai_terminals')).sessions[0].id, 'legacy');
});

test('phone migrates its isolated legacy store to the Cialai phone key', async () => {
  const legacy = JSON.stringify({ version: 2, sessions: [], selectedId: null, recent: ['/fixture/recent'] });
  const s = scenario({ desktop: false, storageEntries: [['oc_terminals_phone', legacy]] });
  await s.runtime.hydrate();
  assert.equal(JSON.stringify(s.runtime.getRecent()), JSON.stringify(['/fixture/recent']));
  assert.equal(s.storage.get('cialai_terminals_phone'), legacy);
});

test('an existing Cialai store wins over stale Control data', async () => {
  const current = JSON.stringify({ version: 2, sessions: [], selectedId: null, recent: ['/fixture/current'] });
  const legacy = JSON.stringify({ version: 2, sessions: [], selectedId: null, recent: ['/fixture/legacy'] });
  const s = scenario({ storageEntries: [['cialai_terminals', current], ['oc_terminals', legacy]] });
  await s.runtime.hydrate();
  assert.equal(JSON.stringify(s.runtime.getRecent()), JSON.stringify(['/fixture/current']));
  assert.equal(s.storage.get('cialai_terminals'), current);
});
