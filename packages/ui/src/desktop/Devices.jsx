// SPDX-License-Identifier: Apache-2.0
// Desktop network status and paired device management.

import React, { useEffect, useRef, useState } from 'react';
import { Activity, ChevronRight, CircleAlert, CircleCheck, KeyRound, Pencil, RefreshCw, ShieldOff, Smartphone } from 'lucide-react';
import { AppModal, DataState, useToast } from '../components/ui.jsx';
import { useTunnel, tunnelErrorMessage } from './TunnelContext.jsx';
import AccessPanel, { ReserveValue, directLabel } from './AccessPanel.jsx';
import { candidateKindLabel, deviceTransport, formatLastSeen, mappingLabel, publicNetworks } from './tunnel-model.js';
import { getLocale, translate } from './i18n.js';

const TRANSPORT_KEYS = Object.freeze({ direct: 'desktop.devices.transportDirect', tor: 'desktop.devices.transportReserve' });
const NETWORK_KEYS = Object.freeze({
  tor: { title: 'desktop.access.publicTor', description: 'desktop.access.publicTorDescription' },
  stun: { title: 'desktop.access.publicStun', description: 'desktop.access.publicStunDescription' },
  mdns: { title: 'desktop.access.publicMdns', description: 'desktop.access.publicMdnsDescription' },
});
const NETWORK_STATE_KEYS = Object.freeze({ active: 'desktop.access.networkActive', preparing: 'desktop.access.networkPreparing', off: 'desktop.access.networkOff', failed: 'desktop.access.networkFailed' });
const NETWORK_STATE_TONES = Object.freeze({ active: 'ok', preparing: 'busy', off: 'idle', failed: 'bad' });

function Detail({ label, value, mono = false, wrap = false }) {
  return <div className="mac-device-detail"><dt>{label}</dt><dd className={`${mono ? 'is-mono' : ''}${wrap ? ' is-wrap' : ''}`}>{value || translate('desktop.common.unavailable')}</dd></div>;
}

function TransportBadge({ device }) {
  const transport = deviceTransport(device);
  if (!transport) return <span className="mac-device-row__state"><i className="mac-dot" aria-hidden="true" />{translate('desktop.devices.offline')}</span>;
  return <span className={`mac-transport is-${transport}`}>{translate(TRANSPORT_KEYS[transport])}</span>;
}

function DeviceRow({ device, onRename, onRevoke }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!editing) setName(device.name); }, [device.name, editing]);

  const save = async () => {
    const next = name.trim();
    if (!next || next === device.name) { setName(device.name); setEditing(false); return; }
    setBusy(true);
    try { await onRename(device.id, next); setEditing(false); } catch (_error) { /* the page owns the visible error */ } finally { setBusy(false); }
  };

  return <li className={`mac-device-row${device.connected ? ' is-connected' : ''}`}>
    <span className="mac-device-row__icon" aria-hidden="true"><Smartphone /></span>
    <div className="mac-device-row__identity">
      {editing ? <div className="mac-device-row__rename"><input className="field__control" value={name} maxLength="48" autoFocus aria-label={translate('desktop.devices.rename', { name: device.name })} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') save(); if (event.key === 'Escape') { setName(device.name); setEditing(false); } }} /><button type="button" className="btn btn-primary btn-sm" disabled={busy || !name.trim()} onClick={save}>{translate('desktop.action.save')}</button><button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => { setName(device.name); setEditing(false); }}>{translate('desktop.action.cancel')}</button></div> : <><strong>{device.name}</strong><span>{device.model || translate('desktop.devices.modelMissing')}</span></>}
    </div>
    <div className="mac-device-row__platform"><span>{String(device.platform || translate('desktop.devices.device')).toUpperCase()}</span><small>{device.app ? translate('desktop.devices.appVersion', { version: device.app }) : translate('desktop.devices.modelMissing')}</small></div>
    <div className="mac-device-row__seen"><TransportBadge device={device} /><small>{device.connected ? translate('desktop.devices.connectedNow') : formatLastSeen(device.lastSeenAt)}</small></div>
    <div className="mac-device-row__actions"><button type="button" className="mac-tool" title={translate('desktop.devices.rename', { name: device.name })} aria-label={translate('desktop.devices.rename', { name: device.name })} onClick={() => setEditing(true)}><Pencil aria-hidden="true" /></button><button type="button" className="mac-tool is-danger" title={translate('desktop.devices.revoke', { name: device.name })} aria-label={translate('desktop.devices.revoke', { name: device.name })} onClick={() => onRevoke(device)}><ShieldOff aria-hidden="true" /></button></div>
  </li>;
}

function RevokeDialog({ device, onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try { await onConfirm(device.id); onClose(); } catch (_error) { /* the page owns the visible error */ } finally { setBusy(false); }
  };
  return <AppModal open={Boolean(device)} title={translate('desktop.devices.revokeTitle')} onClose={busy ? undefined : onClose} maxWidth="xs" footer={<><button type="button" className="btn btn-quiet" disabled={busy} onClick={onClose}>{translate('desktop.action.cancel')}</button><button type="button" className="btn btn-danger" disabled={busy} onClick={confirm}>{busy ? translate('desktop.devices.revoking') : translate('desktop.devices.revokeAccess')}</button></>}><div className="mac-revoke"><p>{translate('desktop.devices.revokeDescription', { name: device.name })}</p></div></AppModal>;
}

function Advanced({ tunnel, notify, setError }) {
  const [diagnostic, setDiagnostic] = useState(null);
  const [busy, setBusy] = useState('');
  const net = tunnel.snapshot.net;
  const tor = tunnel.snapshot.tor || net?.tor || null;
  const direct = directLabel(tunnel.snapshot);
  const candidates = net?.direct?.candidates || [];
  const mapping = net?.direct?.mapping;

  const run = async (kind, action) => {
    setBusy(kind); setError('');
    try { await action(); } catch (actionError) { setError(tunnelErrorMessage(actionError)); } finally { setBusy(''); }
  };
  const diagnose = () => run('diagnose', async () => {
    setDiagnostic(await tunnel.runDiagnostics());
    notify(translate('desktop.devices.diagnosticUpdated'), 'success');
  });
  const refresh = () => run('refresh', () => tunnel.refreshNetwork());
  const deleteKey = () => run('key', async () => {
    await tunnel.deleteLegacyApiKey();
    notify(translate('desktop.access.legacyKeyDeleted'), 'success');
  });

  const checkedAt = diagnostic ? new Intl.DateTimeFormat(getLocale(), { timeStyle: 'short' }).format(new Date(diagnostic.checkedAt)) : '';

  return <div className="mac-advanced__body">
    <div className="mac-advanced__grid">
      <section className="mac-advanced__card" aria-labelledby="advanced-identity">
        <h4 id="advanced-identity">{translate('desktop.access.identity')}</h4>
        <dl className="mac-advanced__details">
          <Detail label={translate('desktop.access.computerName')} value={tunnel.desktopName} />
          <Detail label={translate('desktop.access.fingerprint')} value={tunnel.desktop?.fingerprint} mono />
          <Detail label={translate('desktop.access.identifier')} value={tunnel.desktop?.id} mono wrap />
        </dl>
      </section>

      <section className="mac-advanced__card" aria-labelledby="advanced-direct">
        <h4 id="advanced-direct">{translate('desktop.access.direct')}</h4>
        <dl className="mac-advanced__details">
          <Detail label={translate('desktop.access.state')} value={direct.label} />
          <Detail label={translate('desktop.access.udpPort')} value={net?.direct?.port ? String(net.direct.port) : null} mono />
          <Detail label={translate('desktop.access.mapping')} value={mapping ? mappingLabel(mapping) : null} />
          <Detail label={translate('desktop.access.mappedAddress')} value={mapping?.external} mono />
        </dl>
        <p className="mac-advanced__label">{translate('desktop.access.candidates')}</p>
        {candidates.length ? <ul className="mac-advanced__list">{candidates.map((candidate) => <li key={`${candidate.kind}:${candidate.addr}`}><span className="mac-chip">{candidateKindLabel(candidate.kind)}</span><code>{candidate.addr}</code></li>)}</ul> : <p className="mac-advanced__empty">{translate('desktop.access.noCandidates')}</p>}
      </section>

      <section className="mac-advanced__card" aria-labelledby="advanced-reserve">
        <h4 id="advanced-reserve">{translate('desktop.access.reserve')}</h4>
        <dl className="mac-advanced__details">
          <div className="mac-device-detail"><dt>{translate('desktop.access.bootstrap')}</dt><dd><ReserveValue tor={tor} /></dd></div>
          <Detail label={translate('desktop.access.publication')} value={tor?.published ? translate('desktop.access.published') : translate('desktop.access.notPublished')} />
          <Detail label={translate('desktop.access.onion')} value={tor?.onion} mono wrap />
        </dl>
      </section>

      <section className="mac-advanced__card" aria-labelledby="advanced-networks">
        <h4 id="advanced-networks">{translate('desktop.access.publicNetworks')}</h4>
        <p className="mac-advanced__note">{translate('desktop.access.publicNetworksDescription')}</p>
        <ul className="mac-advanced__networks">{publicNetworks(net, tor).map((item) => <li key={item.id}><span><strong>{translate(NETWORK_KEYS[item.id].title)}</strong><small>{translate(NETWORK_KEYS[item.id].description)}</small></span><span className={`mac-chip is-${NETWORK_STATE_TONES[item.state]}`}>{translate(NETWORK_STATE_KEYS[item.state])}</span></li>)}</ul>
      </section>
    </div>

    <section className="mac-advanced__card mac-advanced__checks" aria-labelledby="advanced-checks">
      <div className="mac-advanced__card-head"><div><h4 id="advanced-checks">{translate('desktop.access.checks')}</h4>{diagnostic ? <p className={`mac-advanced__verdict${diagnostic.ok ? ' is-ok' : ' is-warn'}`} role="status">{diagnostic.ok ? translate('desktop.access.checksOk') : translate('desktop.access.checksWarn')}<span>{translate('desktop.access.checkedAt', { time: checkedAt })}</span></p> : <p className="mac-advanced__note">{translate('desktop.access.checksDescription')}</p>}</div>
        <div className="mac-advanced__actions"><button type="button" className="btn btn-secondary btn-sm" disabled={Boolean(busy)} onClick={diagnose}><Activity aria-hidden="true" />{busy === 'diagnose' ? translate('desktop.access.running') : translate('desktop.devices.runDiagnostic')}</button><button type="button" className="btn btn-quiet btn-sm" disabled={Boolean(busy)} onClick={refresh}><RefreshCw aria-hidden="true" />{translate('desktop.access.refreshNetwork')}</button></div>
      </div>
      {diagnostic ? <ul className="mac-advanced__check-list">{diagnostic.checks.map((check) => <li key={check.id} className={check.ok ? 'is-ok' : 'is-warn'}>{check.ok ? <CircleCheck aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}<span>{check.label}</span>{check.detail ? <code>{check.detail}</code> : null}</li>)}</ul> : null}
    </section>

    <section className="mac-advanced__card mac-advanced__legacy" aria-labelledby="advanced-legacy">
      <div><h4 id="advanced-legacy">{translate('desktop.access.legacyKey')}</h4><p className="mac-advanced__note">{translate('desktop.access.legacyKeyDescription')}</p></div>
      <button type="button" className="btn btn-quiet btn-sm" disabled={Boolean(busy)} onClick={deleteKey}><KeyRound aria-hidden="true" />{translate('desktop.access.legacyKeyDelete')}</button>
    </section>
  </div>;
}

export default function Devices() {
  const tunnel = useTunnel();
  const notify = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revoke, setRevoke] = useState(null);
  const advancedRef = useRef(null);
  const pair = () => window.dispatchEvent(new CustomEvent('cialai:pair-device'));

  const refresh = async () => {
    if (!tunnel.native && !tunnel.demo) return;
    setLoading(true); setError('');
    try { await tunnel.refreshDevices(); } catch (refreshError) { setError(tunnelErrorMessage(refreshError)); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (tunnel.snapshot.startup === 'started') refresh(); }, [tunnel.snapshot.startup]);

  useEffect(() => {
    if (!tunnel.advancedOpen) return;
    const frame = requestAnimationFrame(() => advancedRef.current?.scrollIntoView?.({ block: 'start', behavior: document.documentElement.dataset.motion === 'none' ? 'auto' : 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, [tunnel.advancedOpen]);

  const rename = async (deviceId, name) => {
    try { await tunnel.renameDevice(deviceId, name); notify(translate('desktop.devices.renamed'), 'success'); }
    catch (renameError) { setError(tunnelErrorMessage(renameError)); throw renameError; }
  };

  const revokeDevice = async (deviceId) => {
    try { await tunnel.revokeDevice(deviceId); notify(translate('desktop.devices.revoked'), 'success'); }
    catch (revokeError) { setError(tunnelErrorMessage(revokeError)); throw revokeError; }
  };

  // Um so botao de vincular, o do painel de acesso: o atalho repetido na
  // toolbar confundia com o proprio painel.
  return <div className="view active page mac-devices" id="view-dispositivos">
    <header className="mac-devices__head"><div><p className="mac-devices__eyebrow">{translate('desktop.access.title')}</p><h2>{translate('desktop.view.devices.label')}</h2><p>{translate('desktop.devices.description')}</p></div></header>

    <AccessPanel heading={false} onPair={pair} onDiagnostics={() => tunnel.setAdvancedOpen(true)} />

    <section className="mac-devices__list-section" aria-labelledby="paired-title"><div className="mac-devices__section-head"><div><h3 id="paired-title">{translate('desktop.devices.pairedPhones')}</h3><p>{translate(tunnel.devices.length === 1 ? 'desktop.devices.authorizedOne' : 'desktop.devices.authorizedMany', { count: tunnel.devices.length })}</p></div><button type="button" className="btn btn-secondary btn-sm" disabled={loading} onClick={refresh}><RefreshCw aria-hidden="true" />{translate('desktop.action.refresh')}</button></div>
      {loading && tunnel.devices.length === 0 ? <DataState type="loading" message={translate('desktop.devices.loading')} /> : null}
      {!loading && tunnel.devices.length === 0 ? <DataState type="empty" message={translate('desktop.devices.empty')} action={<button type="button" className="btn btn-primary" onClick={pair}>{translate('desktop.pair.generate')}</button>} /> : null}
      {tunnel.devices.length ? <ul className="mac-device-list">{tunnel.devices.map((device) => <DeviceRow key={device.id} device={device} onRename={rename} onRevoke={setRevoke} />)}</ul> : null}
    </section>

    <details className="mac-advanced" ref={advancedRef} open={tunnel.advancedOpen} onToggle={(event) => tunnel.setAdvancedOpen(event.currentTarget.open)}>
      <summary><ChevronRight aria-hidden="true" /><span><strong>{translate('desktop.access.advanced')}</strong><small>{translate('desktop.access.advancedDescription')}</small></span></summary>
      {tunnel.advancedOpen ? <Advanced tunnel={tunnel} notify={notify} setError={setError} /> : null}
    </details>
    {error ? <p className="mac-devices__error" role="alert">{error}</p> : null}
    {revoke ? <RevokeDialog device={revoke} onClose={() => setRevoke(null)} onConfirm={revokeDevice} /> : null}
  </div>;
}
