// SPDX-License-Identifier: Apache-2.0
import * as remote from './remote.js';
import { createNativeBridge, NATIVE_ONLY_MESSAGE } from '@cialai/protocol/native';
import { authorizeNative, resetTerminalAuthorization } from './sensitive.js';
import { platform } from './platform.js';
import { localizeError } from './errors.js';
export { NATIVE_ONLY_MESSAGE };
remote.subscribeState((value) => { if (value.status !== 'connected') resetTerminalAuthorization(); });

// Ponte com o Tauri. Fora do app, no Vite de desenvolvimento aberto num
// navegador, as funções viram no-op ou usam o equivalente do navegador.

export function isTauri() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

async function invokeTauri(command, args) {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke(command, args);
}

async function listenTauri(event, handler) {
  const { listen: tauriListen } = await import('@tauri-apps/api/event');
  return tauriListen(event, (message) => handler(message.payload, message));
}

async function createTauriChannel(onmessage) {
  const { Channel } = await import('@tauri-apps/api/core');
  const channel = new Channel();
  channel.onmessage = onmessage;
  return channel;
}

const bridge = createNativeBridge({
  isNative: isTauri,
  isRemoteConfigured: remote.isConfigured,
  authorizeRemote: authorizeNative,
  invokeRemote: remote.invoke,
  invokeNative: invokeTauri,
  listenRemote: remote.listen,
  listenNative: listenTauri,
  createRemoteChannel: remote.createChannel,
  createNativeChannel: createTauriChannel,
});

export const hasBridge = bridge.hasBridge;
export const invoke = (command, args) => bridge.invoke(command, args).catch((error) => { throw localizeError(error); });
export const listen = bridge.listen;
export const createChannel = bridge.createChannel;

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

// Controles da janela sem moldura do Windows. Fechar passa pelo mesmo pedido
// de saída da janela nativa, com a confirmação de terminais abertos. Fora do
// app nada acontece e a janela nunca está maximizada.
async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

export const windowControls = {
  async minimize() {
    if (isTauri()) await (await currentWindow()).minimize();
  },
  async toggleMaximize() {
    if (isTauri()) await (await currentWindow()).toggleMaximize();
  },
  async close() {
    if (isTauri()) await (await currentWindow()).close();
  },
  async isMaximized() {
    return isTauri() ? (await currentWindow()).isMaximized() : false;
  },
  // Chama o handler na hora e a cada mudança; maximizar e restaurar sempre
  // redimensionam a janela.
  async onMaximizedChange(handler) {
    if (!isTauri()) return () => {};
    const current = await currentWindow();
    let last = null;
    const probe = async () => {
      try {
        const value = await current.isMaximized();
        if (value !== last) { last = value; handler(value); }
      } catch (_error) { /* janela indisponivel */ }
    };
    await probe();
    const off = await current.onResized(() => { probe(); });
    return () => { off(); };
  },
};

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

export async function chooseFile(options = {}) {
  if (!isTauri()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: false, multiple: false, ...options });
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
export async function closeCurrentWindow() {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
}

// URL do protocolo preview:// do app para um arquivo dentro de uma raiz de
// projeto, usada pelo visualizador de HTML: a raiz vira o host, entao
// caminhos absolutos e relativos da pagina resolvem como num servidor.
// Fora do app devolve null.
export function previewAddress(token, relative, os = platform().os) {
  const path = String(relative || '').split('/').map((part) => encodeURIComponent(part)).join('/');
  if (os === 'windows') return `http://preview.localhost/${encodeURIComponent(token)}/${path}`;
  return `preview://${encodeURIComponent(token)}/${path}`;
}

export async function previewUrl(root, relative) {
  if (!isTauri()) return null;
  const token = await invoke('preview_register', { root });
  if (!token) return null;
  return previewAddress(token, relative);
}
