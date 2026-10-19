// SPDX-License-Identifier: Apache-2.0
// Menu de acoes em popover, por portal, numa superficie solida. Serve ao
// menu de cada card de sessao e ao menu de contexto do explorador. Navegacao
// por teclado: setas, Enter e Esc. Fecha ao clicar fora ou ao rolar.
//
// Um item pode ser uma grade de amostras de cor, `{ swatches: [...] }`, ou
// de icones, `{ icons: [...] }`, com o mesmo desenho: cada celula continua
// sendo um item para o teclado. `{ heading }` e um titulo de secao e
// `{ node }` um bloco solto, nenhum dos dois focavel. Um item com
// `keepOpen` roda sem fechar o menu, para escolher cor e icone de uma vez.
// `style` e `className` deixam o menu de uma sessao herdar o tom dela.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { translate, useI18n } from '../../shared/i18n.js';

const SWATCH_COLUMNS = 6;

function flatten(items) {
  const flat = [];
  items.forEach((item) => {
    if (!item || item.separator || item.heading || item.node) return;
    if (item.swatches) item.swatches.forEach((option) => flat.push(option));
    else if (item.icons) item.icons.forEach((option) => flat.push({ ...option, cell: true }));
    else flat.push(item);
  });
  return flat;
}

export default function Menu({ anchor, items, onClose, label, style, className = '' }) {
  useI18n();
  const boxRef = useRef(null);
  const activated = useRef(false);
  const activate = (item) => {
    if (activated.current || !item || item.disabled) return;
    if (item.keepOpen) { item.run(); return; }
    activated.current = true;
    onClose(); item.run();
  };
  const [position, setPosition] = useState({ top: anchor?.y ?? 0, left: anchor?.x ?? 0, ready: false });
  const [index, setIndex] = useState(-1);
  const enabled = flatten(items);

  useLayoutEffect(() => {
    activated.current = false;
    const box = boxRef.current;
    if (!box || !anchor) return;
    const rect = box.getBoundingClientRect();
    const margin = 8;
    let left = anchor.x;
    let top = anchor.y;
    if (anchor.align === 'right') left = anchor.x - rect.width;
    if (left + rect.width > window.innerWidth - margin) left = window.innerWidth - margin - rect.width;
    if (top + rect.height > window.innerHeight - margin) top = Math.max(margin, anchor.y - rect.height - (anchor.flipOffset || 0));
    if (left < margin) left = margin;
    setPosition({ top, left, ready: true });
  }, [anchor]);

  useEffect(() => {
    const onDown = (event) => {
      if (boxRef.current && !boxRef.current.contains(event.target)) onClose();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((value) => moveIndex(enabled, value, 'down')); }
      if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((value) => moveIndex(enabled, value, 'up')); }
      if (event.key === 'ArrowRight') { event.preventDefault(); setIndex((value) => moveIndex(enabled, value, 'right')); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); setIndex((value) => moveIndex(enabled, value, 'left')); }
      if (event.key === 'Enter' && index >= 0) {
        event.preventDefault();
        const item = enabled[index];
        event.stopPropagation();
        activate(item);
      }
    };
    // Rolar com a roda fora do menu fecha; a rolagem programatica do terminal
    // em segundo plano nao conta, senao o menu sumiria sozinho.
    const onWheel = (event) => {
      if (boxRef.current && !boxRef.current.contains(event.target)) onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    document.addEventListener('wheel', onWheel, true);
    const timer = setTimeout(() => boxRef.current?.focus(), 10);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('wheel', onWheel, true);
    };
  }, [onClose, enabled, index]);

  let runningIndex = -1;
  return createPortal(
    <div
      ref={boxRef}
      className={`terminais-menu${className ? ` ${className}` : ''}`}
      role="menu"
      aria-label={label || translate('terminal.common.actions')}
      tabIndex={-1}
      style={{ ...style, top: position.top, left: position.left, visibility: position.ready ? 'visible' : 'hidden' }}
    >
      {items.map((item, order) => {
        if (!item) return null;
        if (item.separator) return <div key={`sep-${order}`} className="terminais-menu__sep" role="separator" />;
        if (item.heading) return <div key={`heading-${order}`} className="terminais-menu__heading" role="presentation">{item.heading}</div>;
        if (item.node) return <div key={item.id || `node-${order}`} role="presentation">{item.node}</div>;
        if (item.icons) {
          return (
            <div key={item.id || `icons-${order}`} className="terminais-menu__swatches terminais-menu__icons" role="group" aria-label={item.label || translate('terminal.common.icons')}>
              {item.icons.map((option) => {
                runningIndex += 1;
                const active = runningIndex === index;
                const { Icon } = option;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={Boolean(option.current)}
                    aria-label={option.label}
                    title={option.current ? `${option.label}, ${translate('terminal.common.current')}` : option.label}
                    className={`terminais-menu__iconbtn${active ? ' is-active' : ''}${option.current ? ' is-current' : ''}`}
                    onMouseEnter={() => setIndex(enabled.findIndex((entry) => entry.cell && entry.id === option.id))}
                    onClick={() => activate(option)}
                  >
                    <Icon size={15} strokeWidth={1.9} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          );
        }
        if (item.swatches) {
          return (
            <div key={item.id || `swatches-${order}`} className="terminais-menu__swatches" role="group" aria-label={item.label || translate('terminal.common.colors')}>
              {item.swatches.map((option) => {
                runningIndex += 1;
                const active = runningIndex === index;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={Boolean(option.current)}
                    aria-label={option.label}
                    title={option.current ? `${option.label}, ${translate('terminal.common.current')}` : option.label}
                    className={`terminais-menu__swatchbtn${active ? ' is-active' : ''}${option.current ? ' is-current' : ''}`}
                    style={{ '--swatch': option.color }}
                    onMouseEnter={() => setIndex(enabled.indexOf(option))}
                    onClick={() => activate(option)}
                  >
                    <i aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          );
        }
        runningIndex += 1;
        const active = runningIndex === index;
        const Icon = item.icon;
        return (
          <button
            key={item.id || item.label}
            type="button"
            role="menuitem"
            className={`terminais-menu__item${active ? ' is-active' : ''}${item.danger ? ' is-danger' : ''}`}
            disabled={item.disabled}
            onMouseEnter={() => setIndex(enabled.indexOf(item))}
            onClick={() => activate(item)}
          >
            {Icon ? <Icon size={14} strokeWidth={1.75} aria-hidden="true" /> : <span className="terminais-menu__spacer" />}
            <span className="terminais-menu__label">{item.label}</span>
            {item.hint ? <span className="terminais-menu__hint">{item.hint}</span> : null}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

// Proximo indice para uma seta. Numa celula de grade, de cor ou de icone,
// cima e baixo pulam uma linha enquanto houver grade naquela direcao;
// direita e esquerda andam uma casa. Fora da grade, direita e esquerda nao
// fazem nada.
function moveIndex(enabled, value, direction) {
  const current = Math.max(0, value);
  const item = enabled[current];
  const isSwatch = (entry) => Boolean(entry && (entry.color !== undefined || entry.cell));
  if (direction === 'right') return isSwatch(item) && isSwatch(enabled[current + 1]) ? current + 1 : current;
  if (direction === 'left') return isSwatch(item) && isSwatch(enabled[current - 1]) ? current - 1 : current;
  const delta = direction === 'down' ? 1 : -1;
  if (isSwatch(item)) {
    const jump = current + delta * SWATCH_COLUMNS;
    if (isSwatch(enabled[jump])) return jump;
    // Sair da grade: o primeiro item fora dela nessa direcao.
    let cursor = current;
    while (isSwatch(enabled[cursor + delta])) cursor += delta;
    return Math.min(enabled.length - 1, Math.max(0, cursor + delta));
  }
  if (value < 0) return 0;
  return Math.min(enabled.length - 1, Math.max(0, current + delta));
}

// Posicao do menu a partir de um elemento ancora, alinhado a direita dele.
export function anchorFromElement(element, { align = 'right' } = {}) {
  const rect = element.getBoundingClientRect();
  return { x: align === 'right' ? rect.right : rect.left, y: rect.bottom + 4, align, flipOffset: rect.height + 8 };
}

export function anchorFromEvent(event) {
  return { x: event.clientX, y: event.clientY, align: 'left', flipOffset: 0 };
}
