// SPDX-License-Identifier: Apache-2.0
import { invoke, isTauri } from './native.js';
import { currentOs } from './keys.js';

export async function copyToClipboard(text) {
  if (isTauri() && currentOs() === 'linux') {
    try { await invoke('clipboard_write_text', { text }); return true; } catch (_error) { /* browser fallback */ }
  }
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_error) { /* fallback */ }
  }
  const active = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch (_error) { copied = false; }
  textarea.remove();
  active?.focus?.({ preventScroll: true });
  return copied;
}

export function fmtBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
