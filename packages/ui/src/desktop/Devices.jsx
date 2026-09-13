// SPDX-License-Identifier: Apache-2.0
// Desktop network status and paired device management.

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, KeyRound, Link2, Monitor, Pencil, RefreshCw, ShieldOff, Smartphone } from 'lucide-react';
import { AppModal, DataState, useToast } from '../components/ui.jsx';
import { useTunnel, tunnelErrorMessage } from './TunnelContext.jsx';
import { formatLastSeen, networkIsConfigured } from './tunnel-model.js';

function ToolbarActions({ children }) {
  const [slot, setSlot] = useState(null);
  useEffect(() => { setSlot(document.getElementById('mac-toolbar-slot')); }, []);
  return slot ? createPortal(children, slot) : null;
}

function Detail({ label, value, mono = false }) {
  return <div className="mac-device-detail"><dt>{label}</dt><dd className={mono ? 'is-mono' : ''}>{value || 'Não disponível'}</dd></div>;
}

function DeviceRow({ device, onRename, onRevoke }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const next = name.trim();
    if (!next || next === device.name) { setName(device.name); setEditing(false); return; }
    setBusy(true);
    try { await onRename(device.id, next); setEditing(false); } catch (_error) { /* the page owns the visible error */ } finally { setBusy(false); }
  };

  return <li className="mac-device-row">
    <span className="mac-device-row__icon" aria-hidden="true"><Smartphone /></span>
    <div className="mac-device-row__identity">
      {editing ? <div className="mac-device-row__rename"><input className="field__control" value={name} maxLength="48" autoFocus onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') save(); if (event.key === 'Escape') { setName(device.name); setEditing(false); } }} /><button type="button" className="btn btn-primary btn-sm" disabled={busy || !name.trim()} onClick={save}>Salvar</button><button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => { setName(device.name); setEditing(false); }}>Cancelar</button></div> : <><strong>{device.name}</strong><span>{device.model || 'Modelo não informado'}</span></>}
    </div>
    <div className="mac-device-row__platform"><span>{String(device.platform || 'dispositivo').toUpperCase()}</span><small>{device.ip4 || 'Sem endereço'}</small></div>
    <div className="mac-device-row__seen"><span><i className={`mac-dot${device.online ? ' is-ok' : ''}`} aria-hidden="true" />{device.online ? 'Online' : 'Offline'}</span><small>{formatLastSeen(device.lastSeenAt)}</small></div>
    <div className="mac-device-row__actions"><button type="button" className="mac-tool" title={`Renomear ${device.name}`} aria-label={`Renomear ${device.name}`} onClick={() => setEditing(true)}><Pencil aria-hidden="true" /></button><button type="button" className="mac-tool is-danger" title={`Revogar ${device.name}`} aria-label={`Revogar ${device.name}`} onClick={() => onRevoke(device)}><ShieldOff aria-hidden="true" /></button></div>
  </li>;
}

function RevokeDialog({ device, onClose, onConfirm }) {
  const [networkToo, setNetworkToo] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try { await onConfirm(device.id, networkToo); onClose(); } catch (_error) { /* the page owns the visible error */ } finally { setBusy(false); }
  };
  return <AppModal open={Boolean(device)} title="Revogar dispositivo" onClose={busy ? undefined : onClose} maxWidth="xs" footer={<><button type="button" className="btn btn-quiet" disabled={busy} onClick={onClose}>Cancelar</button><button type="button" className="btn btn-danger" disabled={busy} onClick={confirm}>{busy ? 'Revogando…' : 'Revogar acesso'}</button></>}><div className="mac-revoke"><p><strong>{device.name}</strong> perderá o acesso ao estúdio imediatamente.</p><label><input type="checkbox" checked={networkToo} onChange={(event) => setNetworkToo(event.target.checked)} /><span><strong>Remover também da rede</strong><small>Expira e apaga o nó deste dispositivo no Headscale.</small></span></label></div></AppModal>;
}

export default function Devices() {
  const tunnel = useTunnel();
  const notify = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revoke, setRevoke] = useState(null);
  const [diagnostic, setDiagnostic] = useState(null);

  const refresh = async () => {
    if (!networkIsConfigured(tunnel.network)) return;
    setLoading(true); setError('');
    try { await tunnel.refreshDevices(); } catch (refreshError) { setError(tunnelErrorMessage(refreshError)); }
    finally { setLoading(false); }
  };

  useEffect(() => { refresh(); }, [tunnel.network?.controlUrl]);

  const diagnose = async () => {
    setLoading(true); setError('');
    try {
      const result = await tunnel.runDiagnostics();
      setDiagnostic({ checkedAt: Date.now(), lines: result.lines.length, healthy: result.doctor?.ok === true && (result.node.health || []).length === 0 });
      notify('Diagnóstico atualizado', 'success');
    } catch (diagnosticError) { setError(tunnelErrorMessage(diagnosticError)); }
    finally { setLoading(false); }
  };

  const rename = async (deviceId, name) => {
    try { await tunnel.renameDevice(deviceId, name); notify('Dispositivo renomeado', 'success'); }
    catch (renameError) { setError(tunnelErrorMessage(renameError)); throw renameError; }
  };

  const revokeDevice = async (deviceId, networkToo) => {
    try { await tunnel.revokeDevice(deviceId, networkToo); notify('Acesso revogado', 'success'); }
    catch (revokeError) { setError(tunnelErrorMessage(revokeError)); throw revokeError; }
  };

  const node = tunnel.snapshot.node || {};
  const derp = useMemo(() => node.derp?.name || (node.derp?.regionId ? `Região ${node.derp.regionId}` : null), [node.derp]);
  const configured = networkIsConfigured(tunnel.network);
  const keyExpiry = Date.parse(tunnel.secretStatus?.expiresAt || '');
  const apiKeyValue = Number.isFinite(keyExpiry)
    ? `Válida até ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(keyExpiry))}`
    : tunnel.secretStatus?.prefix || (tunnel.secretStatus?.present ? 'Protegida' : 'Não encontrada');

  return <div className="view active page mac-devices" id="view-dispositivos">
    <ToolbarActions><button type="button" className="mac-tool mac-tool--label" onClick={() => window.dispatchEvent(new CustomEvent('cialai:pair-device'))}><Link2 aria-hidden="true" /><span>Vincular celular</span></button></ToolbarActions>
    <header className="mac-devices__head"><div><p className="mac-devices__eyebrow">Rede privada</p><h2>Dispositivos</h2><p>Gerencie os celulares que podem abrir este estúdio.</p></div><div className={`mac-network-badge is-${tunnel.status.tone}`}><span className={`mac-dot is-${tunnel.status.tone}`} aria-hidden="true" />{tunnel.status.label}</div></header>

    {!configured ? <DataState type="empty" message="A rede ainda não foi configurada." action={<button type="button" className="btn btn-primary" onClick={() => window.dispatchEvent(new CustomEvent('cialai:network-preferences'))}>Configurar Rede</button>} /> : <>
      <section className="mac-machine" aria-labelledby="machine-title"><div className="mac-machine__title"><span><Monitor aria-hidden="true" /></span><div><h3 id="machine-title">{tunnel.network.desktopName}</h3><p>Este computador na rede do Cialai</p></div></div><dl className="mac-machine__details"><Detail label="IP na rede" value={node.ip4} mono /><Detail label="Nome no Headscale" value={node.dnsName} mono /><Detail label="DERP em uso" value={derp ? `${derp}${node.derp?.latencyMs ? `  ${node.derp.latencyMs} ms` : ''}` : null} /><Detail label="Chave da API" value={apiKeyValue} /></dl><div className="mac-machine__actions"><button type="button" className="btn btn-secondary btn-sm" disabled={loading} onClick={diagnose}><Activity aria-hidden="true" />Executar diagnóstico</button><button type="button" className="btn btn-quiet btn-sm" disabled={loading} onClick={refresh}><RefreshCw aria-hidden="true" />Atualizar</button></div>{diagnostic ? <p className={`mac-machine__diagnostic${diagnostic.healthy ? ' is-ok' : ' is-warn'}`} role="status"><KeyRound aria-hidden="true" />{diagnostic.healthy ? 'Nó saudável' : 'O nó informou avisos'}<span>{diagnostic.lines} linhas recentes verificadas</span></p> : null}</section>

      <section className="mac-devices__list-section" aria-labelledby="paired-title"><div className="mac-devices__section-head"><div><h3 id="paired-title">Celulares vinculados</h3><p>{tunnel.devices.length} {tunnel.devices.length === 1 ? 'dispositivo autorizado' : 'dispositivos autorizados'}</p></div><button type="button" className="btn btn-primary btn-sm" onClick={() => window.dispatchEvent(new CustomEvent('cialai:pair-device'))}><Link2 aria-hidden="true" />Vincular celular</button></div>
        {loading && tunnel.devices.length === 0 ? <DataState type="loading" message="Carregando dispositivos…" /> : null}
        {!loading && tunnel.devices.length === 0 ? <DataState type="empty" message="Nenhum celular foi vinculado." action={<button type="button" className="btn btn-primary" onClick={() => window.dispatchEvent(new CustomEvent('cialai:pair-device'))}>Gerar código de pareamento</button>} /> : null}
        {tunnel.devices.length ? <ul className="mac-device-list">{tunnel.devices.map((device) => <DeviceRow key={device.id} device={device} onRename={rename} onRevoke={setRevoke} />)}</ul> : null}
      </section>
    </>}
    {error || tunnel.lastError ? <p className="mac-devices__error" role="alert">{error || tunnel.lastError}</p> : null}
    {revoke ? <RevokeDialog device={revoke} onClose={() => setRevoke(null)} onConfirm={revokeDevice} /> : null}
  </div>;
}
