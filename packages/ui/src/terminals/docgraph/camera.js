// SPDX-License-Identifier: Apache-2.0
// Câmera 2D do grafo da documentação: pan com inércia, zoom exponencial no
// cursor e voo animado. O transform é aplicado imperativamente, fora do ciclo
// do React, para manter 60 fps; o React só recebe mudanças de faixa de zoom.
//
// Veio do mapa do Ordinum Control, de onde o estúdio foi extraído, e aqui
// serve a um canvas: `worldRef` vazio e `onFrame` pedindo o redesenho. Três
// opções existem para ele: `initialView` devolve a visão salva e troca o
// `fitAll(0)` da montagem, `instant` diz quando um voo deve valer na hora, sem
// quadro de animação, e `scaleRange` troca os limites de escala. Com `instant`
// presente, um voo de duração zero também vale na hora: fora da tela o
// WKWebView não entrega quadros, e a visão nunca seria aplicada.

import { useEffect, useMemo, useRef, useState } from 'react';

const EASE = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function lodBucket(s) {
  if (s < 0.30) return 'far';
  if (s < 0.72) return 'mid';
  return 'near';
}

export function useCamera({ containerRef, worldRef, world, onFrame, initialView = null, instant = null, scaleRange = null }) {
  const view = useRef({ x: 0, y: 0, s: 0.28 });
  const velocity = useRef({ x: 0, y: 0 });
  const drag = useRef(null);
  const flight = useRef(null);
  const raf = useRef(0);
  const frameCb = useRef(onFrame);
  frameCb.current = onFrame;
  const initialRef = useRef(initialView);
  initialRef.current = initialView;
  const instantRef = useRef(instant);
  instantRef.current = instant;
  const minScale = scaleRange ? scaleRange[0] : 0.09;
  const maxScale = scaleRange ? scaleRange[1] : 3.2;
  const [lod, setLod] = useState('far');
  const [zoomPct, setZoomPct] = useState(28);
  const lodRef = useRef('far');
  const pctTimer = useRef(0);

  const api = useMemo(() => {
    const apply = () => {
      const v = view.current;
      if (worldRef.current) {
        worldRef.current.setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.s})`);
      }
      const bucket = lodBucket(v.s);
      if (bucket !== lodRef.current) {
        lodRef.current = bucket;
        setLod(bucket);
      }
      const now = performance.now();
      if (now - pctTimer.current > 120) {
        pctTimer.current = now;
        setZoomPct(Math.round(v.s * 100));
      }
      frameCb.current?.(v);
    };

    const bounds = () => containerRef.current?.getBoundingClientRect() || { width: 1200, height: 700, left: 0, top: 0 };

    const clampScale = (s) => Math.min(maxScale, Math.max(minScale, s));

    // Visão com número inválido nunca entra: cada campo ruim mantém o atual.
    const sanitize = (target) => {
      const v = view.current;
      const pick = (value, fallback) => (Number.isFinite(value) ? value : fallback);
      return { x: pick(target?.x, v.x), y: pick(target?.y, v.y), s: clampScale(pick(target?.s, v.s)) };
    };

    const setView = (target) => {
      flight.current = null;
      velocity.current = { x: 0, y: 0 };
      view.current = sanitize(target);
      apply();
    };

    const tick = () => {
      raf.current = 0;
      let active = false;
      if (flight.current) {
        const f = flight.current;
        const t = Math.min(1, (performance.now() - f.start) / f.duration);
        const k = EASE(t);
        view.current = {
          x: f.from.x + (f.to.x - f.from.x) * k,
          y: f.from.y + (f.to.y - f.from.y) * k,
          s: f.from.s + (f.to.s - f.from.s) * k,
        };
        if (t >= 1) flight.current = null; else active = true;
      } else if (!drag.current && instantRef.current?.()) {
        velocity.current = { x: 0, y: 0 };
      } else if (!drag.current && (Math.abs(velocity.current.x) > 0.4 || Math.abs(velocity.current.y) > 0.4)) {
        view.current.x += velocity.current.x;
        view.current.y += velocity.current.y;
        velocity.current.x *= 0.92;
        velocity.current.y *= 0.92;
        active = true;
      }
      apply();
      if (active) schedule();
    };

    const schedule = () => {
      if (!raf.current) raf.current = requestAnimationFrame(tick);
    };

    const flyTo = (target, duration = 700) => {
      if (instantRef.current && (instantRef.current() || !(duration > 0))) { setView(target); return; }
      flight.current = { from: { ...view.current }, to: target, start: performance.now(), duration };
      velocity.current = { x: 0, y: 0 };
      schedule();
    };

    const fitRect = (rect, padding = 90, duration = 700) => {
      const b = bounds();
      const s = clampScale(Math.min(
        (b.width - padding * 2) / rect.w,
        (b.height - padding * 2) / rect.h,
      ));
      flyTo({
        s,
        x: (b.width - rect.w * s) / 2 - rect.x * s,
        y: (b.height - rect.h * s) / 2 - rect.y * s,
      }, duration);
    };

    // Zoom na hora em volta de um ponto da tela: a roda e a pinça.
    const zoomAt = (factor, clientX, clientY) => {
      flight.current = null;
      const b = bounds();
      const mx = clientX - b.left;
      const my = clientY - b.top;
      const v = view.current;
      const s = clampScale(v.s * factor);
      view.current = { s, x: mx - ((mx - v.x) * s) / v.s, y: my - ((my - v.y) * s) / v.s };
      apply();
    };

    return {
      getView: () => view.current,
      setView,
      zoomAt,
      screenToWorld: (sx, sy) => {
        const v = view.current;
        return { x: (sx - v.x) / v.s, y: (sy - v.y) / v.s };
      },
      flyTo,
      fitRect,
      fitAll: (duration = 700) => fitRect({ x: 0, y: 0, w: world.w, h: world.h }, 60, duration),
      centerWorld: (wx, wy, duration = 500) => {
        const b = bounds();
        const v = view.current;
        flyTo({ s: v.s, x: b.width / 2 - wx * v.s, y: b.height / 2 - wy * v.s }, duration);
      },
      zoomBy: (factor) => {
        const b = bounds();
        const v = view.current;
        const s = clampScale(v.s * factor);
        const mx = b.width / 2;
        const my = b.height / 2;
        flyTo({ s, x: mx - ((mx - v.x) * s) / v.s, y: my - ((my - v.y) * s) / v.s }, 320);
      },
      handlers: {
        onWheel: (event) => {
          event.preventDefault();
          zoomAt(Math.exp(-event.deltaY * 0.0016), event.clientX, event.clientY);
        },
        onPointerDown: (event) => {
          if (event.button !== 0) return;
          flight.current = null;
          drag.current = { x: event.clientX, y: event.clientY, moved: false };
          velocity.current = { x: 0, y: 0 };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        },
        onPointerMove: (event) => {
          if (!drag.current) return;
          const dx = event.clientX - drag.current.x;
          const dy = event.clientY - drag.current.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
          drag.current.x = event.clientX;
          drag.current.y = event.clientY;
          view.current.x += dx;
          view.current.y += dy;
          velocity.current = { x: dx, y: dy };
          apply();
        },
        onPointerUp: () => {
          const moved = drag.current?.moved;
          drag.current = null;
          schedule();
          return moved;
        },
        onDoubleClick: (event) => {
          const b = bounds();
          const mx = event.clientX - b.left;
          const my = event.clientY - b.top;
          const v = view.current;
          const s = clampScale(v.s * 1.9);
          flyTo({ s, x: mx - ((mx - v.x) * s) / v.s, y: my - ((my - v.y) * s) / v.s }, 420);
        },
      },
      _apply: apply,
    };
  }, [containerRef, worldRef, world.w, world.h, minScale, maxScale]);

  useEffect(() => {
    if (initialRef.current) {
      const saved = initialRef.current();
      if (saved) api.setView(saved);
    } else {
      api.fitAll(0);
    }
    api._apply();
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [api]);

  return { camera: api, lod, zoomPct };
}
