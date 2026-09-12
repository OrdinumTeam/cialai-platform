// SPDX-License-Identifier: Apache-2.0
// Ponte do estudio com o sistema de arquivos e o Git do Rust, mais as
// utilidades puras de caminho: abreviar, tornar relativo, citar para o shell
// e classificar por extensao. Nada aqui guarda estado; o runtime e os
// componentes chamam e decidem.

import { invoke, isTauri, NATIVE_ONLY_MESSAGE } from '../lib/native.js';
import { platform } from '../lib/platform.js';
import { canConvertToPdf, extensionOf, fileKind, isPreviewable, isViewerKind } from './kinds.js';

export { canConvertToPdf, extensionOf, fileKind, isPreviewable, isViewerKind };

/* ── invokes ──────────────────────────────────────────────────────── */

function messageOf(error) {
  if (!error) return 'Erro desconhecido';
  if (typeof error === 'string') return error;
  if (error.message) return error.message;
  return String(error);
}

// Erros dos comandos de arquivo chegam como { code, message }. Aqui viram
// Error com `code`, para a interface reagir ao conflito e ao binario.
export class FsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code || 'io';
  }
}

function demoMode() {
  try { return new URLSearchParams(window.location.search).get('terminais') === 'demo'; } catch (_error) { return false; }
}

async function call(command, args) {
  if (demoMode()) return demoCall(command, args);
  if (!isTauri()) throw new FsError('unavailable', NATIVE_ONLY_MESSAGE);
  try {
    return await invoke(command, args);
  } catch (error) {
    if (error && typeof error === 'object' && error.code) throw new FsError(error.code, error.message);
    throw new FsError('io', messageOf(error));
  }
}

/* ── fixtures para capturas fora do Tauri ─────────────────────────── */

const DEMO_TREE = {
  '': [['dir', '.github'], ['dir', 'apps'], ['dir', 'docs'], ['dir', 'packages'], ['dir', 'tools'], ['file', '.gitignore'], ['file', 'package-lock.json'], ['file', 'package.json'], ['file', 'README.md']],
  'packages': [['dir', 'protocol'], ['dir', 'ui']],
  'packages/ui': [['dir', 'scripts'], ['dir', 'src'], ['file', 'package.json']],
  'packages/ui/src': [['dir', 'components'], ['dir', 'desktop'], ['dir', 'lib'], ['dir', 'mobile'], ['dir', 'terminals'], ['dir', 'views'], ['file', 'styles.css']],
  'packages/ui/src/terminals': [['dir', 'browser'], ['dir', 'ui'], ['file', 'editor.js'], ['file', 'files.js'], ['file', 'layout.js'], ['file', 'runtime.js'], ['file', 'theme.js']],
};

function demoCall(command, args) {
  const root = '/Users/exemplo/Projects/cialai-platform';
  if (command === 'fs_list_dir') {
    const relative = relativePath(root, args.path);
    const rows = DEMO_TREE[relative === '.' ? '' : relative] || [];
    return {
      path: args.path,
      total: rows.length,
      truncated: false,
      entries: rows.map(([kind, name]) => ({ name, path: joinPath(args.path, name), kind, targetKind: null, size: kind === 'dir' ? 0 : 2048, modifiedMs: Date.now(), hidden: name.startsWith('.') })),
    };
  }
  if (command === 'git_status') {
    return { isRepo: true, root, branch: 'main', detached: false, upstream: 'origin/main', ahead: 2, behind: 0, truncated: false, changes: [
      { path: 'frontend/src/terminals/runtime.js', status: 'modified', staged: false, worktree: true },
      { path: 'frontend/src/views/Terminais.css', status: 'modified', staged: false, worktree: true },
      { path: 'docs/application/terminais.md', status: 'untracked', staged: false, worktree: true },
    ] };
  }
  if (command === 'fs_read_text') return { path: args.path, content: '# Demo\n\nConteúdo de demonstração.\n', size: 32, modifiedMs: Date.now(), lineEnding: 'lf' };
  if (command === 'fs_stat') return { path: args.path, exists: true, kind: 'file', size: 32, modifiedMs: Date.now() };
  // Uma planilha pequena em CSV: o SheetJS le como planilha e a captura
  // mostra a tabela.
  if (command === 'fs_read_bytes') return new TextEncoder().encode('Item,Etapa,Valor\nExemplo A,Planejamento,1250\nExemplo B,Execução,980\nExemplo C,Revisão,2100\n').buffer;
  if (command === 'office_convert') throw new FsError('unavailable', NATIVE_ONLY_MESSAGE);
  if (command === 'fs_find') return { root, items: [], truncated: false };
  if (command === 'fs_watch') return 1;
  if (command === 'fs_rename' || command === 'fs_copy') return { path: args.to, exists: true, kind: 'file', size: 32, modifiedMs: Date.now() };
  return undefined;
}

export const fs = {
  listDir: (path, limit) => call('fs_list_dir', { path, limit }),
  stat: (path) => call('fs_stat', { path }),
  readText: (path) => call('fs_read_text', { path }),
  writeText: (path, content, expectedModifiedMs) => call('fs_write_text', { path, content, expectedModifiedMs: expectedModifiedMs ?? null }),
  readImage: (path) => call('fs_read_image', { path }),
  // Bytes crus, para as previas que o webview monta; chega como ArrayBuffer.
  readBytes: (path) => call('fs_read_bytes', { path }),
  createFile: (path) => call('fs_create_file', { path }),
  createDir: (path) => call('fs_create_dir', { path }),
  rename: (from, to) => call('fs_rename', { from, to }),
  copy: (from, to) => call('fs_copy', { from, to }),
  trash: (path) => call('fs_trash', { path }),
  find: (root, query, limit) => call('fs_find', { root, query, limit }),
  reveal: (path) => call('fs_reveal', { path }),
  openDefault: (path) => call('fs_open_default', { path }),
  watch: (path) => call('fs_watch', { path }),
  unwatch: (id) => call('fs_unwatch', { id }),
};

export const git = {
  status: (dir) => call('git_status', { dir }),
  diff: (root, path) => call('git_diff', { root, path }),
};

// Conversao de documentos para PDF pelo LibreOffice, com cache no Rust.
export const office = {
  convert: (path, force = false) => call('office_convert', { path, force }),
};

export function nativeAvailable() {
  return isTauri();
}

/* ── caminhos ─────────────────────────────────────────────────────── */

export function baseName(path) {
  const trimmed = portablePath(path).replace(/\/+$/, '');
  return trimmed.split('/').pop() || trimmed || '';
}

export function dirName(path) {
  const trimmed = portablePath(path).replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  if (index <= 0) return '/';
  return trimmed.slice(0, index);
}

export function joinPath(dir, name) {
  return `${portablePath(dir).replace(/\/+$/, '')}/${name}`;
}

export function portablePath(path) {
  const value = String(path || '').replace(/\\/g, '/');
  if (value.startsWith('//?/UNC/')) return `//${value.slice(8)}`;
  return value.replace(/^\/\/\?\//, '');
}

export function displayPath(path) {
  const value = portablePath(path);
  return platform().os === 'windows' ? value.replace(/\//g, '\\') : value;
}

// ~ no lugar da pasta real do usuario, em qualquer sistema.
export function shortPath(path) {
  const value = portablePath(path);
  const home = portablePath(platform().home).replace(/\/+$/, '');
  const short = home && value === home ? '~' : home && value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
  return displayPath(short);
}

// Versao curta para um card: as duas ultimas pastas, com ~ na frente quando
// o caminho esta dentro da pasta do usuario.
export function compactPath(path) {
  const short = portablePath(shortPath(path));
  const parts = short.split('/').filter(Boolean);
  if (parts.length <= 3) return short;
  return `${parts[0] === '~' ? '~/…/' : '…/'}${parts.slice(-2).join('/')}`;
}

// Nome livre numa pasta, no estilo do Finder: `nota.md`, depois
// `nota copy.md` e `nota copy 2.md`. Usado ao copiar, quando o nome de
// origem ja existe no destino; mover com nome ocupado continua sendo erro.
export async function freeName(dir, name) {
  const base = String(name || 'arquivo');
  const index = base.lastIndexOf('.');
  const stem = index > 0 ? base.slice(0, index) : base;
  const extension = index > 0 ? base.slice(index) : '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let candidate = base;
    if (attempt === 1) candidate = `${stem} copy${extension}`;
    else if (attempt > 1) candidate = `${stem} copy ${attempt}${extension}`;
    const info = await fs.stat(joinPath(dir, candidate)).catch(() => null);
    if (!info || !info.exists) return candidate;
  }
  return `${stem} ${Date.now()}${extension}`;
}

export function isInside(root, path) {
  const base = portablePath(root).replace(/\/+$/, '');
  const target = portablePath(path);
  return target === base || target.startsWith(`${base}/`);
}

export function relativePath(root, path) {
  if (!isInside(root, path)) return null;
  const base = portablePath(root).replace(/\/+$/, '');
  const rest = portablePath(path).slice(base.length).replace(/^\/+/, '');
  return rest || '.';
}

export function shellQuote(path, flavor = platform().defaultShellFlavor) {
  const text = String(path ?? '');
  if (flavor === 'cmd') {
    if (text === '') return '""';
    if (/^[A-Za-z0-9_./\\~+@%:,=-]+$/.test(text) && !text.startsWith('-')) return text;
    return `"${text.replace(/"/g, '""')}"`;
  }
  if (text === '') return "''";
  if (/^[A-Za-z0-9_./~+@%:,=-]+$/.test(text) && !text.startsWith('~') && !text.startsWith('-')) return text;
  if (flavor === 'powershell') return `'${text.replace(/'/g, "''")}'`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/* ── tipos de arquivo: ver kinds.js ───────────────────────────────── */

/* ── formatacao ───────────────────────────────────────────────────── */

export function fmtMemory(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1024 * 1024 * 1024) return `${Math.round(value / (1024 * 1024))} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function fmtCpu(percent) {
  if (percent == null || !Number.isFinite(percent)) return null;
  const value = Math.max(0, percent);
  if (value < 0.5) return '0%';
  if (value < 10) return `${value.toFixed(1).replace('.', ',')}%`;
  return `${Math.round(value)}%`;
}

// Porcentagem do plano: inteiro, com virgula so abaixo de 10%, para o card
// nao piscar entre 3% e 4% a cada leitura.
export function fmtPlan(percent) {
  const value = Math.max(0, Number(percent) || 0);
  if (value > 0 && value < 10) return `${value.toFixed(1).replace('.', ',').replace(',0', '')}%`;
  return `${Math.round(value)}%`;
}

// Quando a janela do plano renova, em linguagem de relogio: hoje mostra a
// hora, outro dia mostra dia e hora.
export function fmtResetAt(ms) {
  if (!ms) return null;
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `hoje às ${time}`;
  return `${date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${time}`;
}

export function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
}
