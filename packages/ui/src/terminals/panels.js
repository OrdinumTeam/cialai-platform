// SPDX-License-Identifier: Apache-2.0
// Recolhimento das colunas laterais do estudio. Abaixo destas larguras a
// coluna recolhe sozinha, sem mexer na preferencia do usuario, e volta quando
// a janela cresce. Pedir para mostrar a coluna vence o recolhimento automatico
// ate a largura cruzar o limite outra vez; antes disso o botao e o atalho nao
// faziam nada em telas de 1024 px.

export const AUTO_COLLAPSE = { explorer: 980, sessions: 720 };

const PANELS = Object.keys(AUTO_COLLAPSE);

export const INITIAL_PANELS = Object.freeze({
  sessions: false,
  explorer: false,
  shown: Object.freeze({ sessions: false, explorer: false }),
});

export function resizePanels(current, width) {
  const flipped = PANELS.filter((panel) => (width < AUTO_COLLAPSE[panel]) !== current[panel]);
  if (!flipped.length) return current;
  const next = { ...current, shown: { ...current.shown } };
  for (const panel of flipped) {
    next[panel] = width < AUTO_COLLAPSE[panel];
    next.shown[panel] = false;
  }
  return next;
}

export function choosePanel(current, panel, visible) {
  if (current.shown[panel] === visible) return current;
  return { ...current, shown: { ...current.shown, [panel]: visible } };
}

export function panelCollapsed(current, panel, { preferred, focus }) {
  return Boolean(preferred || focus || (current[panel] && !current.shown[panel]));
}
