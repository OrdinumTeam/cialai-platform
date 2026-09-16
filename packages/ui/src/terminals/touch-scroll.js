// SPDX-License-Identifier: Apache-2.0
// Rolagem por toque do terminal. O xterm 6 trocou o viewport pelo scrollable
// do VS Code e deixou de tratar touchstart e touchmove: no celular a tela nao
// sobe para ler o que passou. Este controlador converte o arrasto vertical em
// linhas do proprio xterm. No buffer alternativo, sem historico, o arrasto
// vira roda do mouse para o programa que acompanha o mouse e nada para os
// outros: setas, que a roda do desktop manda, num agente recuperam o
// historico de comandos em vez de rolar. Uma inercia curta percorre o
// historico longo sem varias passadas de dedo.
//
// Sem DOM aqui: quem liga aos eventos injeta medida de linha, rolagem, relato
// de roda e o agendador de quadros, o que deixa a conta testavel em Node.

// Velocidade em px/ms a partir da qual soltar o dedo continua rolando.
export const FLING_MIN_SPEED = 0.25;
// Velocidade em px/ms em que a inercia para.
export const FLING_STOP_SPEED = 0.02;
// Teto de velocidade: evita saltos de centenas de linhas num arrasto brusco.
export const FLING_MAX_SPEED = 6;
// Fator de atrito por quadro de 16 ms, proximo ao do UIScrollView.
export const FLING_FRICTION = 0.97;
// Pausa entre o ultimo movimento e o soltar que cancela a inercia.
export const FLING_HOLD_MS = 100;
// Teto de entalhes de roda por movimento no buffer alternativo.
export const MAX_WHEEL_PER_MOVE = 3;

export function createTouchScroll({ rowHeight, scrollLines, sendWheel, hasScrollback, requestFrame, cancelFrame }) {
  let lastY = 0;
  let lastTime = 0;
  let velocity = 0;
  let carry = 0;
  let frame = null;
  let frameTime = 0;

  function stopFling() {
    if (frame != null) cancelFrame(frame);
    frame = null;
  }

  // Pixels acumulados viram linhas inteiras; a fracao fica para o proximo
  // movimento, entao um arrasto lento tambem anda.
  function apply(pixels, wheel) {
    const height = Math.max(1, rowHeight() || 1);
    carry += pixels / height;
    const rows = carry > 0 ? Math.floor(carry) : Math.ceil(carry);
    if (!rows) return 0;
    carry -= rows;
    if (hasScrollback()) scrollLines(rows);
    else if (wheel && sendWheel) sendWheel(rows > 0 ? 1 : -1, Math.min(Math.abs(rows), MAX_WHEEL_PER_MOVE));
    return rows;
  }

  function step(time) {
    frame = null;
    const elapsed = Math.min(64, Math.max(1, time - frameTime));
    frameTime = time;
    apply(velocity * elapsed, false);
    velocity *= FLING_FRICTION ** (elapsed / 16);
    if (Math.abs(velocity) >= FLING_STOP_SPEED) frame = requestFrame(step);
  }

  return {
    start(y, time) {
      stopFling();
      lastY = y;
      lastTime = time;
      velocity = 0;
      carry = 0;
    },
    // Dedo para cima (y menor) mostra o que vem depois, como a roda para baixo.
    move(y, time) {
      const dy = lastY - y;
      const elapsed = Math.max(1, time - lastTime);
      const sample = Math.max(-FLING_MAX_SPEED, Math.min(FLING_MAX_SPEED, dy / elapsed));
      velocity = velocity * 0.4 + sample * 0.6;
      lastY = y;
      lastTime = time;
      return apply(dy, true);
    },
    end(time) {
      const held = time - lastTime > FLING_HOLD_MS;
      if (held || !hasScrollback() || Math.abs(velocity) < FLING_MIN_SPEED) { velocity = 0; return false; }
      frameTime = time;
      frame = requestFrame(step);
      return true;
    },
    cancel() {
      stopFling();
      velocity = 0;
      carry = 0;
    },
    get flinging() { return frame != null; },
  };
}
