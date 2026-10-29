// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import brotoMark from '../assets/broto-mark.png';
import { getLocale, translate as t, useI18n } from '../shared/i18n.js';
import './monitor.css';

const ACTOR_KEYS = { human: 'broto.actor.human', phone: 'broto.actor.phone', ai: 'broto.actor.ai' };
const ACTIVITY_KEYS = { 'files.put': 'broto.activity.files.put', 'files.get': 'broto.activity.files.get', exec: 'broto.activity.exec', 'pty.open': 'broto.activity.pty.open', 'pty.write': 'broto.activity.pty.write', 'pty.resize': 'broto.activity.pty.resize', 'pty.kill': 'broto.activity.pty.kill', hello: 'broto.activity.hello' };
// O código de Broto começa por CIALAIB e a versão. O serviço decodifica e
// recusa o resto; aqui só se separa um código de um texto colado por engano.
const CODE_PATTERN = /^CIALAIB\d+\.\S+$/;
const CODE_PREFIX = 'CIALAIB';
// O serviço respondeu e recusou o pedido. Os outros erros são do caminho até ele.
const REQUEST_FAILED = 'service_request_failed';
// No Windows, a janela recusa antes do UAC uma conta de administrador.
const ACCOUNT_PRIVILEGED = 'service_account_privileged';

// No Windows a janela lê a área de transferência pelo sistema, sem o pedido de
// permissão do WebView2. Nos outros sistemas o comando avisa que não existe.
async function readClipboard() {
  try { return await invoke('broto_clipboard_text'); }
  catch (error) {
    if (error !== 'clipboard_unsupported') throw error;
    return navigator.clipboard.readText();
  }
}

function codeState(code) {
  if (!code) return 'empty';
  if (CODE_PATTERN.test(code)) return 'ready';
  const head = code.slice(0, CODE_PREFIX.length);
  return CODE_PREFIX.startsWith(head) && !code.includes('.') ? 'typing' : 'invalid';
}

function ConnectScreen({ busy, failed, serviceError, onConnect, onEdit }) {
  const [pairing, setPairing] = useState('');
  const field = useRef(null);
  const state = codeState(pairing);
  // O último erro do serviço, como uma recusa, some quando um código novo entra.
  const lastError = state === 'empty' ? serviceError : null;
  const note = state === 'invalid' ? t('broto.connect.invalid') : failed ? t('broto.connect.failed') : lastError || t('broto.connect.rule');
  const noteTone = state === 'invalid' || failed || lastError ? 'is-error' : '';
  const paste = async () => {
    try { setPairing((await readClipboard()).replace(/\s+/g, '')); onEdit(); }
    catch { field.current?.focus(); }
  };
  return <section className="broto-screen">
    <img className="broto-mark" src={brotoMark} alt="" />
    <h1>{t('broto.connect.title')}</h1>
    <p className="broto-lead">{t('broto.connect.lead')}</p>
    <form className="broto-form" onSubmit={event => { event.preventDefault(); if (state === 'ready') onConnect(pairing); }}>
      <label className="broto-label" htmlFor="pairing">{t('broto.connect.code')}</label>
      <div className={`broto-code ${state === 'invalid' ? 'is-error' : ''}`}>
        <input ref={field} id="pairing" type="text" value={pairing} onChange={event => { setPairing(event.target.value.replace(/\s+/g, '')); onEdit(); }} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} aria-invalid={state === 'invalid'} aria-describedby="pairing-note" />
        <button type="button" className="broto-paste" onClick={paste}>{t('broto.connect.paste')}</button>
      </div>
      <p id="pairing-note" className={`broto-note ${noteTone}`} role={noteTone ? 'alert' : undefined}>{note}</p>
      <div className="broto-form__actions">
        <button type="submit" className={`broto-btn broto-btn--primary ${busy ? 'is-busy' : ''}`} data-broto-action="connect" disabled={busy || state !== 'ready'}>{busy && <i className="broto-spinner" aria-hidden="true" />}{t('broto.connect.action')}</button>
      </div>
    </form>
  </section>;
}

function Progress({ label }) {
  return <div className="broto-progress" role="progressbar" aria-label={label}><span /></div>;
}

function WaitingScreen({ status, busy, failed, onCancel }) {
  const digits = String(status.digits || '');
  return <section className="broto-screen" aria-live="polite">
    <img className="broto-mark" src={brotoMark} alt="" />
    <h1>{t('broto.waiting', { host: status.host || 'Cialai' })}</h1>
    <p className="broto-lead">{t('broto.waitingHint')}</p>
    <strong className="broto-digits">{digits.split('').map((digit, index) => <span key={index}>{digit}</span>)}</strong>
    <Progress label={t('broto.waiting', { host: status.host || 'Cialai' })} />
    {failed && <p className="broto-note is-error" role="alert">{t('broto.actionFailed')}</p>}
    <div className="broto-form__actions">
      <button className="broto-btn" data-broto-action="cancel" disabled={busy} onClick={onCancel}>{t('broto.cancel')}</button>
    </div>
  </section>;
}

// Um Broto já vinculado volta a ligar sozinho quando o serviço reinicia ou o
// hospedeiro fecha; sem dígitos, não há o que aprovar, só esperar o Cialai.
function ReconnectingScreen({ status, busy, onDisconnect }) {
  return <section className="broto-screen" aria-live="polite">
    <img className="broto-mark" src={brotoMark} alt="" />
    <h1>{t('broto.reconnecting', { host: status.host || 'Cialai' })}</h1>
    <p className="broto-lead">{t('broto.reconnectingHint')}</p>
    <Progress label={t('broto.reconnecting', { host: status.host || 'Cialai' })} />
    {status.error && <p className="broto-note">{status.error}</p>}
    <div className="broto-form__actions">
      <button className="broto-btn broto-btn--danger" data-broto-action="disconnect" disabled={busy} onClick={onDisconnect}>{t('broto.disconnect')}</button>
    </div>
  </section>;
}

function ServiceScreen({ installing, installFailed, onInstall }) {
  return <section className="broto-screen">
    <img className="broto-mark" src={brotoMark} alt="" />
    <h1>{t('broto.service.title')}</h1>
    <p className="broto-lead">{t('broto.service.lead')}</p>
    {installing && <><Progress label={t('broto.service.installing')} /><p className="broto-note" aria-live="polite">{t('broto.service.progress')}</p></>}
    {installFailed && <p className="broto-note is-error" role="alert">{t(installFailed === 'privileged' ? 'broto.service.privileged' : 'broto.service.failed')}</p>}
    {installFailed !== 'privileged' && <div className="broto-form__actions">
      <button className={`broto-btn broto-btn--primary ${installing ? 'is-busy' : ''}`} data-broto-action="install" disabled={installing} onClick={onInstall}>{installing && <i className="broto-spinner" aria-hidden="true" />}{t(installing ? 'broto.service.installing' : 'broto.service.install')}</button>
    </div>}
  </section>;
}

function ActivityDetails({ item }) {
  const transfer = item.cmd === 'files.get' || item.cmd === 'files.put';
  const failed = transfer && item.outcome === 'error';
  const label = failed
    ? t(item.cmd === 'files.put' ? 'broto.activity.files.receiveFailed' : 'broto.activity.files.sendFailed')
    : ACTIVITY_KEYS[item.cmd] ? t(ACTIVITY_KEYS[item.cmd]) : item.cmd;
  return <span className={`broto-activity__what${failed ? ' is-error' : ''}`}>
    <span>{label}</span>
    {transfer && typeof item.path === 'string' && item.path && <code className="broto-activity__path">{item.path}</code>}
    {failed && typeof item.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(item.code) && <small className="broto-activity__error-code"><span>{t('broto.activity.errorCode')}</span><code>{item.code}</code></small>}
  </span>;
}

export function MonitorScreen({ status, busy, failed, onRun }) {
  const paused = status.state === 'paused';
  const activity = status.activity || [];
  return <section className="broto-monitor">
    <header className="broto-monitor__head">
      <img className="broto-mark broto-mark--small" src={brotoMark} alt="" />
      <div className="broto-monitor__title">
        <h1>{t('broto.connected', { host: status.host || 'Cialai' })}</h1>
        <div className="broto-chips" role="status">
          {paused && <span className="broto-chip is-paused"><i aria-hidden="true" />{t('broto.paused')}</span>}
          <span className={`broto-chip ${paused ? '' : 'is-online'}`}>{!paused && <i aria-hidden="true" />}{t(status.transport === 'direct' ? 'broto.direct' : 'broto.reserve')}</span>
        </div>
      </div>
      <div className="broto-monitor__actions">
        <button className="broto-btn" data-broto-action={paused ? 'resume' : 'pause'} disabled={busy} onClick={() => onRun(paused ? 'resume' : 'pause')}>{t(paused ? 'broto.resume' : 'broto.pause')}</button>
        <button className="broto-btn broto-btn--danger" data-broto-action="disconnect" disabled={busy} onClick={() => onRun('disconnect')}>{t('broto.disconnect')}</button>
      </div>
    </header>
    {failed && <p className="broto-note is-error" role="alert">{t('broto.actionFailed')}</p>}
    <h2>{t('broto.monitor.activity')}</h2>
    {!activity.length && <p className="broto-activity__none">{t('broto.empty')}</p>}
    {activity.length > 0 && <ol className="broto-activity">{activity.map((item, index) => <li key={`${item.ts}:${index}`}>
      <time>{new Date(item.ts).toLocaleTimeString(getLocale())}</time>
      <ActivityDetails item={item} />
      <span className={`broto-activity__who ${item.actor === 'ai' ? 'is-ai' : ''}`}>{ACTOR_KEYS[item.actor] ? t(ACTOR_KEYS[item.actor]) : item.actor}</span>
    </li>)}</ol>}
    <footer className="broto-monitor__foot">{t('broto.hint')}</footer>
  </section>;
}

export function BrotoMonitor() {
  useI18n();
  const [status, setStatus] = useState({ state: 'disconnected', activity: [] });
  const [ready, setReady] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  const [installing, setInstalling] = useState(false);
  const [installFailed, setInstallFailed] = useState(null);
  const refresh = async () => {
    try { setStatus(await invoke('broto_control', { method: 'broto.status', params: {} })); setUnreachable(false); }
    catch { setUnreachable(true); }
    finally { setReady(true); }
  };
  useEffect(() => { refresh(); const timer = setInterval(refresh, 1500); return () => clearInterval(timer); }, []);
  const run = async (method, params = {}) => {
    setBusy(true); setFailed(null);
    try { await invoke('broto_control', { method: `broto.${method}`, params }); await refresh(); }
    catch (error) {
      if (error === REQUEST_FAILED) setFailed(method);
      else await refresh();
    }
    finally { setBusy(false); }
  };
  const install = async () => {
    setInstalling(true); setInstallFailed(null);
    try { await invoke('broto_service_install'); await refresh(); }
    catch (error) { setInstallFailed(error === ACCOUNT_PRIVILEGED ? 'privileged' : 'failed'); }
    finally { setInstalling(false); }
  };
  const linked = ['connected', 'paused'].includes(status.state);
  // Até a primeira resposta do serviço a janela fica vazia, sem piscar o
  // formulário numa máquina em que o serviço ainda não existe.
  const screen = !ready ? null
    : unreachable ? <ServiceScreen installing={installing} installFailed={installFailed} onInstall={install} />
    : status.state === 'waiting' && !status.digits ? <ReconnectingScreen status={status} busy={busy} onDisconnect={() => run('disconnect')} />
    : status.state === 'waiting' ? <WaitingScreen status={status} busy={busy} failed={failed === 'disconnect'} onCancel={() => run('disconnect')} />
    : linked ? <MonitorScreen status={status} busy={busy} failed={Boolean(failed)} onRun={run} />
    : <ConnectScreen busy={busy} failed={failed === 'connect'} serviceError={status.error} onConnect={pairing => run('connect', { pairing })} onEdit={() => setFailed(null)} />;
  return <main className={`broto ${linked && !unreachable ? 'is-linked' : ''}`}>{screen}</main>;
}

createRoot(document.getElementById('root')).render(<BrotoMonitor />);
