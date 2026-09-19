// SPDX-License-Identifier: Apache-2.0
// Área visível da página no iPhone. O WebKit não encolhe a página quando o
// teclado abre: 100dvh continua sendo a tela inteira e só o visualViewport
// diminui. No terminal isso escondia o prompt e a fileira de teclas atrás do
// teclado.
//
// A casca acompanha o visualViewport o tempo todo, e não só enquanto o
// teclado está aberto. Antes a altura era escrita apenas quando o
// encolhimento passava de um limiar, e apagada quando ele voltava a caber:
// bastava o último `resize` do fechamento não chegar, o que acontece ao
// recolher o teclado pelo botão nativo de concluir e ao voltar do segundo
// plano, para a casca ficar presa na altura do teclado. Sobrava uma faixa
// cinza embaixo, e o terminal e a lista de sessões continuavam pela metade.
//
// Agora `box.height` é sempre a altura visível de agora. Uma medida atrasada
// só atrasa a correção; nenhuma medida deixa a casca em um tamanho que não
// existe mais. `box.keyboard` continua dizendo se o teclado está aberto, que
// é outra pergunta: é ela que esconde a barra de abas e sobe o compositor.
//
// A conta é pura e testável em Node; o hook só liga os eventos.
import { useEffect, useState } from 'react';

// Encolhimento mínimo, em px, para tratar como teclado e não como barra do
// navegador ou arredondamento.
export const KEYBOARD_MIN_PX = 80;

// Caixa visível de agora. `null` quando não dá para medir, e aí a folha cai
// em 100dvh. Com zoom por pinçar o visualViewport também encolhe, e nesse
// caso a medida não vale: a página inteira continua valendo.
export function viewportBox(viewport, innerHeight) {
  if (!viewport || !Number.isFinite(viewport.height) || !Number.isFinite(innerHeight)) return null;
  if (viewport.height <= 0 || innerHeight <= 0) return null;
  if ((viewport.scale ?? 1) > 1.01) return null;
  const height = Math.round(Math.min(viewport.height, innerHeight));
  return {
    top: Math.max(0, Math.round(viewport.offsetTop || 0)),
    height,
    keyboard: innerHeight - viewport.height >= KEYBOARD_MIN_PX,
  };
}

// Compatibilidade com quem só quer saber do teclado: `null` com ele fechado.
export function keyboardBox(viewport, innerHeight) {
  const box = viewportBox(viewport, innerHeight);
  return box?.keyboard ? { top: box.top, height: box.height } : null;
}

export function sameBox(a, b) {
  if (a === b) return true;
  return Boolean(a && b) && a.top === b.top && a.height === b.height && a.keyboard === b.keyboard;
}

export function useViewportBox(active) {
  const [box, setBox] = useState(null);
  useEffect(() => {
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!active || !viewport) { setBox(null); return undefined; }
    const update = () => setBox((current) => {
      const next = viewportBox(viewport, window.innerHeight);
      return sameBox(current, next) ? current : next;
    });
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    // O `resize` do visualViewport é a fonte principal, mas não é a única
    // hora em que a área visível muda, e nem sempre o último passo da
    // animação do teclado chega. Cada um destes eventos só manda medir de
    // novo: nenhum deles adivinha altura nem espera um prazo.
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    window.addEventListener('pageshow', update);
    window.addEventListener('focusin', update);
    window.addEventListener('focusout', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      window.removeEventListener('pageshow', update);
      window.removeEventListener('focusin', update);
      window.removeEventListener('focusout', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [active]);
  return box;
}
