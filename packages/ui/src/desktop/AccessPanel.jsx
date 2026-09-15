// SPDX-License-Identifier: Apache-2.0
// Painel "Acesso pelo celular": estado da rede, reserva, celulares conectados
// e atalhos, sem nenhum campo. Usado em Preferências e em Dispositivos.

import React from 'react';
import { Activity, Link2, Smartphone } from 'lucide-react';
import { useTunnel } from './TunnelContext.jsx';
import { connectedCount, reserveLabel, reserveStatus } from './tunnel-model.js';
import { translate } from './i18n.js';

export function directLabel(snapshot) {
  const direct = snapshot.net?.direct?.state;
  if (direct === 'listening') return { tone: 'ok', label: translate('desktop.access.directReady') };
  if (direct === 'failed' || snapshot.net?.state === 'failed' || snapshot.startup === 'failed') return { tone: 'bad', label: translate('desktop.access.directFailed') };
  return { tone: 'busy', label: translate('desktop.access.directPreparing') };
}

export function DirectValue({ snapshot }) {
  const direct = directLabel(snapshot);
  return <span className={`mac-access__value is-${direct.tone}`}><span className="mac-access__value-text"><i className={`mac-dot is-${direct.tone}`} aria-hidden="true" />{direct.label}</span></span>;
}

export function ReserveValue({ tor }) {
  const reserve = reserveStatus(tor);
  const tone = reserve.state === 'ready' ? 'ok' : reserve.state === 'failed' ? 'bad' : reserve.state === 'disabled' ? 'idle' : 'busy';
  return <span className={`mac-access__value is-${tone}`}>
    <span className="mac-access__value-text"><i className={`mac-dot is-${tone}`} aria-hidden="true" />{reserveLabel(tor)}</span>
    {reserve.state === 'preparing' ? <span className="mac-progress" role="progressbar" aria-label={translate('desktop.access.reserve')} aria-valuemin="0" aria-valuemax="100" aria-valuenow={reserve.progress}><span style={{ width: `${reserve.progress}%` }} /></span> : null}
  </span>;
}

export default function AccessPanel({ onPair, onDiagnostics, heading = true }) {
  const tunnel = useTunnel();
  const { snapshot, status } = tunnel;
  const connected = connectedCount(tunnel.devices);
  const tor = snapshot.tor || snapshot.net?.tor || null;

  return <section className="mac-access" aria-labelledby={heading ? 'access-title' : undefined} aria-label={heading ? undefined : translate('desktop.access.title')}>
    <div className="mac-access__head">
      <span className="mac-access__icon" aria-hidden="true"><Smartphone /></span>
      <div className="mac-access__identity">
        {heading ? <h3 id="access-title">{translate('desktop.access.title')}</h3> : null}
        <p>{tunnel.desktopName || translate('desktop.access.thisComputer')}</p>
      </div>
      <span className={`mac-network-badge is-${status.tone}`} role="status"><span className={`mac-dot is-${status.tone}`} aria-hidden="true" />{status.label}</span>
    </div>
    <dl className="mac-access__rows">
      <div><dt>{translate('desktop.access.direct')}</dt><dd><DirectValue snapshot={snapshot} /></dd></div>
      <div><dt>{translate('desktop.access.reserve')}</dt><dd><ReserveValue tor={tor} /></dd></div>
      <div><dt>{translate('desktop.access.connectedPhones')}</dt><dd><span className="mac-access__count">{connected}</span></dd></div>
    </dl>
    {tunnel.lastError ? <p className="mac-access__error" role="alert">{tunnel.lastError}</p> : null}
    <div className="mac-access__actions">
      {onPair ? <button type="button" className="btn btn-primary btn-sm" onClick={onPair}><Link2 aria-hidden="true" />{translate('desktop.action.pairPhone')}</button> : null}
      {onDiagnostics ? <button type="button" className="btn btn-quiet btn-sm mac-access__link" onClick={onDiagnostics}><Activity aria-hidden="true" />{translate('desktop.access.advanced')}</button> : null}
    </div>
  </section>;
}
