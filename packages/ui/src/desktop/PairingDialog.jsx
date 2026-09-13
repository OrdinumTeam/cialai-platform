// SPDX-License-Identifier: Apache-2.0
// Rotating, one-use pairing QR with optional four-digit approval.

import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Link2, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react';
import { AppModal } from '../components/ui.jsx';
import { useTunnel, tunnelErrorMessage } from './TunnelContext.jsx';
import { PAIR_ROTATION_SECONDS, formatPairTime, networkIsConfigured, pairClock } from './tunnel-model.js';

export default function PairingDialog({ open, onClose, onDevices, onConfigure }) {
  const tunnel = useTunnel();
  const canvasRef = useRef(null);
  const activePairRef = useRef(null);
  const rotationTimerRef = useRef(null);
  const [pair, setPair] = useState(null);
  const [startedAt, setStartedAt] = useState(0);
  const [clock, setClock] = useState({ rotationSeconds: PAIR_ROTATION_SECONDS, expirySeconds: 0 });
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');

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
    const update = () => setClock(pairClock(startedAt, pair.expiresAt));
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [open, pair, startedAt]);

  useEffect(() => {
    if (!open) return undefined;
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
        activePairRef.current = next;
        const now = Date.now();
        setPair(next); setStartedAt(now); setClock(pairClock(now, next.expiresAt, now)); setState('ready');
        rotationTimerRef.current = setTimeout(rotate, PAIR_ROTATION_SECONDS * 1000);
      } catch (pairError) {
        if (active) { setError(tunnelErrorMessage(pairError)); setState('error'); }
      }
    };
    if (networkIsConfigured(tunnel.network)) rotate();
    return () => {
      active = false;
      clearTimeout(rotationTimerRef.current);
      const current = activePairRef.current;
      activePairRef.current = null;
      if (current) tunnel.cancelPair(current.pairId).catch(() => {});
      tunnel.clearPairEvent();
      setPair(null); setState('idle'); setError('');
    };
  }, [open, tunnel.beginPair, tunnel.cancelPair, tunnel.clearPairEvent, tunnel.network]);

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
      activePairRef.current = next;
      const now = Date.now();
      setPair(next); setStartedAt(now); setState('ready');
      clearTimeout(rotationTimerRef.current);
      rotationTimerRef.current = setTimeout(() => retry(), PAIR_ROTATION_SECONDS * 1000);
    } catch (pairError) { setError(tunnelErrorMessage(pairError)); setState('error'); }
  };

  const decide = async (approved) => {
    setState('loading'); setError('');
    try { await tunnel.decidePair(pair.pairId, approved); setState('ready'); }
    catch (decisionError) { setError(tunnelErrorMessage(decisionError)); setState('error'); }
  };

  const content = !networkIsConfigured(tunnel.network) ? <div className="mac-pair__empty"><span><Link2 aria-hidden="true" /></span><h3>Configure a rede primeiro</h3><p>Conecte este computador ao Headscale antes de gerar o código.</p><button type="button" className="btn btn-primary" onClick={() => { onClose(); onConfigure?.(); }}>Abrir Preferências de Rede</button></div>
    : completed ? <div className="mac-pair__success"><span><Check aria-hidden="true" /></span><p className="mac-pair__eyebrow">Pareamento concluído</p><h3>Vinculado: {completed.name}</h3><p>O dispositivo já pode abrir este estúdio pela rede privada.</p><button type="button" className="btn btn-primary" onClick={() => { onClose(); onDevices?.(); }}>Abrir Dispositivos</button></div>
      : <div className="mac-pair">
        <div className="mac-pair__copy"><span className="mac-pair__device"><Smartphone aria-hidden="true" /></span><p className="mac-pair__eyebrow">{tunnel.network?.desktopName}</p><h3>Vincular um celular</h3><p>Abra o Cialai no celular e leia este código.</p><div className="mac-pair__state"><span className={`mac-dot is-${tunnel.status.tone}`} aria-hidden="true" /><span>{tunnel.status.label}</span></div></div>
        <div className="mac-pair__visual">
          <div className={`mac-pair__qr${state === 'loading' ? ' is-loading' : ''}`} style={{ '--pair-progress': `${Math.max(0, Math.min(1, clock.rotationSeconds / PAIR_ROTATION_SECONDS)) * 360}deg` }}>
            {pair?.payload ? <canvas ref={canvasRef} width="280" height="280" aria-label="Código QR de pareamento" /> : <div className="mac-pair__qr-placeholder" role="status">Gerando código…</div>}
          </div>
          <div className="mac-pair__timers"><div><span>Novo código em</span><strong>{formatPairTime(clock.rotationSeconds)}</strong></div><div><span>Validade restante</span><strong>{formatPairTime(clock.expirySeconds)}</strong></div></div>
          {approval ? <div className="mac-pair__approval"><div><ShieldCheck aria-hidden="true" /><span><strong>{approval.device?.name || 'Novo celular'}</strong><small>Confirme o mesmo código no celular</small></span></div><output aria-label="Código de aprovação">{approval.code}</output><div className="mac-pair__approval-actions"><button type="button" className="btn btn-quiet" onClick={() => decide(false)}>Recusar</button><button type="button" className="btn btn-primary" onClick={() => decide(true)}>Autorizar</button></div></div> : null}
          {failed ? <p className="mac-pair__error" role="alert">O celular não concluiu o pareamento. Gere um novo código.</p> : null}
          {error ? <p className="mac-pair__error" role="alert">{error}</p> : null}
          {(state === 'error' || failed) ? <button type="button" className="btn btn-secondary" onClick={retry}><RefreshCw aria-hidden="true" />Gerar outro código</button> : null}
        </div>
      </div>;

  return <AppModal open={open} title="Vincular celular" onClose={onClose} maxWidth="md">{content}</AppModal>;
}
