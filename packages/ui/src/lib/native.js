// SPDX-License-Identifier: Apache-2.0
import * as remote from './remote.js';
import { authorizeNative, resetTerminalAuthorization } from './sensitive.js';
export const NATIVE_ONLY_MESSAGE = 'Disponível só no aplicativo desktop.';
export const hasBridge = () => isTauri() || remote.isConfigured();
remote.subscribeState((value) => { if (value.status !== 'connected') resetTerminalAuthorization(); });

// Ponte com o Tauri. Fora do app, no Vite de desenvolvimento aberto num
// navegador, as funções viram no-op ou usam o equivalente do navegador.

export function isTauri() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

export async function invoke(command, args) {
  if (!isTauri()) {
    if (!remote.isConfigured()) return undefined;
    await authorizeNative(command, args);
    return remote.invoke(command, args);
  }
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke(command, args);
}

export async function listen(event, handler) {
  if (!isTauri()) return remote.isConfigured() ? remote.listen(event, handler) : () => {};
  const { listen: tauriListen } = await import('@tauri-apps/api/event');
  return tauriListen(event, (message) => handler(message.payload, message));
}

// O macOS entrega caminhos locais pelo evento nativo, nao por File.path
// no drag-and-drop HTML. A posicao chega ao handler ja em pontos CSS.
//
// A API do Tauri declara a posicao como fisica, mas no macOS ela e logica:
// o wry le `draggingLocation` da NSView em pontos (wry 0.55,
// src/wkwebview/drag_drop.rs) e o tauri-runtime-wry a embrulha em
// `PhysicalPosition` sem escalar (tauri-runtime-wry 2.11, src/lib.rs, no
// handler de DragDropEvent). Dividir por devicePixelRatio, como a API
// sugere, mandava o ponto para a metade da tela numa tela Retina, e um drop
// no explorador era avaliado como se fosse no centro. Se um dia o upstream
// passar a escalar, o valor extrapola a janela e a divisao volta a valer.
export function normalizeDragPosition(position) {
  if (!position || typeof position.x !== 'number' || typeof position.y !== 'number') return null;
  const scale = window.devicePixelRatio || 1;
  const outside = position.x > window.innerWidth * 1.5 || position.y > window.innerHeight * 1.5;
  if (scale > 1 && outside) return { x: position.x / scale, y: position.y / scale };
  return { x: position.x, y: position.y };
}

export async function onNativeDragDrop(handler) {
  if (!isTauri()) return () => {};
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  return getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload || {};
    handler({ ...payload, position: normalizeDragPosition(payload.position) });
  });
}

// Arraste nativo para fora do app, comecado pelo Rust na thread principal
// com o botao do mouse ainda pressionado. Devolve false fora do app; erro
// `gesture` quando o botao ja foi solto. O fim chega por `drag-out://end`
// com a operacao que o destino escolheu.
export async function startNativeDrag(paths) {
  if (!isTauri()) return false;
  await invoke('fs_drag_out', { paths });
  return true;
}

export function onNativeDragEnd(handler) {
  if (!isTauri()) return Promise.resolve(() => {});
  return listen('drag-out://end', (payload) => handler(payload || {}));
}

// Estado de tela cheia da janela, para a toolbar nao reservar o espaco dos
// semaforos quando o macOS os esconde. Chama o handler na hora e a cada
// mudanca; fora do app nao faz nada.
export async function watchFullscreen(handler) {
  if (!isTauri()) return () => {};
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const current = getCurrentWindow();
  let last = null;
  const probe = async () => {
    try {
      const value = await current.isFullscreen();
      if (value !== last) { last = value; handler(value); }
    } catch (_error) { /* janela indisponivel */ }
  };
  await probe();
  const off = await current.onResized(() => { probe(); });
  return () => { off(); };
}

// theme: 'light', 'dark' ou null para seguir o sistema.
export async function setWindowTheme(theme) {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().setTheme(theme);
}

export async function chooseDirectory(options = {}) {
  if (!isTauri()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, ...options });
  return typeof picked === 'string' ? picked : null;
}

// Painel de salvar do sistema, para um arquivo temporario que ainda nao tem
// lugar no disco. Devolve o caminho escolhido ou null quando o usuario
// cancela.
export async function chooseSavePath(options = {}) {
  if (!isTauri()) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  const picked = await save(options);
  return typeof picked === 'string' ? picked : null;
}

// Canal do Tauri para receber dados continuos de um comando Rust, como a
// saida de um terminal. Fora do app devolve null.
export async function createChannel(onmessage) {
  if (!isTauri()) return remote.isConfigured() ? remote.createChannel(onmessage) : null;
  const { Channel } = await import('@tauri-apps/api/core');
  const channel = new Channel();
  channel.onmessage = onmessage;
  return channel;
}

export async function closeCurrentWindow() {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
}

// URL do protocolo preview:// do app para um arquivo dentro de uma raiz de
// projeto, usada pelo visualizador de HTML: a raiz vira o host, entao
// caminhos absolutos e relativos da pagina resolvem como num servidor.
// Fora do app devolve null.
export async function previewUrl(root, relative) {
  if (!isTauri()) return null;
  const token = await invoke('preview_register', { root });
  if (!token) return null;
  const path = String(relative || '').split('/').map((part) => encodeURIComponent(part)).join('/');
  return `preview://${token}/${path}`;
}
