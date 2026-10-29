// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useState } from 'react';
import { invoke, listen, isTauri } from '../lib/native.js';
import { translate as t } from './i18n.js';
import BrotoRequestPreview from './BrotoRequestPreview.jsx';

const COMMAND_KEYS = { exec: 'desktop.brotos.cmd.exec', 'pty.open': 'desktop.brotos.openTerminal', 'pty.write': 'desktop.brotos.cmd.write', 'pty.kill': 'desktop.brotos.cmd.kill', 'files.get': 'desktop.brotos.fileDownload', 'files.put': 'desktop.brotos.fileUpload' };

let selectedRequests = {};
const selectionListeners = new Set();
function selectRequest(deviceId, requestId) {
  selectedRequests = { ...selectedRequests, [deviceId]: requestId };
  selectionListeners.forEach(listener => listener(selectedRequests));
}
export function approvalQueues(requests, selections = {}) {
  const queues = new Map();
  for (const request of [...requests].sort((a, b) => a.id - b.id)) {
    if (!queues.has(request.deviceId)) queues.set(request.deviceId, []);
    queues.get(request.deviceId).push(request);
  }
  return [...queues].map(([deviceId, pending]) => {
    const index = Math.max(0, pending.findIndex(request => request.id === selections[deviceId]));
    return { deviceId, requests: pending, selected: pending[index], position: index + 1 };
  });
}
export function firstRequests(requests) {
  return approvalQueues(requests).map(queue => queue.selected);
}
export default function BrotoApprovals({ deviceId, allRequests = false }) {
  const [selections, setSelections] = useState(selectedRequests);
  useEffect(() => { selectionListeners.add(setSelections); return () => selectionListeners.delete(setSelections); }, []);
  const [requests, setRequests] = useState([]);
  const [devices, setDevices] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isTauri()) return undefined;
    let alive = true;
    let off;
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const [pending, list] = await Promise.all([invoke('broto_requests'), invoke('broto_list')]);
        if (alive && current === generation) { setRequests(pending || []); setDevices(list || []); setError(false); }
      } catch { if (alive && current === generation) setError(true); }
    };
    listen('tunnel://broto', event => { if (['broto.requests.changed', 'broto.grant.changed'].includes(event?.event)) refresh(); }).then(unlisten => { if (alive) { off = unlisten; refresh(); } else unlisten(); }).catch(() => { if (alive) setError(true); });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; off?.(); clearInterval(timer); };
  }, []);
  const act = async (cmd, args) => {
    setBusy(true); setError(false);
    try { await invoke(cmd, args); } catch { setError(true); } finally { setBusy(false); }
  };
  const queues = approvalQueues(requests, selections).filter(queue => !deviceId || queue.deviceId === deviceId);
  const selected = allRequests ? queues.flatMap(queue => queue.requests) : queues.map(queue => queue.selected);
  const grants = deviceId ? devices.filter(device => device.id === deviceId && Date.parse(device.approvalUntil) > now) : [];
  if (!selected.length && !grants.length && !error) return null;
  return <div className={`broto-approvals${allRequests ? ' broto-approvals--list' : ''}`} data-broto-requests={allRequests ? 'all' : deviceId || 'global'} aria-label={t('desktop.brotos.requests')} aria-live="polite" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    {allRequests && selected.length > 0 && <h4>{t('desktop.brotos.requests')}</h4>}
    {selected.map(request => <section className="broto-approval" data-request-id={request.id} data-broto-id={request.deviceId} key={request.id}>
      <strong>{t('desktop.brotos.requestBy', { name: devices.find(device => device.id === request.deviceId)?.name || request.deviceId })}</strong>
      <small>{t(COMMAND_KEYS[request.cmd] || 'desktop.brotos.cmd.exec')}</small>
      {!allRequests && queues.filter(queue => queue.deviceId === request.deviceId).map(queue => <nav className="broto-approval__queue" aria-label={t('desktop.brotos.queueNavigation')} key={queue.deviceId}>
        <span>{t('desktop.brotos.queuePosition', { position: queue.position, count: queue.requests.length })}</span>
        <button type="button" className="btn btn-quiet btn-sm" data-broto-queue-prev disabled={queue.position === 1} onClick={() => selectRequest(queue.deviceId, queue.requests[queue.position - 2].id)}>{t('desktop.brotos.previousRequest')}</button>
        <button type="button" className="btn btn-quiet btn-sm" data-broto-queue-next disabled={queue.position === queue.requests.length} onClick={() => selectRequest(queue.deviceId, queue.requests[queue.position].id)}>{t('desktop.brotos.nextRequest')}</button>
      </nav>)}
      <BrotoRequestPreview request={request} />
      <div className="broto-row-actions">
        <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => act('broto_decide', { id: request.id, approve: false })}>{t('desktop.brotos.deny')}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('broto_decide', { id: request.id, approve: true })}>{t('desktop.brotos.approve')}</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act('broto_grant', { deviceId: request.deviceId, end: false })}>{t('desktop.brotos.grant')}</button>
      </div>
    </section>)}
    {grants.map(device => <div className="broto-approval" key={device.id}><span>{t('desktop.brotos.granted', { minutes: Math.min(15, Math.ceil((Date.parse(device.approvalUntil) - now) / 60000)) })}</span><button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => act('broto_grant', { deviceId: device.id, end: true })}>{t('desktop.brotos.endGrant')}</button></div>)}
    {error && <p role="alert">{t('desktop.brotos.error')}</p>}
  </div>;
}
