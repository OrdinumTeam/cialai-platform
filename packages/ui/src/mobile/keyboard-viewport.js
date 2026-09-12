// SPDX-License-Identifier: Apache-2.0
// Teclado virtual no iPhone. O WebKit nao encolhe a pagina quando o teclado
// abre: 100dvh continua sendo a tela inteira e so o visualViewport diminui.
// No terminal isso escondia o prompt e a fileira de teclas atras do teclado.
// Enquanto o teclado esta aberto a casca acompanha o visualViewport: altura
// e deslocamento viram variaveis CSS na .ios-shell.
//
// A conta e pura e testavel em Node; o hook so liga os eventos.
import { useEffect, useState } from 'react';

// Encolhimento minimo, em px, para tratar como teclado e nao como barra do
// navegador ou arredondamento.
export const KEYBOARD_MIN_PX = 80;

// Caixa visivel com o teclado aberto, ou null com ele fechado. Com zoom por
// pincar o visualViewport tambem encolhe; nesse caso nada muda.
export function keyboardBox(viewport, innerHeight) {
  if (!viewport || !Number.isFinite(viewport.height) || !Number.isFinite(innerHeight)) return null;
  if ((viewport.scale ?? 1) > 1.01) return null;
  if (innerHeight - viewport.height < KEYBOARD_MIN_PX) return null;
  return { top: Math.max(0, Math.round(viewport.offsetTop || 0)), height: Math.round(viewport.height) };
}

export function sameBox(a, b) {
  if (a === b) return true;
  return Boolean(a && b) && a.top === b.top && a.height === b.height;
}

export function useKeyboardBox(active) {
  const [box, setBox] = useState(null);
  useEffect(() => {
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!active || !viewport) { setBox(null); return undefined; }
    const update = () => setBox((current) => {
      const next = keyboardBox(viewport, window.innerHeight);
      return sameBox(current, next) ? current : next;
    });
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update); };
  }, [active]);
  return box;
}
