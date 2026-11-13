// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import QRCode from 'qrcode';
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
// Ligar pelo celular: o serviço mostra um QR de uso único por 10 minutos, e a
// pessoa digita aqui os quatro números que o celular mostra. Três erros encerram.
const QR_ATTEMPTS = 3;
const QR_STAGES = ['showing', 'digits', 'approving', 'failed'];
const QR_FAILED_KEYS = { expired: 'broto.qr.failed.expired', denied: 'broto.qr.failed.denied', digits: 'broto.qr.failed.digits', refused: 'broto.qr.failed.refused' };

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

// Prazo do QR em milissegundos. O serviço manda RFC3339; segundos Unix também valem.
export function qrExpiry(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

// Tempo que sobra, em mm:ss, nunca negativo.
export function qrClock(expiresAt, now = Date.now()) {
  const expiry = qrExpiry(expiresAt);
  const seconds = Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - now) / 1000)) : 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function ConnectScreen({ pending, failed, qrFailed, serviceError, onConnect, onQr, onEdit }) {
  const busy = pending !== null;
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
    {/* O QR pelo celular vem primeiro: não há o que copiar entre as máquinas.
        O código colado continua logo abaixo, para quem já tem um. */}
    <div className="broto-choice">
      <div className="broto-choice__text">
        <h2>{t('broto.qr.choose')}</h2>
        <p>{t('broto.qr.chooseHint')}</p>
      </div>
      <button type="button" className={`broto-btn broto-btn--primary ${pending === 'qr.begin' ? 'is-busy' : ''}`} data-broto-action="qr" disabled={busy} onClick={onQr}>{pending === 'qr.begin' && <i className="broto-spinner" aria-hidden="true" />}{t('broto.qr.show')}</button>
    </div>
    {qrFailed && <p className="broto-note is-error" role="alert">{t('broto.qr.beginFailed')}</p>}
    <h2 className="broto-or">{t('broto.connect.or')}</h2>
    <p className="broto-lead">{t('broto.connect.lead')}</p>
    <form className="broto-form" onSubmit={event => { event.preventDefault(); if (state === 'ready') onConnect(pairing); }}>
      <label className="broto-label" htmlFor="pairing">{t('broto.connect.code')}</label>
      <div className={`broto-code ${state === 'invalid' ? 'is-error' : ''}`}>
        <input ref={field} id="pairing" type="text" value={pairing} onChange={event => { setPairing(event.target.value.replace(/\s+/g, '')); onEdit(); }} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} aria-invalid={state === 'invalid'} aria-describedby="pairing-note" />
        <button type="button" className="broto-paste" onClick={paste}>{t('broto.connect.paste')}</button>
      </div>
      <p id="pairing-note" className={`broto-note ${noteTone}`} role={noteTone ? 'alert' : undefined}>{note}</p>
      <div className="broto-form__actions">
        <button type="submit" className={`broto-btn broto-btn--primary ${pending === 'connect' ? 'is-busy' : ''}`} data-broto-action="connect" disabled={busy || state !== 'ready'}>{pending === 'connect' && <i className="broto-spinner" aria-hidden="true" />}{t('broto.connect.action')}</button>
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

// O QR que o celular lê, desenhado como no pareamento do celular no Cialai.
function QrCanvas({ payload, expired }) {
  const canvas = useRef(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!payload || !canvas.current) return;
    setFailed(false);
    QRCode.toCanvas(canvas.current, payload, { width: 280, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#241321', light: '#ffffff' } })
      .catch(() => setFailed(true));
  }, [payload]);
  if (failed) return <p className="broto-note is-error" role="alert">{t('broto.qr.drawFailed')}</p>;
  return <div className={`broto-qr${expired ? ' is-expired' : ''}`}><canvas ref={canvas} width="280" height="280" role="img" aria-label={t('broto.qr.label')} /></div>;
}

function QrShowScreen({ qr, busy, failed, onCancel }) {
  const now = useNow(true);
  const clock = qrClock(qr.expiresAt, now);
  return <section className="broto-screen broto-screen--qr" data-broto-qr-stage="showing">
    <h1>{t('broto.qr.title')}</h1>
    <p className="broto-lead">{t('broto.qr.instruction')}</p>
    <QrCanvas payload={qr.payload} expired={clock === '00:00'} />
    <p className="broto-qr__timer" role="timer"><span>{t('broto.qr.remaining')}</span><strong>{clock}</strong></p>
    <p className="broto-qr__status" role="status"><i aria-hidden="true" />{t('broto.qr.searching')}</p>
    {failed && <p className="broto-note is-error" role="alert">{t('broto.actionFailed')}</p>}
    <div className="broto-form__actions">
      <button type="button" className="broto-btn" data-broto-action="qr-cancel" disabled={busy} onClick={onCancel}>{t('broto.cancel')}</button>
    </div>
  </section>;
}

// Os quatro números que o celular mostra. Errar avisa quantas tentativas
// restam; a terceira falha encerra o pedido no serviço.
function QrDigitsScreen({ qr, busy, confirming, failed, onConfirm, onCancel }) {
  const [digits, setDigits] = useState('');
  const [missed, setMissed] = useState(null);
  const field = useRef(null);
  const reported = Number.isInteger(qr.attemptsLeft) && qr.attemptsLeft < QR_ATTEMPTS ? qr.attemptsLeft : null;
  const attemptsLeft = missed ?? reported;
  const ready = /^\d{4}$/.test(digits);
  const submit = async event => {
    event.preventDefault();
    if (busy || !ready) return;
    const result = await onConfirm(digits);
    if (result?.ok === false) {
      setMissed(Number.isInteger(result.attemptsLeft) ? result.attemptsLeft : reported);
      setDigits('');
      field.current?.focus();
    }
  };
  const note = failed ? t('broto.actionFailed')
    : attemptsLeft === 1 ? t('broto.qr.digits.missOne')
    : attemptsLeft != null ? t('broto.qr.digits.missMany', { count: attemptsLeft })
    : t('broto.qr.digits.rule');
  const tone = failed || attemptsLeft != null ? 'is-error' : '';
  return <section className="broto-screen" data-broto-qr-stage="digits">
    <img className="broto-mark" src={brotoMark} alt="" />
    <h1>{t('broto.qr.digits.title')}</h1>
    <p className="broto-lead">{t('broto.qr.digits.lead')}</p>
    <form className="broto-form" onSubmit={submit}>
      <label className="broto-label" htmlFor="qr-digits">{t('broto.qr.digits.label')}</label>
      <input ref={field} id="qr-digits" className={`broto-digits-field ${tone}`} type="text" inputMode="numeric" pattern="[0-9]*" maxLength={4} autoFocus autoComplete="off" autoCorrect="off" spellCheck={false} value={digits} onChange={event => setDigits(event.target.value.replace(/\D/g, '').slice(0, 4))} aria-invalid={attemptsLeft != null} aria-describedby="qr-digits-note" />
      <p id="qr-digits-note" className={`broto-note ${tone}`} role={tone ? 'alert' : undefined}>{note}</p>
      <div className="broto-form__actions">
        <button type="button" className="broto-btn" data-broto-action="qr-cancel" disabled={busy} onClick={onCancel}>{t('broto.cancel')}</button>
        <button type="submit" className={`broto-btn broto-btn--primary ${confirming ? 'is-busy' : ''}`} data-broto-action="qr-confirm" disabled={busy || !ready}>{confirming && <i className="broto-spinner" aria-hidden="true" />}{t('broto.qr.confirm')}</button>
      </div>
    </form>
  </section>;
}

function QrApprovingScreen({ busy, failed, onCancel }) {
  return <section className="broto-screen" data-broto-qr-stage="approving" aria-live="polite">
    <img className="broto-mark" src={brotoMark} alt="" />
    <h1>{t('broto.qr.approving.title')}</h1>
    <p className="broto-lead">{t('broto.qr.approving.lead')}</p>
    <Progress label={t('broto.qr.approving.title')} />
    {failed && <p className="broto-note is-error" role="alert">{t('broto.actionFailed')}</p>}
    <div className="broto-form__actions">
      <button type="button" className="broto-btn" data-broto-action="qr-cancel" disabled={busy} onClick={onCancel}>{t('broto.cancel')}</button>
    </div>
  </section>;
}

function QrFailedScreen({ qr, busy, starting, failed, onAgain, onBack }) {
  return <section className="broto-screen" data-broto-qr-stage="failed">
    <img className="broto-mark" src={brotoMark} alt="" />
    <h1>{t('broto.qr.failed.title')}</h1>
    <p className="broto-lead" role="alert">{t(QR_FAILED_KEYS[qr.reason] || 'broto.qr.failed.other')}</p>
    {failed && <p className="broto-note is-error" role="alert">{t(failed === 'qr.begin' ? 'broto.qr.beginFailed' : 'broto.actionFailed')}</p>}
    <div className="broto-form__actions">
      <button type="button" className="broto-btn" data-broto-action="qr-back" disabled={busy} onClick={onBack}>{t('broto.qr.back')}</button>
      <button type="button" className={`broto-btn broto-btn--primary ${starting ? 'is-busy' : ''}`} data-broto-action="qr-new" disabled={busy} onClick={onAgain}>{starting && <i className="broto-spinner" aria-hidden="true" />}{t('broto.qr.new')}</button>
    </div>
  </section>;
}

// Enquanto o serviço tem um pedido de QR, a janela mostra só ele, qualquer que
// seja o estado da conexão. Concluído, o `qr` some e as telas de sempre voltam.
export function QrFlow({ qr, pending, failed, onRun }) {
  const busy = pending != null;
  const stage = QR_STAGES.includes(qr.stage) ? qr.stage : 'showing';
  const failedHere = typeof failed === 'string' && failed.startsWith('qr.') ? failed : null;
  const cancel = () => onRun('qr.cancel');
  if (stage === 'digits') return <QrDigitsScreen qr={qr} busy={busy} confirming={pending === 'qr.confirm'} failed={Boolean(failedHere)} onCancel={cancel} onConfirm={digits => onRun('qr.confirm', { digits })} />;
  if (stage === 'approving') return <QrApprovingScreen busy={busy} failed={Boolean(failedHere)} onCancel={cancel} />;
  if (stage === 'failed') return <QrFailedScreen qr={qr} busy={busy} starting={pending === 'qr.begin'} failed={failedHere} onAgain={() => onRun('qr.begin')} onBack={cancel} />;
  return <QrShowScreen qr={qr} busy={busy} failed={Boolean(failedHere)} onCancel={cancel} />;
}

// Sem serviço, a tela pede para instalar. Com o serviço de um Broto até a
// 0.1.2 no Windows, que roda com a senha da conta, ela oferece atualizar: o
// mesmo instalador passa o serviço para SYSTEM, e a pessoa pode deixar para
// depois sem perder o monitor.
function ServiceScreen({ update, installing, installFailed, onInstall, onLater }) {
  return <section className="broto-screen">
    <img className="broto-mark" src={brotoMark} alt="" />
    <h1>{t(update ? 'broto.service.update.title' : 'broto.service.title')}</h1>
    <p className="broto-lead">{t(update ? 'broto.service.update.lead' : 'broto.service.lead')}</p>
    {installing && <><Progress label={t('broto.service.installing')} /><p className="broto-note" aria-live="polite">{t('broto.service.progress')}</p></>}
    {installFailed && <p className="broto-note is-error" role="alert">{t(update ? 'broto.service.update.failed' : 'broto.service.failed')}</p>}
    <div className="broto-form__actions">
      {update && <button className="broto-btn" data-broto-action="later" disabled={installing} onClick={onLater}>{t('broto.service.update.later')}</button>}
      <button className={`broto-btn broto-btn--primary ${installing ? 'is-busy' : ''}`} data-broto-action="install" disabled={installing} onClick={onInstall}>{installing && <i className="broto-spinner" aria-hidden="true" />}{t(installing ? 'broto.service.installing' : update ? 'broto.service.update.install' : 'broto.service.install')}</button>
    </div>
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
  // Pedido em curso, para só o botão dele girar; os outros só ficam travados.
  const [pending, setPending] = useState(null);
  const busy = pending !== null;
  const [failed, setFailed] = useState(null);
  const [installing, setInstalling] = useState(false);
  const [installFailed, setInstallFailed] = useState(false);
  const [later, setLater] = useState(false);
  const refresh = async () => {
    try { setStatus(await invoke('broto_control', { method: 'broto.status', params: {} })); setUnreachable(false); }
    catch { setUnreachable(true); }
    finally { setReady(true); }
  };
  useEffect(() => { refresh(); const timer = setInterval(refresh, 1500); return () => clearInterval(timer); }, []);
  // Devolve o resultado do serviço, ou nulo quando o pedido falhou: os números
  // errados do QR voltam como resultado, porque o Tauri descarta o texto do erro.
  const run = async (method, params = {}) => {
    setPending(method); setFailed(null);
    try { const result = await invoke('broto_control', { method: `broto.${method}`, params }); await refresh(); return result; }
    catch (error) {
      if (error === REQUEST_FAILED) setFailed(method);
      else await refresh();
      return null;
    }
    finally { setPending(null); }
  };
  const install = async () => {
    setInstalling(true); setInstallFailed(false);
    try { await invoke('broto_service_install'); await refresh(); }
    catch { setInstallFailed(true); }
    finally { setInstalling(false); }
  };
  const qr = status.qr && typeof status.qr === 'object' ? status.qr : null;
  const linked = !qr && ['connected', 'paused'].includes(status.state);
  // Até a primeira resposta do serviço a janela fica vazia, sem piscar o
  // formulário numa máquina em que o serviço ainda não existe.
  const screen = !ready ? null
    : unreachable ? <ServiceScreen installing={installing} installFailed={installFailed} onInstall={install} />
    : status.passwordService && !later ? <ServiceScreen update installing={installing} installFailed={installFailed} onInstall={install} onLater={() => { setLater(true); setInstallFailed(false); }} />
    : qr ? <QrFlow key={qr.payload || 'qr'} qr={qr} pending={pending} failed={failed} onRun={run} />
    : status.state === 'waiting' && !status.digits ? <ReconnectingScreen status={status} busy={busy} onDisconnect={() => run('disconnect')} />
    : status.state === 'waiting' ? <WaitingScreen status={status} busy={busy} failed={failed === 'disconnect'} onCancel={() => run('disconnect')} />
    : linked ? <MonitorScreen status={status} busy={busy} failed={Boolean(failed)} onRun={run} />
    : <ConnectScreen pending={pending} failed={failed === 'connect'} qrFailed={failed === 'qr.begin'} serviceError={status.error} onConnect={pairing => run('connect', { pairing })} onQr={() => run('qr.begin')} onEdit={() => setFailed(null)} />;
  return <main className={`broto ${linked && !unreachable ? 'is-linked' : ''}`}>{screen}</main>;
}

createRoot(document.getElementById('root')).render(<BrotoMonitor />);
