import CialaiSkill from './CialaiSkill.jsx';
import BrotoApprovals from './BrotoApprovals.jsx';
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useState } from 'react';
import { Copy, ShieldOff, Sprout, SquareTerminal } from 'lucide-react';
import './Brotos.css';
import { AppModal, DataState } from '../components/ui.jsx';
import { invoke, isTauri } from '../lib/native.js';
import { translate as t } from './i18n.js';

const LEVELS = [
  { value: 'read', label: 'desktop.brotos.levelRead', hint: 'desktop.brotos.accessRead' },
  { value: 'confirm', label: 'desktop.brotos.levelConfirm', hint: 'desktop.brotos.accessConfirm' },
  { value: 'free', label: 'desktop.brotos.levelFree', hint: 'desktop.brotos.accessFree' },
];


function expiresAt(code) {
  return typeof code.expiresAt === 'number' ? code.expiresAt * 1000 : new Date(code.expiresAt).getTime();
}

function clock(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Como a linha de celular, o sistema em caixa alta; o Go reporta o macOS como darwin.
function platformLabel(platform) {
  const name = String(platform || '');
  return (name === 'darwin' ? 'macos' : name).toUpperCase();
}

function BrotoStatus({ device }) {
  const transport = device.transport === 'direct' ? 'direct' : 'tor';
  const path = <small>{t(transport === 'direct' ? 'desktop.devices.transportDirect' : 'desktop.devices.transportReserve')}</small>;
  if (device.status === 'paused') return <div className="mac-device-row__seen"><span className="mac-transport is-paused">{t('desktop.brotos.paused')}</span>{path}</div>;
  if (device.status !== 'connected') return <div className="mac-device-row__seen"><span className="mac-device-row__state"><i className="mac-dot" aria-hidden="true" />{t('desktop.devices.offline')}</span></div>;
  return <div className="mac-device-row__seen"><span className={`mac-transport is-${transport}`}>{t(transport === 'direct' ? 'desktop.devices.transportDirect' : 'desktop.devices.transportReserve')}</span><small>{t('desktop.devices.connectedNow')}</small></div>;
}

function LevelPicker({ device, disabled, onChange }) {
  const current = device.level || 'confirm';
  return <div className="mac-segmented broto-level" role="radiogroup" aria-label={t('desktop.brotos.level')}>
    {LEVELS.map(level => <button key={level.value} type="button" role="radio" aria-checked={current === level.value} title={t(level.hint)} disabled={disabled} className={`mac-segmented__option${current === level.value ? ' is-selected' : ''}`} onClick={() => { if (current !== level.value) onChange(level.value); }}>{t(level.label)}</button>)}
  </div>;
}

function CodeDialog({ code, pending, now, busy, onDecide, onRegenerate, onClose }) {
  const [copied, setCopied] = useState(false);
  const remaining = Math.max(0, Math.ceil((expiresAt(code) - now) / 1000));
  const incoming = pending.find(pair => pair.pairId === code.pairId);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code.payload); setCopied(true); } catch { setCopied(false); }
  };
  const footer = incoming
    ? <><button type="button" className="btn btn-quiet" disabled={busy} onClick={() => onDecide(incoming, false)}>{t('desktop.brotos.deny')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => onDecide(incoming, true)}>{t('desktop.brotos.approve')}</button></>
    : remaining
      ? <><button type="button" className="btn btn-quiet" onClick={onClose}>{t('desktop.action.cancel')}</button><button type="button" className="btn btn-primary" onClick={copy}><Copy aria-hidden="true" />{t(copied ? 'desktop.brotos.copied' : 'desktop.brotos.copy')}</button></>
      : <><button type="button" className="btn btn-quiet" onClick={onClose}>{t('desktop.action.cancel')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={onRegenerate}>{t('desktop.brotos.regenerate')}</button></>;
  return <AppModal open title={t('desktop.brotos.add')} onClose={onClose} maxWidth="sm" footer={footer}>
    {incoming ? <div className="broto-code-dialog">
      <p className="broto-code-dialog__lead">{t('desktop.brotos.incoming', { name: incoming.name })}</p>
      <strong className="broto-code-dialog__digits">{incoming.digits}</strong>
    </div> : <div className="broto-code-dialog">
      <p className="broto-code-dialog__lead">{t('desktop.brotos.codeLead')}</p>
      <code className={`broto-code-dialog__code${remaining ? '' : ' is-expired'}`}>{code.payload}</code>
      <p className="broto-code-dialog__timer" role="timer">{remaining ? t('desktop.brotos.expires', { time: clock(remaining) }) : t('desktop.brotos.expired')}</p>
    </div>}
  </AppModal>;
}

export default function Brotos({ onRevoke }) {
  const [devices, setDevices] = useState([]);
  const [pending, setPending] = useState([]);
  const [renaming, setRenaming] = useState(null);
  const [newName, setNewName] = useState('');
  const [code, setCode] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(null);
  const refresh = async () => {
    if (!isTauri()) return;
    try {
      const [list, pairs] = await Promise.all([invoke('broto_list'), invoke('broto_pair_pending')]);
      setDevices(list || []); setPending(pairs || []);
      setError(current => (current?.key === 'desktop.brotos.error' ? null : current));
    } catch { setError({ key: 'desktop.brotos.error' }); }
  };
  useEffect(() => { refresh(); const timer = setInterval(() => { setNow(Date.now()); refresh(); }, 2000); return () => clearInterval(timer); }, []);
  // O código gira o relógio a cada segundo enquanto o diálogo está aberto.
  useEffect(() => { if (!code) return undefined; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [code]);
  const run = async (command, args) => {
    setBusy(true);
    try { const result = await invoke(command, args); await refresh(); return result; }
    catch { setError({ key: 'desktop.brotos.error' }); return null; }
    finally { setBusy(false); }
  };
  const begin = async () => { const next = await run('broto_pair_begin'); if (next) setCode(next); };
  const decidePair = async (pair, approve) => { await run('broto_pair_decide', { pairId: pair.pairId, approve }); if (code?.pairId === pair.pairId) setCode(null); };
  // Abrir terminal leva à tela de Terminais com a sessão nova já selecionada.
  // A lista de sessões a adota pela mesma tag que o hospedeiro dá a ela.
  const openTerminal = async (device) => {
    setOpening(device.id);
    try {
      const result = await invoke('broto_open', { deviceId: device.id });
      if (result?.id == null) throw new Error('broto_open_without_id');
      setError(null);
      window.dispatchEvent(new CustomEvent('cialai:open-broto-session', { detail: { tag: `broto:${device.id}:${result.id}` } }));
    } catch (failure) {
      // O motivo vem da máquina do Broto, como a política local ou o shell
      // que não abriu; sem ele a pessoa não tem o que corrigir.
      setError({ key: 'desktop.brotos.openFailed', detail: typeof failure === 'string' ? failure : failure?.message || '' });
    }
    finally { setOpening(null); }
  };
  const waiting = pending.filter(pair => pair.pairId !== code?.pairId);
  return <section className="mac-devices__list-section broto-section" aria-labelledby="brotos-title">
    <div className="mac-devices__section-head">
      <div><h3 id="brotos-title">{t('desktop.brotos.sectionTitle')}</h3><p>{t('desktop.brotos.sectionDescription')}</p></div>
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !isTauri()} onClick={begin}><Sprout aria-hidden="true" />{t('desktop.brotos.add')}</button>
    </div>

    {waiting.length > 0 && <div className="broto-group"><h4>{t('desktop.brotos.waiting')}</h4><ul className="mac-device-list">{waiting.map(pair => <li className="mac-device-row broto-pending-row" key={pair.pairId}>
      <span className="mac-device-row__icon" aria-hidden="true"><Sprout /></span>
      <div className="mac-device-row__identity"><strong>{pair.name}</strong><span>{platformLabel(pair.platform)}</span></div>
      <code className="broto-pending-row__digits">{pair.digits}</code>
      <div className="broto-row-actions"><button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => decidePair(pair, false)}>{t('desktop.brotos.deny')}</button><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => decidePair(pair, true)}>{t('desktop.brotos.approve')}</button></div>
    </li>)}</ul></div>}

    {devices.length ? <ul className="mac-device-list">{devices.map(device => <li className={`mac-device-row broto-device-row${device.status === 'connected' ? ' is-connected' : ''}`} key={device.id}>
      <span className="mac-device-row__icon" aria-hidden="true"><Sprout /></span>
      <div className="mac-device-row__identity"><strong>{device.name}</strong><span>{platformLabel(device.platform)}</span>      <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setRenaming(device); setNewName(device.name); }}>{t('desktop.brotos.rename')}</button>
      {Date.parse(device.approvalUntil) > now && <span>{t('desktop.brotos.granted', { minutes: Math.min(15, Math.ceil((Date.parse(device.approvalUntil) - now) / 60000)) })}<button type="button" className="btn btn-quiet btn-sm" onClick={() => run('broto_grant', { deviceId: device.id, end: true })}>{t('desktop.brotos.endGrant')}</button></span>}
</div>
      <BrotoStatus device={device} />
      <LevelPicker device={device} disabled={busy} onChange={level => run('broto_permission_set', { deviceId: device.id, level })} />
      <button type="button" className="btn btn-secondary btn-sm broto-open" disabled={busy || opening === device.id || device.status !== 'connected' || device.level === 'read'} onClick={() => openTerminal(device)}><SquareTerminal aria-hidden="true" />{t('desktop.brotos.openTerminal')}</button>
      <div className="mac-device-row__actions"><button type="button" className="mac-tool is-danger" title={t('desktop.brotos.revoke', { name: device.name })} aria-label={t('desktop.brotos.revoke', { name: device.name })} onClick={() => onRevoke(device)}><ShieldOff aria-hidden="true" /></button></div>
    </li>)}</ul> : !waiting.length && <DataState type="empty" message={t('desktop.brotos.empty')} />}

    {renaming && <AppModal open title={t('desktop.brotos.rename')} onClose={() => setRenaming(null)} maxWidth="sm" footer={<button type="button" className="btn btn-primary" disabled={busy || !newName.trim()} onClick={async () => { const result = await run('broto_rename', { deviceId: renaming.id, name: newName.trim() }); if (result !== null) setRenaming(null); }}>{t('desktop.action.save')}</button>}><input className="field__control" autoFocus maxLength={100} aria-label={t('desktop.brotos.rename')} value={newName} onChange={event => setNewName(event.target.value)} /></AppModal>}

    <BrotoApprovals allRequests />
    <CialaiSkill />
    {error && <p className="mac-devices__error" role="alert">{t(error.key)}{error.detail ? <small className="broto-error-detail">{error.detail}</small> : null}</p>}
    {code && <CodeDialog code={code} pending={pending} now={now} busy={busy} onDecide={decidePair} onRegenerate={begin} onClose={() => setCode(null)} />}
  </section>;
}
