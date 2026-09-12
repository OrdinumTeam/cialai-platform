// SPDX-License-Identifier: Apache-2.0
// Movimento curto do estudio que precisa disparar de novo sem remontar o
// elemento, como a troca de sessao na area central e no explorador. So
// opacidade e deslocamento, que o compositor anima sem custar quadro ao
// terminal. Desligado com prefers-reduced-motion e com data-motion="none".

const EASE = 'cubic-bezier(.2,.7,.2,1)';

export function motionOff() {
  if (typeof window === 'undefined') return true;
  if (document.documentElement.dataset.motion === 'none') return true;
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

// Entrada rapida: surge de um deslocamento pequeno ate o lugar.
export function swapIn(element, { x = 0, y = 6, duration = 180 } = {}) {
  if (!element || motionOff() || typeof element.animate !== 'function') return;
  element.animate(
    [{ opacity: 0, transform: `translate(${x}px, ${y}px)` }, { opacity: 1, transform: 'none' }],
    { duration, easing: EASE, fill: 'none' },
  );
}
