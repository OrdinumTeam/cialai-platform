// SPDX-License-Identifier: Apache-2.0
// Tutorial animado do modal Perfis de agentes. Um terminal de exemplo mostra,
// em seis passos, como a conta é escolhida ao digitar codex ou claude. As
// contas são fictícias; o nome e a ferramenta seguem o formulário ao lado.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { agentById, richText, tutorialAccounts } from './agent-profiles-model.js';
import { translate, useI18n } from './i18n.js';

const CANCELLED = Symbol('cancelled');
const TICK_MS = 50;
const NAME_DEBOUNCE_MS = 450;
const SCENES = [
  { id: 'create', duration: 7400 },
  { id: 'type', duration: 5200 },
  { id: 'enter', duration: 5200 },
  { id: 'arrows', duration: 6400 },
  { id: 'skip', duration: 6000 },
  { id: 'shortcut', duration: 5000 },
];
const LOGIN_HOST = { codex: 'auth.openai.com', claude: 'claude.ai' };

const toned = (parts, tone) => parts.map((part) => ({ text: part.text, tone: part.bold ? tone : '' }));
const check = (text) => [{ text: '✓ ', tone: 'ok' }, { text }];

async function showMenu(api, context, on, foot) {
  const id = api.add({ kind: 'menu', rows: [], on: -1, picked: -1, foot: [] });
  for (let count = 1; count <= context.accounts.length; count += 1) {
    api.patch(id, { rows: context.accounts.slice(0, count) });
    await api.sleep(110);
  }
  await api.sleep(200);
  const enterUses = (index) => toned(richText(context.t, 'agentProfiles.tutorial.enterUses', { name: context.accounts[index].name }, ['name']), 'hl');
  const set = (index, parts) => api.patch(id, { on: index, foot: parts || enterUses(index) });
  set(on, foot);
  return {
    set,
    async pick(index) { api.patch(id, { picked: index }); await api.sleep(380); },
  };
}

function opened(api, context, name) {
  api.add({ kind: 'opened', parts: toned(richText(context.t, 'agentProfiles.tutorial.opened', { tool: context.tool.label, name }, ['tool', 'name']), 'hl') });
}

async function typedPrompt(api, text) {
  const id = api.add({ kind: 'prompt', cmd: '', caret: true });
  await api.sleep(480);
  for (let size = 1; size <= text.length; size += 1) {
    api.patch(id, { cmd: text.slice(0, size) });
    await api.sleep(80 + Math.random() * 40);
  }
  await api.sleep(250);
  await api.press('Enter');
  api.patch(id, { caret: false });
}

const SCRIPTS = {
  async create(api, context) {
    api.add({ kind: 'text', parts: toned(richText(context.t, 'agentProfiles.tutorial.creating', { path: context.path }, ['path']), 'hl').map((part) => (part.tone ? part : { ...part, tone: 'dim' })) });
    await api.sleep(600);
    api.add({ kind: 'text', parts: check(context.t('agentProfiles.tutorial.instructions')) });
    await api.sleep(420);
    api.add({ kind: 'text', parts: check(context.t('agentProfiles.tutorial.config', { file: context.tool.config })) });
    await api.sleep(600);
    const login = api.add({ kind: 'login', host: LOGIN_HOST[context.tool.id], who: context.t('agentProfiles.tutorial.loginAs', { name: context.name }), pressed: false });
    await api.sleep(1500);
    api.patch(login, { pressed: true });
    await api.sleep(320);
    api.patch(login, { pressed: false });
    await api.sleep(400);
    api.add({ kind: 'text', parts: [{ text: '✓ ', tone: 'ok' }, ...toned(richText(context.t, 'agentProfiles.tutorial.connected', { name: context.name }, ['name']), 'hl')] });
    await api.sleep(1800);
  },
  async type(api, context) {
    await typedPrompt(api, context.tool.command);
    await showMenu(api, context, context.accounts.length - 1);
    await api.sleep(2000);
  },
  async enter(api, context) {
    api.add({ kind: 'prompt', cmd: context.tool.command, caret: false });
    const last = context.accounts.length - 1;
    const menu = await showMenu(api, context, last);
    await api.sleep(900);
    await api.press('Enter');
    await menu.pick(last);
    opened(api, context, context.accounts[last].name);
    await api.sleep(2100);
  },
  // As setas sobem uma conta por vez, inclusive pela esgotada, e o Enter abre.
  async arrows(api, context) {
    api.add({ kind: 'prompt', cmd: context.tool.command, caret: false });
    const last = context.accounts.length - 1;
    const menu = await showMenu(api, context, last);
    await api.sleep(700);
    for (let index = last - 1; index >= 0; index -= 1) {
      const pressing = api.press('↑');
      await api.sleep(440);
      menu.set(index);
      await pressing;
    }
    await api.sleep(250);
    await api.press('Enter');
    await menu.pick(0);
    opened(api, context, context.accounts[0].name);
    await api.sleep(1800);
  },
  async skip(api, context) {
    api.add({ kind: 'prompt', cmd: context.tool.command, caret: false });
    const out = context.accounts.findIndex((account) => account.state === 'out');
    const next = context.accounts.findIndex((account, index) => index > out && account.state !== 'out');
    const menu = await showMenu(api, context, out, [{ text: context.t('agentProfiles.tutorial.out', { name: context.accounts[out].name }), tone: 'out' }]);
    await api.sleep(1100);
    menu.set(next);
    await api.sleep(1300);
    await api.press('Enter');
    await menu.pick(next);
    opened(api, context, context.accounts[next].name);
    await api.sleep(1800);
  },
  async shortcut(api, context) {
    await typedPrompt(api, `${context.tool.command} +${context.name}`);
    opened(api, context, context.name);
    await api.sleep(2400);
  },
};

function useDebounced(value, delay) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

function Parts({ parts }) {
  return parts.map((part, index) => <span key={index} className={part.tone ? `is-${part.tone}` : undefined}>{part.text}</span>);
}

function Line({ line, shell, t }) {
  if (line.kind === 'prompt') {
    return <div className="cialai-agents-term__line"><span className="is-dir">{shell.prompt}</span> <span>{line.cmd}</span>{line.caret ? <span className="cialai-agents-term__caret" /> : null}</div>;
  }
  if (line.kind === 'menu') {
    return <div className="cialai-agents-term__menu">
      <div className="cialai-agents-term__question">{t('agentProfiles.tutorial.question')}</div>
      {line.rows.map((row, index) => <div key={index} className={`cialai-agents-term__row${index === line.on ? ' is-on' : ''}${index === line.picked ? ' is-picked' : ''}${row.state === 'out' ? ' is-out' : ''}`}>
        <span className="cialai-agents-term__arrow">›</span>
        <span className="cialai-agents-term__num">{index + 1}</span>
        <span className="cialai-agents-term__name">{row.name}</span>
        <span className="cialai-agents-term__meta">{row.state === 'out' ? <b className="is-out">{t('agentProfiles.tutorial.exhausted')}</b> : <b className="is-ok">{`${row.free}%`}</b>}<span>{row.detail}</span></span>
      </div>)}
      {line.foot.length ? <div className="cialai-agents-term__foot"><Parts parts={line.foot} /></div> : null}
    </div>;
  }
  if (line.kind === 'login') {
    return <div className="cialai-agents-term__login">
      <span className="cialai-agents-term__host">{line.host}</span>
      <span className="cialai-agents-term__who">{line.who}</span>
      <span className={`cialai-agents-term__continue${line.pressed ? ' is-down' : ''}`}>{t('agentProfiles.tutorial.continue')}</span>
    </div>;
  }
  if (line.kind === 'opened') {
    return <div className="cialai-agents-term__opened"><i aria-hidden="true" /><Parts parts={line.parts} /></div>;
  }
  return <div className="cialai-agents-term__line"><Parts parts={line.parts} /></div>;
}

export default function AgentProfilesTutorial({ agent, name, path, shell }) {
  const { locale } = useI18n();
  const t = translate;
  const tool = agentById(agent);
  const settledName = useDebounced(name || t('agentProfiles.tutorial.sampleName'), NAME_DEBOUNCE_MS);
  const [scene, setScene] = useState(0);
  const [run, setRun] = useState(0);
  const [paused, setPaused] = useState(false);
  const [lines, setLines] = useState([]);
  const [key, setKey] = useState({ label: '', phase: 'hidden' });
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const context = useMemo(() => ({
    t,
    tool,
    name: settledName,
    path,
    accounts: tutorialAccounts({ name: settledName, t }),
  }), [tool, settledName, path, locale]);

  useEffect(() => {
    let alive = true;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const sleep = (ms) => new Promise((resolve, reject) => {
      let left = reduced ? Math.min(ms, 300) : ms;
      const tick = () => {
        if (!alive) { reject(CANCELLED); return; }
        if (!pausedRef.current) left -= TICK_MS;
        if (left <= 0) resolve();
        else setTimeout(tick, TICK_MS);
      };
      setTimeout(tick, TICK_MS);
    });
    let sequence = 0;
    const api = {
      sleep,
      add(line) {
        sequence += 1;
        const id = sequence;
        setLines((current) => [...current, { ...line, id }]);
        return id;
      },
      patch(id, change) { setLines((current) => current.map((line) => (line.id === id ? { ...line, ...change } : line))); },
      async press(label) {
        setKey({ label, phase: 'shown' });
        await sleep(280);
        setKey({ label, phase: 'down' });
        await sleep(160);
        setKey({ label, phase: 'shown' });
        await sleep(380);
        setKey({ label, phase: 'hidden' });
      },
    };
    setLines([]);
    setKey({ label: '', phase: 'hidden' });
    SCRIPTS[SCENES[scene].id](api, context)
      .then(() => sleep(300))
      .then(() => { if (alive) setScene((current) => (current + 1) % SCENES.length); })
      .catch((error) => { if (error !== CANCELLED) console.error('[agent-profiles]', error); });
    return () => { alive = false; };
  }, [scene, run, context]);

  const jump = (index) => { setScene(index); setRun((value) => value + 1); };
  const current = SCENES[scene];
  const title = t(`agentProfiles.tutorial.${current.id}.title`, { command: tool.command });
  const text = t(`agentProfiles.tutorial.${current.id}.text`);

  return <div className="cialai-agents-tutorial">
    <div className="cialai-agents-tutorial__top">
      <span className="cialai-agents-tutorial__label">{t('agentProfiles.howItWorks')}</span>
      <div className="cialai-agents-tutorial__controls">
        <button type="button" className="cialai-agents__icon" onClick={() => { setPaused(false); jump(0); }} title={t('agentProfiles.tutorial.restart')} aria-label={t('agentProfiles.tutorial.restart')}><RotateCcw size={15} strokeWidth={1.75} /></button>
        <button type="button" className="cialai-agents__icon" onClick={() => setPaused((value) => !value)} title={t(paused ? 'agentProfiles.tutorial.resume' : 'agentProfiles.tutorial.pause')} aria-label={t(paused ? 'agentProfiles.tutorial.resume' : 'agentProfiles.tutorial.pause')}>{paused ? <Play size={15} strokeWidth={1.75} /> : <Pause size={15} strokeWidth={1.75} />}</button>
      </div>
    </div>
    <div className="cialai-agents-tutorial__caption" key={`${scene}-${run}`}>
      <h3>{title}</h3>
      <p>{current.id === 'shortcut' ? <><code>{`${tool.command} +${settledName}`}</code> {text}</> : text}</p>
    </div>
    <div className="cialai-agents-term" aria-hidden="true">
      <div className="cialai-agents-term__title">{shell.title}</div>
      <div className="cialai-agents-term__body">{lines.map((line) => <Line key={line.id} line={line} shell={shell} t={t} />)}</div>
      <div className={`cialai-agents-term__key is-${key.phase}`}>{key.label}</div>
    </div>
    <div className="cialai-agents-tutorial__steps" role="tablist" aria-label={t('agentProfiles.howItWorks')}>
      {SCENES.map((item, index) => <button key={item.id} type="button" role="tab" aria-selected={index === scene} aria-label={t('agentProfiles.tutorial.step', { step: index + 1 })} className={index < scene ? 'is-done' : index === scene ? 'is-active' : undefined} onClick={() => jump(index)}>
        <span><i key={index === scene ? `${scene}-${run}` : 'idle'} style={index === scene ? { animationDuration: `${item.duration}ms`, animationPlayState: paused ? 'paused' : 'running' } : undefined} /></span>
      </button>)}
    </div>
  </div>;
}
