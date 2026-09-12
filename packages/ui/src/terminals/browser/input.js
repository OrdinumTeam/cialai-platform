// SPDX-License-Identifier: Apache-2.0
// Entrada do canvas para a aba ativa: mouse, roda e teclado viram eventos
// de Input do CDP; copiar, colar e selecionar tudo passam pela area de
// transferencia do app. Traducao do `media/viewer.js` da extensao
// dev-browser-panel.

import { copyToClipboard } from '../../lib/helpers.js';

const KEY_CODES = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27,
  ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Delete: 46,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

const INTERCEPTED = ['c', 'x', 'v', 'a', 'l', 'r', '[', ']', 'w', 't', 'n', 'p', 'f', 'k', 'b', 'j', 'e', '=', '+', '-', '0'];

function keyCode(key) {
  if (KEY_CODES[key] !== undefined) return KEY_CODES[key];
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return 0;
}

function modifiersOf(event) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

function buttonOf(event) {
  if (event.button === 0) return 'left';
  if (event.button === 1) return 'middle';
  if (event.button === 2) return 'right';
  return 'none';
}

const SELECTED_TEXT = `(function(){
  var el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.selectionStart != null && el.selectionEnd > el.selectionStart) {
    return el.value.substring(el.selectionStart, el.selectionEnd);
  }
  var s = window.getSelection();
  return s ? s.toString() : '';
})()`;

async function readClipboard() {
  try {
    return await navigator.clipboard.readText();
  } catch (_error) {
    return '';
  }
}

// `ctrl` traz `send(method, params)` para a aba ativa, `toPageCoords(event)`
// e os atalhos do painel: focusUrl, back, forward, reload, stopLoading.
export function bindInput(canvas, ctrl) {
  let lastMove = 0;

  const send = (method, params) => ctrl.send(method, params).catch(() => {});

  const onMouseDown = (event) => {
    canvas.focus();
    const { x, y } = ctrl.toPageCoords(event);
    send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: buttonOf(event), buttons: event.buttons, clickCount: Math.min(3, event.detail || 1), modifiers: modifiersOf(event) });
  };
  const onMouseUp = (event) => {
    const { x, y } = ctrl.toPageCoords(event);
    send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: buttonOf(event), buttons: event.buttons, clickCount: Math.min(3, event.detail || 1), modifiers: modifiersOf(event) });
  };
  const onMouseMove = (event) => {
    const now = Date.now();
    if (now - lastMove < 16) return;
    lastMove = now;
    const { x, y } = ctrl.toPageCoords(event);
    send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: event.buttons, modifiers: modifiersOf(event) });
  };
  const onWheel = (event) => {
    event.preventDefault();
    const { x, y } = ctrl.toPageCoords(event);
    send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, button: 'none', deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiersOf(event) });
  };
  const onContextMenu = (event) => { event.preventDefault(); };

  const copySelection = async () => {
    try {
      const result = await ctrl.send('Runtime.evaluate', { expression: SELECTED_TEXT, returnByValue: true });
      const text = result?.result?.value || '';
      if (text) await copyToClipboard(text);
      return text;
    } catch (_error) {
      return '';
    }
  };
  const cutSelection = async () => {
    const text = await copySelection();
    if (!text) return;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', keyCode: 46, windowsVirtualKeyCode: 46 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', keyCode: 46, windowsVirtualKeyCode: 46 });
  };
  const paste = async () => {
    const text = await readClipboard();
    if (text) await send('Input.insertText', { text });
  };
  const selectAll = async () => {
    try {
      await ctrl.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, windowsVirtualKeyCode: 65, commands: ['selectAll'] });
      await ctrl.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', keyCode: 65, windowsVirtualKeyCode: 65 });
    } catch (_error) {
      await send('Runtime.evaluate', { expression: "document.execCommand('selectAll')", userGesture: true });
    }
  };

  // Atalhos do painel e do app, que nunca chegam a pagina.
  const shortcut = (event) => {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (!mod) {
      if (event.key === 'Escape') { ctrl.stopLoading?.(); return false; }
      return false;
    }
    if (key === 'l') { ctrl.focusUrl?.(); return true; }
    if (key === 'r') { ctrl.reload?.(event.shiftKey); return true; }
    if (event.key === '[') { ctrl.back?.(); return true; }
    if (event.key === ']') { ctrl.forward?.(); return true; }
    if (key === 'c') { copySelection(); return true; }
    if (key === 'x') { cutSelection(); return true; }
    if (key === 'v') { paste(); return true; }
    if (key === 'a') { selectAll(); return true; }
    // Atalhos do estudio e do app: deixam o canvas e sobem para a janela.
    if (event.shiftKey && ['b', 'j', 'e', '[', ']', 'w'].includes(key)) return 'bubble';
    if (['w', 't', 'n', 'p', 'k', 'f', '=', '+', '-', '0'].includes(key)) return 'bubble';
    return false;
  };

  const onKeyDown = (event) => {
    const handled = shortcut(event);
    if (handled === 'bubble') return;
    event.preventDefault();
    event.stopPropagation();
    if (handled) return;
    const modifiers = modifiersOf(event);
    const code = keyCode(event.key);
    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
    if (printable) {
      // rawKeyDown sem texto e char com o texto: keyDown com texto inseriria
      // o caractere duas vezes.
      send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: event.key, code: event.code, keyCode: code, windowsVirtualKeyCode: code, modifiers, autoRepeat: event.repeat });
      send('Input.dispatchKeyEvent', { type: 'char', key: event.key, text: event.key, unmodifiedText: event.key, keyCode: 0, modifiers: 0, code: event.code });
    } else if (event.key === 'Enter') {
      send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: event.code || 'Enter', keyCode: 13, windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r', modifiers, autoRepeat: event.repeat });
    } else {
      send('Input.dispatchKeyEvent', { type: 'keyDown', key: event.key, code: event.code, keyCode: code, windowsVirtualKeyCode: code, modifiers, autoRepeat: event.repeat });
    }
  };
  const onKeyUp = (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && INTERCEPTED.includes(event.key.toLowerCase())) return;
    event.preventDefault();
    event.stopPropagation();
    const modifiers = modifiersOf(event);
    const code = keyCode(event.key);
    send('Input.dispatchKeyEvent', { type: 'keyUp', key: event.key, code: event.code, keyCode: code, windowsVirtualKeyCode: code, modifiers });
  };

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('keyup', onKeyUp);
  return () => {
    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContextMenu);
    canvas.removeEventListener('keydown', onKeyDown);
    canvas.removeEventListener('keyup', onKeyUp);
  };
}
