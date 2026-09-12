// SPDX-License-Identifier: Apache-2.0
// Snapshot da plataforma nativa. O navegador de desenvolvimento usa uma
// reserva deterministica; no Tauri o Rust substitui tudo antes do React.

import { invoke, isTauri } from './native.js';

function browserOs(agent = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  const value = String(agent).toLowerCase();
  if (value.includes('win')) return 'windows';
  if (value.includes('mac')) return 'macos';
  if (value.includes('linux')) return 'linux';
  return 'unknown';
}

function fallback() {
  const os = browserOs();
  const homes = { macos: '/Users/exemplo', linux: '/home/exemplo', windows: 'C:/Users/exemplo' };
  const managers = { macos: 'Finder', linux: 'Arquivos', windows: 'Explorer' };
  return {
    os,
    isMac: os === 'macos',
    home: homes[os] || '',
    fileManager: managers[os] || 'gerenciador de arquivos',
    defaultShellFlavor: os === 'windows' ? 'powershell' : 'posix',
    sep: os === 'windows' ? '\\' : '/',
  };
}

let current = fallback();
let loading;

function apply(info) {
  current = { ...fallback(), ...info };
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.platform = current.os;
    document.documentElement.dataset.shell = 'desktop';
  }
  return current;
}

export function platform() {
  return current;
}

export function initPlatform() {
  if (loading) return loading;
  loading = (async () => {
    if (!isTauri()) return apply(current);
    try {
      const info = await invoke('app_platform');
      return apply(info && typeof info === 'object' ? info : current);
    } catch (error) {
      console.error('[platform]', error);
      return apply(current);
    }
  })();
  return loading;
}

export { browserOs };
