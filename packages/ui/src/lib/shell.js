// SPDX-License-Identifier: Apache-2.0
// Message contract shared with the Expo shell. Authorization stays in the shell.
let nextId = 1;
const pending = new Map();
const lockListeners = new Set();
export const isMobileShell = () => typeof window !== 'undefined' && Boolean(window.ReactNativeWebView || window.__CIALAI_SHELL__);
export const isPhone = () => typeof document !== 'undefined' && document.documentElement.dataset.formFactor === 'phone';

export function onShellLock(listener) { lockListeners.add(listener); return () => lockListeners.delete(listener); }

export function receiveShellMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'shell' && message.unlocked === false) lockListeners.forEach((listener) => listener());
  if (message.type !== 'auth' || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(request.timer);
  request.resolve(message.ok === true);
}

if (typeof window !== 'undefined') window.__cialaiShellReceive = receiveShellMessage;

function post(message) {
  if (!window.ReactNativeWebView?.postMessage) throw new Error('A casca do iPhone está indisponível.');
  window.ReactNativeWebView.postMessage(JSON.stringify(message));
}

export async function confirmSensitive(level, reason) {
  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) return true;
  if (!['session', 'action'].includes(level)) throw new Error('Nível de autorização inválido.');
  if (!isMobileShell()) return typeof window !== 'undefined' && window.confirm(reason);
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(false); }, 120000);
    pending.set(id, { resolve, timer });
    try { post({ type: 'auth', id, level, reason }); }
    catch (_) { clearTimeout(timer); pending.delete(id); resolve(false); }
  });
}

export async function requireSensitive(level, reason) {
  if (!await confirmSensitive(level, reason)) throw new Error('Ação cancelada. Autorize no aparelho para continuar.');
}

export async function requestDownload(blob, name) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Não foi possível preparar o arquivo.'));
    reader.readAsDataURL(blob);
  });
  post({ type: 'download', name, mime: blob.type || 'application/octet-stream', dataUrl });
  return true;
}

export function openExternal(url) { post({ type: 'open-external', url: String(url) }); }

export function requestUrlDownload(url, name) {
  const target = new URL(url, typeof location !== 'undefined' ? location.href : undefined);
  post({ type: 'download', name, url: target.href });
  return true;
}
