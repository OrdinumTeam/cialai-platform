// SPDX-License-Identifier: Apache-2.0
// Gesto dos botões da barra do terminal do celular. O toque curto executa a
// ação. Segurar mostra só o nome da função e, ao soltar, nada acontece: o
// click que o sistema ainda mandar é engolido. Com mouse o nome aparece com o
// cursor parado sobre o botão, e o clique executa normalmente.
//
// Sem DOM nem React: quem usa entrega `show(id, anchor)` e `hide()`, e os
// relógios podem ser trocados no teste.

export const HINT_HOLD_MS = 450;
export const HINT_HOVER_MS = 300;
// Distância mínima do balão até a borda da tela e até o botão.
export const HINT_EDGE = 8;
const HINT_GAP = 8;
const HINT_ARROW_INSET = 12;

// Posição do balão: centrado no botão, sem sair da tela pelos lados, e abaixo
// dele só quando não há espaço acima. `arrow` é o centro do botão medido a
// partir da borda esquerda do balão, onde fica a ponta.
export function placeHint(anchor, size, viewportWidth) {
  const center = anchor.left + anchor.width / 2;
  const widest = Math.max(HINT_EDGE, viewportWidth - size.width - HINT_EDGE);
  const left = Math.min(Math.max(HINT_EDGE, center - size.width / 2), widest);
  const above = anchor.top - size.height - HINT_GAP;
  const below = above < HINT_EDGE;
  const top = below ? anchor.bottom + HINT_GAP : above;
  const arrow = Math.min(Math.max(HINT_ARROW_INSET, center - left), Math.max(HINT_ARROW_INSET, size.width - HINT_ARROW_INSET));
  return { left, top, arrow, below };
}

// Os relógios do ambiente só são lidos no uso, para a barra renderizar também
// fora do navegador.
const defaultSchedule = (fn, ms) => globalThis.setTimeout(fn, ms);
const defaultCancel = (id) => globalThis.clearTimeout(id);

export function createHintGesture({ show, hide, schedule = defaultSchedule, cancel = defaultCancel }) {
  let timer = null;
  // Botão cujo toque longo mostrou o nome; o click dele não executa.
  let held = null;
  const clearTimer = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  const end = () => {
    clearTimer();
    hide();
  };
  const arm = (id, anchor, delay, longPress) => {
    clearTimer();
    timer = schedule(() => {
      timer = null;
      if (longPress) held = id;
      show(id, anchor);
    }, delay);
  };
  return {
    pointerDown(id, pointerType, anchor) {
      held = null;
      if (pointerType !== 'mouse') arm(id, anchor, HINT_HOLD_MS, true);
    },
    // O nome some quando o gesto termina: dedo solto, cancelado ou fora do botão.
    pointerUp(pointerType) {
      if (pointerType !== 'mouse') end();
    },
    pointerCancel: end,
    pointerLeave: end,
    pointerEnter(id, pointerType, anchor) {
      if (pointerType === 'mouse') arm(id, anchor, HINT_HOVER_MS, false);
    },
    // Verdadeiro quando o click deve executar a ação do botão.
    click(id) {
      const swallowed = held === id;
      held = null;
      end();
      return !swallowed;
    },
    dispose: clearTimer,
  };
}
