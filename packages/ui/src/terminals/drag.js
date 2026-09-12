// SPDX-License-Identifier: Apache-2.0
// Arraste interno do estudio, feito na mao com eventos de ponteiro.
//
// Por que nao o drag-and-drop do HTML: dentro do app o wry registra a
// WKWebView como destino de arraste e troca os metodos do protocolo de
// arraste da NSView. No `draggingEntered` ele chama o ouvinte do Tauri e,
// quando o ouvinte responde que tratou, devolve `NSDragOperation::Copy` sem
// chamar o `super`. O ouvinte do Tauri responde `true` sempre. Resultado: o
// WebKit nunca ve o arraste, e `dragover` e `drop` nunca chegam a pagina,
// nem num arraste que comeca dentro dela.
//
// `dragDropEnabled: false` devolveria o HTML5, mas o evento nativo e o unico
// lugar onde os caminhos reais de um arquivo vindo do Finder aparecem, e o
// estudio depende disso. Entao o arraste de fora continua nativo e o de
// dentro e este.
//
// Quem arrasta chama `beginDrag` no mousedown. Quem recebe assina `onDrag` e
// decide pelo ponto: `move` para destacar o destino, `drop` para agir,
// `end` para limpar. O clique que vira arraste nao vira clique: `wasDragged`
// avisa o handler de clique da linha.
//
// Para fora do app o gesto muda de mao: quando o ponteiro cruza a borda da
// janela com o botao pressionado, o arraste interno termina e o Rust comeca
// uma sessao de arraste do AppKit com o mesmo caminho, que o Finder e os
// outros apps recebem como um arquivo arrastado. Se ela voltar para esta
// janela, chega pelo evento nativo, e `nativeDragOutPath` diz que foi daqui.

import { onNativeDragEnd, startNativeDrag } from '../lib/native.js';

const THRESHOLD = 4;
const CLICK_GUARD_MS = 120;
const NATIVE_OUT_TTL_MS = 60000;

let current = null;
let draggedAt = 0;
let nativeOut = null;
let nativeEndBound = false;
const listeners = new Set();

export function onDrag(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(type, event) {
  if (!current) return;
  const detail = {
    type,
    kind: current.kind,
    id: current.id,
    path: current.path,
    dir: current.dir,
    x: event.clientX,
    y: event.clientY,
    alt: Boolean(event.altKey),
  };
  listeners.forEach((listener) => {
    try { listener(detail); } catch (error) { console.error('[terminais/arraste]', error); }
  });
}

function ghostFor(label) {
  const node = document.createElement('div');
  node.className = 'terminais-ghost';
  node.textContent = label;
  document.body.appendChild(node);
  return node;
}

function place(node, x, y) {
  node.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 12)}px)`;
}

// O caminho que esta sendo arrastado agora, ou null.
export function draggingPath() {
  return current && current.active && current.kind === 'path' ? current.path : null;
}

// Verdadeiro logo depois de um arraste, para o clique da linha ser ignorado.
export function wasDragged() {
  return Date.now() - draggedAt < CLICK_GUARD_MS;
}

// Caminho que este app entregou ao macOS numa sessao de arraste ainda em
// curso, ou null. Quem recebe o evento nativo usa isto para tratar o item
// como seu, movendo em vez de copiar.
export function nativeDragOutPath() {
  if (!nativeOut) return null;
  if (Date.now() - nativeOut.since > NATIVE_OUT_TTL_MS) { nativeOut = null; return null; }
  return nativeOut.path;
}

function outsideWindow(event) {
  return event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
}

async function handOff(path) {
  nativeOut = { path, since: Date.now() };
  if (!nativeEndBound) {
    nativeEndBound = true;
    onNativeDragEnd(() => { nativeOut = null; }).catch(() => { nativeEndBound = false; });
  }
  try {
    const started = await startNativeDrag([path]);
    if (!started) nativeOut = null;
  } catch (error) {
    nativeOut = null;
    if (error?.code !== 'gesture') console.warn('[terminais/arraste] Arraste nativo recusado:', error?.message || error);
  }
}

// `kind` diz o que esta sendo arrastado: 'path' para um arquivo ou pasta do
// explorador, 'session' para um card de sessao. Quem recebe confere o kind
// e ignora o que nao lhe cabe. `dir` acompanha um caminho de pasta, para
// destinos que so aceitam arquivo.
export function beginDrag(event, { path = null, label, kind = 'path', id = null, dir = false }) {
  if (event.button !== 0 || current) return;
  const startX = event.clientX;
  const startY = event.clientY;
  current = { path, label, kind, id, dir: Boolean(dir), active: false, ghost: null };

  const finish = (type, moveEvent) => {
    const wasActive = current?.active;
    if (wasActive) {
      emit(type, moveEvent);
      emit('end', moveEvent);
      draggedAt = Date.now();
    }
    if (current?.ghost) current.ghost.remove();
    document.body.classList.remove('is-dragging-path');
    current = null;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    window.removeEventListener('keydown', onKey, true);
  };

  function onMove(moveEvent) {
    if (!current) return;
    // Botao solto fora da janela: o mouseup nao chega, e o primeiro
    // movimento depois disso encerra o arraste. Antes quem fazia isso era o
    // `blur` da janela, que tambem disparava enquanto o app ganhava foco e
    // matava um arraste legitimo logo no comeco.
    if (moveEvent.buttons === 0) { finish('cancel', moveEvent); return; }
    if (!current.active) {
      if (Math.abs(moveEvent.clientX - startX) < THRESHOLD && Math.abs(moveEvent.clientY - startY) < THRESHOLD) return;
      current.active = true;
      current.ghost = ghostFor(current.label);
      document.body.classList.add('is-dragging-path');
    }
    if (current.kind === 'path' && current.path && outsideWindow(moveEvent)) {
      const { path } = current;
      finish('cancel', moveEvent);
      handOff(path);
      return;
    }
    moveEvent.preventDefault();
    place(current.ghost, moveEvent.clientX, moveEvent.clientY);
    emit('move', moveEvent);
  }

  function onUp(upEvent) {
    finish('drop', upEvent);
  }

  function onKey(keyEvent) {
    if (keyEvent.key === 'Escape') finish('cancel', keyEvent);
  }

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseup', onUp, true);
  window.addEventListener('keydown', onKey, true);
}

// Ponto dentro do retangulo de um elemento.
export function inside(element, x, y) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
