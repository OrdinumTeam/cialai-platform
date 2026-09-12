// SPDX-License-Identifier: Apache-2.0
// Divisor arrastavel entre paineis. Vertical separa colunas e reporta a
// nova largura; horizontal separa editor e terminal e reporta a proporcao.
// Duplo clique volta ao padrao. Acessivel por teclado com as setas.

import React, { useCallback, useRef } from 'react';

export default function Splitter({ orientation = 'vertical', onDrag, onReset, onStep, label }) {
  const dragging = useRef(null);

  const onPointerDown = useCallback((event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    dragging.current = { startX: event.clientX, startY: event.clientY };
    target.setPointerCapture(event.pointerId);
    document.body.classList.add(orientation === 'vertical' ? 'is-col-resizing' : 'is-row-resizing');
    const move = (moveEvent) => {
      if (!dragging.current) return;
      onDrag(orientation === 'vertical' ? moveEvent.clientX - dragging.current.startX : moveEvent.clientY - dragging.current.startY, moveEvent);
    };
    const up = (upEvent) => {
      dragging.current = null;
      try { target.releasePointerCapture(upEvent.pointerId); } catch (_error) { /* ja solto */ }
      document.body.classList.remove('is-col-resizing', 'is-row-resizing');
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      onDrag(null, upEvent);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }, [onDrag, orientation]);

  const onKeyDown = (event) => {
    if (!onStep) return;
    const vertical = orientation === 'vertical';
    if ((vertical && event.key === 'ArrowLeft') || (!vertical && event.key === 'ArrowUp')) { event.preventDefault(); onStep(-16); }
    if ((vertical && event.key === 'ArrowRight') || (!vertical && event.key === 'ArrowDown')) { event.preventDefault(); onStep(16); }
    if (event.key === 'Enter' && onReset) { event.preventDefault(); onReset(); }
  };

  return (
    <div
      className={`terminais-splitter terminais-splitter--${orientation}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    >
      <span className="terminais-splitter__grip" aria-hidden="true" />
    </div>
  );
}
