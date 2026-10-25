// SPDX-License-Identifier: Apache-2.0
// Lógica pura da seleção múltipla do explorador, separada dos efeitos. A ordem
// é a lista achatada de caminhos visíveis, na sequência em que aparecem na
// árvore. Mantém a decisão do clique igual à do explorador do VS Code.

// Caminhos entre a âncora e o alvo, inclusivos, na ordem da árvore. Sem âncora,
// vale só o alvo.
export function rangeBetween(order, anchor, target) {
  if (!target) return [];
  if (!anchor) return [target];
  const a = order.indexOf(anchor);
  const b = order.indexOf(target);
  if (a === -1 || b === -1) return [target];
  const [start, end] = a <= b ? [a, b] : [b, a];
  return order.slice(start, end + 1);
}

// Próxima seleção a partir de um clique. Mod alterna um item e não abre, Shift
// estende a faixa desde a âncora e não abre, clique simples seleciona só um e
// abre. Devolve a nova seleção, a âncora e se o clique deve abrir a entrada.
export function clickSelection(current, order, path, { meta = false, shift = false, anchor = null } = {}) {
  if (meta) {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return { selection: next, anchor: path, open: false };
  }
  if (shift) {
    const base = anchor || path;
    return { selection: new Set(rangeBetween(order, base, path)), anchor: base, open: false };
  }
  return { selection: new Set([path]), anchor: path, open: true };
}

// Os caminhos a operar quando uma ação parte de uma entrada: a seleção inteira
// quando a entrada faz parte de uma seleção múltipla, só a entrada caso
// contrário. Preserva a ordem da árvore.
export function actionPaths(order, selection, path) {
  if (selection && selection.size > 1 && selection.has(path)) {
    return order.filter((item) => selection.has(item));
  }
  return [path];
}
