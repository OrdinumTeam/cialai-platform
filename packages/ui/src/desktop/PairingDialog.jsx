// SPDX-License-Identifier: Apache-2.0
// Rotating, one-use pairing QR with optional four-digit approval.
// O QR aparece assim que `pair.begin` responde e já leva o endereço onion; a
// linha da reserva mostra quando o celular de outra rede consegue chegar.

import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Info, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react';
import { AppModal } from '../components/ui.jsx';
import { useTunnel, tunnelErrorMessage } from './TunnelContext.jsx';
import { DirectValue, ReserveValue } from './AccessPanel.jsx';
import { PAIR_ROTATION_SECONDS, directReady, formatPairTime, pairClock, reserveStatus } from './tunnel-model.js';
import { translate } from './i18n.js';

const rotationOf = (pair) => Math.max(1, Number(pair?.rotateAfterSeconds) || PAIR_ROTATION_SECONDS);

export default function PairingDialog({ open, onClose, onDevices }) {
  const tunnel = useTunnel();
  const canvasRef = useRef(null);
  const activePairRef = useRef(null);
  const rotationTimerRef = useRef(null);
  const [pair, setPair] = useState(null);
  const [startedAt, setStartedAt] = useState(0);
  const [clock, setClock] = useState({ rotationSeconds: PAIR_ROTATION_SECONDS, expirySeconds: 0 });
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');
  const ready = directReady(tunnel.snapshot);

  useEffect(() => {
    if (!pair?.payload || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, pair.payload, {
      width: 280,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#241321', light: '#ffffff' },
    }).catch((renderError) => { setError(tunnelErrorMessage(renderError)); setState('error'); });
  }, [pair?.payload]);

  useEffect(() => {
    if (!open || !pair || !startedAt) return undefined;
    const update = () => setClock(pairClock(startedAt, pair.expiresAt, Date.now(), rotationOf(pair)));
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [open, pair, startedAt]);

  const show = (next) => {
    activePairRef.current = next;
    const now = Date.now();
    setPair(next); setStartedAt(now); setClock(pairClock(now, next.expiresAt, now, rotationOf(next))); setState('ready');
  };

  // Só pede o QR quando o ouvinte direto existe; antes disso `pair.begin`
  // responde `net_not_ready` e o diálogo espera o evento `net.state`.
  useEffect(() => {
    if (!open || !ready) return undefined;
    let active = true;
    const rotate = async () => {
      clearTimeout(rotationTimerRef.current);
      setState('loading'); setError('');
      const previous = activePairRef.current;
      if (previous) {
        try { await tunnel.cancelPair(previous.pairId); } catch (_error) { /* the prior key may already be consumed */ }
      }
      try {
        const next = await tunnel.beginPair();
        if (!active) { await tunnel.cancelPair(next.pairId); return; }
        show(next);
        rotationTimerRef.current = setTimeout(rotate, rotationOf(next) * 1000);
      } catch (pairError) {
        if (active) { setError(tunnelErrorMessage(pairError)); setState('error'); }
      }
    };
    rotate();
    return () => {
      active = false;
      clearTimeout(rotationTimerRef.current);
      const current = activePairRef.current;
      activePairRef.current = null;
      if (current) tunnel.cancelPair(current.pairId).catch(() => {});
      tunnel.clearPairEvent();
      setPair(null); setState('idle'); setError('');
    };
  }, [open, ready, tunnel.beginPair, tunnel.cancelPair, tunnel.clearPairEvent]);

  const event = tunnel.pairEvent;
  const matchingEvent = event?.data?.pairId && event.data.pairId === pair?.pairId ? event : null;
  const approval = matchingEvent?.event === 'pair.requested' ? matchingEvent.data : null;
  const completed = matchingEvent?.event === 'pair.completed' ? matchingEvent.data?.device : null;
  const failed = matchingEvent?.event === 'pair.failed' ? matchingEvent.data : null;

  const retry = async () => {
    const previous = activePairRef.current;
    setState('loading'); setError('');
    try {
      if (previous) await tunnel.cancelPair(previous.pairId);
      const next = await tunnel.beginPair();
      show(next);
      clearTimeout(rotationTimerRef.current);
      rotationTimerRef.current = setTimeout(() => retry(), rotationOf(next) * 1000);
    } catch (pairError) { setError(tunnelErrorMessage(pairError)); setState('error'); }
  };

  const decide = async (approved) => {
    setState('loading'); setError('');
    try { await tunnel.decidePair(pair.pairId, approved); setState('ready'); }
    catch (decisionError) { setError(tunnelErrorMessage(decisionError)); setState('error'); }
  };

  const tor = tunnel.snapshot.tor || tunnel.snapshot.net?.tor || pair?.reserve || null;
  const reserveReady = reserveStatus(tor).state === 'ready';

  const content = completed ? <div className="mac-pair__success"><span><Check aria-hidden="true" /></span><p className="mac-pair__eyebrow">{translate('desktop.pair.completed')}</p><h3>{translate('desktop.pair.linked', { name: completed.name })}</h3><p>{translate('desktop.pair.completedDescription')}</p><button type="button" className="btn btn-primary" onClick={() => { onClose(); onDevices?.(); }}>{translate('desktop.pair.openDevices')}</button></div>
    : <div className="mac-pair">
      <div className="mac-pair__copy">
        <span className="mac-pair__device"><Smartphone aria-hidden="true" /></span>
        <p className="mac-pair__eyebrow">{tunnel.desktopName}</p>
        <h3>{translate('desktop.action.pairPhone')}</h3>
        <p>{translate('desktop.pair.instructions')}</p>
        <dl className="mac-pair__reserve">
          <div><dt>{translate('desktop.access.direct')}</dt><dd><DirectValue snapshot={tunnel.snapshot} /></dd></div>
          <div><dt>{translate('desktop.access.reserve')}</dt><dd><ReserveValue tor={tor} /></dd></div>
        </dl>
        {reserveReady ? null : <p className="mac-pair__notice"><Info aria-hidden="true" /><span>{translate('desktop.pair.reserveNotice')}</span></p>}
      </div>
      <div className="mac-pair__visual">
        <div className={`mac-pair__qr${state === 'loading' ? ' is-loading' : ''}`} style={{ '--pair-progress': `${Math.max(0, Math.min(1, clock.rotationSeconds / rotationOf(pair))) * 360}deg` }}>
          {pair?.payload ? <canvas ref={canvasRef} width="280" height="280" aria-label={translate('desktop.pair.qrLabel')} /> : <div className="mac-pair__qr-placeholder" role="status">{ready ? translate('desktop.pair.generating') : translate('desktop.pair.waitingNetwork')}</div>}
        </div>
        <div className="mac-pair__timers"><div><span>{translate('desktop.pair.newCodeIn')}</span><strong>{formatPairTime(clock.rotationSeconds)}</strong></div><div><span>{translate('desktop.pair.remaining')}</span><strong>{formatPairTime(clock.expirySeconds)}</strong></div></div>
        {approval ? <div className="mac-pair__approval"><div><ShieldCheck aria-hidden="true" /><span><strong>{approval.device?.name || translate('desktop.pair.newPhone')}</strong><small>{translate('desktop.pair.confirmCode')}</small></span></div><output aria-label={translate('desktop.pair.approvalCode')}>{approval.code}</output><div className="mac-pair__approval-actions"><button type="button" className="btn btn-quiet" onClick={() => decide(false)}>{translate('desktop.pair.deny')}</button><button type="button" className="btn btn-primary" onClick={() => decide(true)}>{translate('desktop.pair.authorize')}</button></div></div> : null}
        {failed ? <p className="mac-pair__error" role="alert">{translate('desktop.pair.failed')}</p> : null}
        {error ? <p className="mac-pair__error" role="alert">{error}</p> : null}
        {(state === 'error' || failed) ? <button type="button" className="btn btn-secondary" onClick={retry}><RefreshCw aria-hidden="true" />{translate('desktop.pair.generateAnother')}</button> : null}
      </div>
    </div>;

  return <AppModal open={open} title={translate('desktop.action.pairPhone')} onClose={onClose} maxWidth="md">{content}</AppModal>;
}
