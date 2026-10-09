// SPDX-License-Identifier: Apache-2.0
// Message contract shared with the Expo shell. Authorization stays in the shell.
import { translate } from '../shared/i18n.js';

let nextId = 1;
const pending = new Map();
const lockListeners = new Set();
const navigateBackListeners = new Set();
const themeListeners = new Set();
const THEME_MODES = ['system', 'light', 'dark'];
export const isMobileShell = () => typeof window !== 'undefined' && Boolean(window.ReactNativeWebView || window.__CIALAI_SHELL__);
export const isPhone = () => typeof document !== 'undefined' && document.documentElement.dataset.formFactor === 'phone';

// Aparencia escolhida nos ajustes do aplicativo: chega no bootstrap da pagina
// e, depois, em cada mensagem `shell`. Vazio quando a casca nao mandou nada.
export const shellTheme = () => {
  const value = typeof window !== 'undefined' ? window.__CIALAI_SHELL__?.theme : null;
  return THEME_MODES.includes(value) ? value : null;
};

export function onShellLock(listener) { lockListeners.add(listener); return () => lockListeners.delete(listener); }
export function onNavigateBack(listener) { navigateBackListeners.add(listener); return () => navigateBackListeners.delete(listener); }
export function onShellTheme(listener) { themeListeners.add(listener); return () => themeListeners.delete(listener); }

export function receiveShellMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'navigate-back') {
    navigateBackListeners.forEach((listener) => listener());
    return;
  }
  if (message.type === 'shell' && THEME_MODES.includes(message.theme)) themeListeners.forEach((listener) => listener(message.theme));
  if (message.type === 'shell' && message.unlocked === false) lockListeners.forEach((listener) => listener());
  if (message.type !== 'auth' || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(request.timer);
  request.resolve(message.ok === true);
}

if (typeof window !== 'undefined') window.__cialaiShellReceive = receiveShellMessage;

function post(message) {
  if (!window.ReactNativeWebView?.postMessage) throw new Error(translate('shared.shell.unavailable'));
  window.ReactNativeWebView.postMessage(JSON.stringify(message));
}

export async function confirmSensitive(level, reason) {
  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) return true;
  if (!['session', 'action'].includes(level)) throw new Error(translate('shared.shell.invalidLevel'));
  if (!isMobileShell()) return typeof window !== 'undefined' && window.confirm(reason);
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(false); }, 120000);
    pending.set(id, { resolve, timer });
    try { post({ type: 'auth', id, level, reason }); }
    catch (_) { clearTimeout(timer); pending.delete(id); resolve(false); }
  });
}

// O protocolo manda o motivo como código; motivos livres seguem como vieram.
const SENSITIVE_REASON_KEYS = Object.freeze({
  terminal_input: 'shared.sensitive.terminalInput',
  terminal_close: 'shared.sensitive.terminalClose',
  computer_change: 'shared.sensitive.computerChange',
});

export async function requireSensitive(level, reason) {
  const key = SENSITIVE_REASON_KEYS[reason];
  if (!await confirmSensitive(level, key ? translate(key) : reason)) throw new Error(translate('shared.shell.actionCanceled'));
}

export async function requestDownload(blob, name) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(translate('shared.shell.filePrepareFailed')));
    reader.readAsDataURL(blob);
  });
  post({ type: 'download', name, mime: blob.type || 'application/octet-stream', dataUrl });
  return true;
}

export function openExternal(url) { post({ type: 'open-external', url: String(url) }); }
export function requestNavigateBack() { post({ type: 'navigate-back' }); }
// Retrato do computador para o Inicio nativo; o formato esta em mobile/dashboard-snapshot.js.
export function postDashboard(snapshot) { post(snapshot); }
// Pasta escolhida no navegador para virar atalho em Projetos, na casca.
export function postProjectPicked(path, name) { post({ type: 'project-picked', path: String(path), name: String(name || '') }); }
// Nome do computador como a casca o mostra, para o resumo da sessao nova.
export const shellDesktopName = () => {
  const value = typeof window !== 'undefined' ? window.__CIALAI_SHELL__?.desktopName : null;
  return typeof value === 'string' ? value : '';
};

// Pedido da casca ao abrir o terminal: retomar uma sessao, abrir uma nova numa
// pasta, mostrar as contas ou escolher uma pasta para virar atalho. Vale uma
// vez por id, mesmo se a pagina recarregar.
const INTENT_KINDS = ['session', 'new-session', 'profiles', 'pick-project'];
const INTENTS_USED_KEY = 'cialai_shell_intents';
export function takeShellIntent(storage = typeof window !== 'undefined' ? window.localStorage : null) {
  const intent = typeof window !== 'undefined' ? window.__CIALAI_SHELL__?.intent : null;
  if (!intent || typeof intent.id !== 'string' || !INTENT_KINDS.includes(intent.kind)) return null;
  let used = [];
  try { used = JSON.parse(storage?.getItem(INTENTS_USED_KEY) || '[]'); } catch (_error) { used = []; }
  if (!Array.isArray(used)) used = [];
  if (used.includes(intent.id)) return null;
  try { storage?.setItem(INTENTS_USED_KEY, JSON.stringify([...used, intent.id].slice(-20))); } catch (_error) { /* sem storage */ }
  return intent;
}

export function requestUrlDownload(url, name) {
  const target = new URL(url, typeof location !== 'undefined' ? location.href : undefined);
  post({ type: 'download', name, url: target.href });
  return true;
}
