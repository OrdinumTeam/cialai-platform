// SPDX-License-Identifier: Apache-2.0
// Folha de Ligar um Broto, aberta pela casca depois de ler o QR na tela do
// Broto. O celular mostra o nome, o sistema e os quatro numeros; a pessoa
// digita os numeros no Broto e confirma aqui. Fechar antes de um fim recusa.
import React, { useEffect, useRef, useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { invoke } from '../../lib/native.js';
import { translate } from '../../shared/i18n.js';
import { createBrotoQrFlow } from '../broto-qr.js';
import { Sheet } from './dialogs.jsx';

const ERROR_KEYS = Object.freeze({
  qr_invalid: 'terminal.brotoQr.error.invalid',
  qr_expired: 'terminal.brotoQr.expired',
  qr_used: 'terminal.brotoQr.error.used',
  qr_busy: 'terminal.brotoQr.error.busy',
  qr_unknown: 'terminal.brotoQr.error.unknown',
  qr_not_ready: 'terminal.brotoQr.error.notReady',
  outdated: 'terminal.brotoQr.error.outdated',
  bridge_disconnected: 'terminal.brotoQr.reconnecting',
  bridge_timeout: 'terminal.brotoQr.reconnecting',
});
const ENDED = new Set(['done', 'denied', 'expired', 'error']);
// Nome do sistema como o Broto informa; o Go chama o macOS de darwin.
const PLATFORM_NAMES = Object.freeze({ windows: 'Windows', linux: 'Linux', darwin: 'macOS', macos: 'macOS' });

export function brotoPlatformName(platform) {
  const value = String(platform || '');
  return PLATFORM_NAMES[value.toLowerCase()] || value;
}

export function brotoQrMessage(error) {
  if (!error) return '';
  const key = ERROR_KEYS[error.code];
  if (key) return translate(key);
  return error.message || translate('terminal.brotoQr.error.failed');
}

function Waiting({ label }) {
  return <p className="broto-qr-sheet__status" role="status"><i className="broto-qr-sheet__spinner" aria-hidden="true" />{label}</p>;
}

function Digits({ digits, muted }) {
  return <div className={`broto-qr-sheet__digits${muted ? ' is-muted' : ''}`} role="group" aria-label={translate('terminal.brotoQr.digitsLabel')}>
    {digits.split('').map((digit, index) => <span key={index}>{digit}</span>)}
  </div>;
}

export function BrotoQrBody({ view }) {
  const platform = brotoPlatformName(view.platform);
  const notice = view.notice ? <p className="broto-qr-sheet__notice" role="alert">{brotoQrMessage(view.notice)}</p> : null;
  if (view.stage === 'verify') return <div className="broto-qr-sheet" data-broto-qr-stage="verify">
    {platform && <p className="broto-qr-sheet__platform">{platform}</p>}
    <Digits digits={view.digits} />
    <p className="broto-qr-sheet__lead">{translate('terminal.brotoQr.verifyLead')}</p>
    <p className="broto-qr-sheet__hint">{translate('terminal.brotoQr.verifyHint')}</p>
    {notice}
  </div>;
  if (view.stage === 'approved') return <div className="broto-qr-sheet" data-broto-qr-stage="approved">
    {platform && <p className="broto-qr-sheet__platform">{platform}</p>}
    {view.digits && <Digits digits={view.digits} muted />}
    <Waiting label={translate('terminal.brotoQr.approved')} />
    {notice}
  </div>;
  if (view.stage === 'done') return <div className="broto-qr-sheet" data-broto-qr-stage="done">
    <p className="broto-qr-sheet__done" role="status"><CircleCheck size={22} aria-hidden="true" />{translate('terminal.brotoQr.done')}</p>
    <p className="broto-qr-sheet__lead">{translate('terminal.brotoQr.doneHint')}</p>
  </div>;
  if (view.stage === 'denied' || view.stage === 'expired') return <div className="broto-qr-sheet" data-broto-qr-stage={view.stage}>
    <p className="broto-qr-sheet__lead" role="status">{translate(view.stage === 'denied' ? 'terminal.brotoQr.denied' : 'terminal.brotoQr.expired')}</p>
  </div>;
  if (view.stage === 'error') return <div className="broto-qr-sheet" data-broto-qr-stage="error">
    <p className="broto-qr-sheet__error" role="alert">{brotoQrMessage(view.error)}</p>
  </div>;
  // Enviando o QR ou esperando o Broto chamar. Pelo Tor a espera e longa; sem
  // o Tor no computador, so a mesma rede liga.
  return <div className="broto-qr-sheet" data-broto-qr-stage={view.stage === 'waiting' ? 'waiting' : 'starting'}>
    {view.name && <div className="broto-qr-sheet__identity"><strong>{view.name}</strong>{platform && <span>{platform}</span>}</div>}
    <Waiting label={translate(view.stage === 'waiting' ? 'terminal.brotoQr.waiting' : 'terminal.brotoQr.starting')} />
    {view.stage === 'waiting' && <p className="broto-qr-sheet__hint">{translate(view.onion === 'off' ? 'terminal.brotoQr.onionOff' : 'terminal.brotoQr.waitingTor')}</p>}
    {notice}
  </div>;
}

export default function PhoneBrotoPairing({ request, onClose }) {
  const [view, setView] = useState(null);
  const flow = useRef(null);
  useEffect(() => {
    if (!request) return undefined;
    const current = createBrotoQrFlow({ invoke, payload: request.payload, onChange: setView });
    flow.current = current;
    setView(current.view());
    return () => {
      current.close();
      if (flow.current === current) flow.current = null;
      setView(null);
    };
  }, [request?.id]);
  const shown = request && view ? view : null;
  const close = () => {
    flow.current?.close();
    onClose();
  };
  const busy = Boolean(shown?.busy);
  const ended = ENDED.has(shown?.stage);
  const named = ['verify', 'approved'].includes(shown?.stage) && shown.name;
  const actions = !shown ? null
    : ended ? <button type="button" className="btn btn-primary" onClick={close}>{translate('terminal.common.close')}</button>
    : shown.stage === 'verify' ? <>
      <button type="button" className="btn btn-ghost" data-broto-qr-action="reject" disabled={busy} onClick={() => flow.current?.decide(false)}>{translate('terminal.brotoQr.reject')}</button>
      <button type="button" className="btn btn-primary" data-broto-qr-action="confirm" disabled={busy} onClick={() => flow.current?.decide(true)}>{translate('terminal.brotoQr.confirm')}</button>
    </>
    : <button type="button" className="btn btn-ghost" data-broto-qr-action="cancel" disabled={busy} onClick={close}>{translate('terminal.common.cancel')}</button>;
  return <Sheet open={Boolean(shown)} title={named ? shown.name : translate('terminal.brotoQr.title')} onClose={close} actions={actions}>
    {shown && <BrotoQrBody view={shown} />}
  </Sheet>;
}
