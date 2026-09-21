// SPDX-License-Identifier: Apache-2.0
// Explorador de arquivos da sessao selecionada. A raiz e a pasta escolhida
// ao criar a sessao e so muda por acao explicita: "Ir" para o diretorio
// atual do shell ou o modo de acompanhar. Cada pasta e listada ao expandir e
// observada por kqueue enquanto estiver visivel; recolher devolve o
// observador. Marcadores Git vem do `git status` do projeto e dizem so que o
// arquivo mudou, sem atribuir autoria.
//
// O painel assina so os eventos de explorador da propria sessao; da
// atividade le apenas o diretorio do shell, e so redesenha quando ele muda.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight, ChevronsDownUp, Crosshair, File, FileCode2, FileImage, FileJson2, FileText, FilePlus2, Folder,
  FolderOpen, FolderPlus, Locate, RefreshCw, Search, X,
} from 'lucide-react';
import Menu, { anchorFromEvent } from './Menu.jsx';
import { baseName, compactPath, dirName, extensionOf, fileKind, freeName, fs, git, isAbsolutePath, isInside, joinPath, relativePath, shortPath } from '../files.js';
import { beginDrag, inside, nativeDragOutPath, onDrag, wasDragged } from '../drag.js';
import { markExplorerChanged, setExplorerRoot, setFollowCwd, subscribeChanges, unwatchPath, watchPath } from '../runtime.js';
import { retargetTabs } from '../editor.js';
import { swapIn } from '../motion.js';
import { useRuntimeEvents, useRuntimeValue } from '../hooks.js';
import { copyToClipboard } from '../../lib/helpers.js';
import { onNativeDragDrop } from '../../lib/native.js';
import { shortcutLabel } from '../../lib/keys.js';
import { isExplorerDeleteShortcut } from '../shortcut-actions.js';
import { getLocale, translate, useI18n } from '../../shared/i18n.js';

// Linhas novas que entram escalonadas na arvore; acima disso nenhuma anima.
const FRESH_ROWS_LIMIT = 60;

// Tempo parado sobre uma pasta recolhida antes de ela abrir sozinha durante
// um arraste, como no explorador do VS Code.
const HOVER_EXPAND_MS = 700;

// No Windows cada git_status abre dois processos e CreateProcess é caro, então
// o painel espaça as chamadas: poll de 60 s quando visível, nenhum quando
// oculto, debounce do watcher de 2,5 s com coalescência, e um piso de 5 s que
// corta o disparo redundante quando um status acabou de rodar.
const GIT_REFRESH_MS = 60000;
const GIT_DEBOUNCE_MS = 2500;
const GIT_MIN_INTERVAL_MS = 5000;
const DIR_RELOAD_DEBOUNCE_MS = 150;
const STATUS_LETTER = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', untracked: 'U', conflict: '!' };
const statusLabel = (status) => STATUS_LETTER[status] ? translate(`terminal.explorer.status.${status}`) : status;

const CODE_EXT = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'rb', 'php', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'zsh', 'bash', 'css', 'scss', 'html', 'vue', 'svelte', 'sql', 'lua', 'toml', 'yaml', 'yml', 'xml']);

function IconFor({ entry, expanded }) {
  const isDir = entry.kind === 'dir' || entry.targetKind === 'dir';
  if (isDir) return expanded ? <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" /> : <Folder size={14} strokeWidth={1.75} aria-hidden="true" />;
  const kind = fileKind(entry.name);
  const ext = extensionOf(entry.name);
  if (kind === 'image') return <FileImage size={14} strokeWidth={1.75} aria-hidden="true" />;
  if (kind === 'markdown') return <FileText size={14} strokeWidth={1.75} aria-hidden="true" />;
  if (ext === 'json') return <FileJson2 size={14} strokeWidth={1.75} aria-hidden="true" />;
  if (CODE_EXT.has(ext)) return <FileCode2 size={14} strokeWidth={1.75} aria-hidden="true" />;
  return <File size={14} strokeWidth={1.75} aria-hidden="true" />;
}

function isDirEntry(entry) {
  return entry.kind === 'dir' || entry.targetKind === 'dir';
}

export default function ExplorerPane({ session, onOpenFile, onOpenDiff, onNewSessionAt, onInsertPath, onDeleteRequest, onShowInGraph, notify, revealRequest }) {
  useI18n();
  const explorer = session.explorer;
  const root = explorer.root;
  const sessionId = session.id;
  // Troca de sessao: a arvore surge de novo.
  useEffect(() => { swapIn(treeRef.current, { x: 6, y: 0 }); }, [sessionId]);
  useRuntimeEvents(['explorer'], sessionId);
  const readCwd = useCallback(() => session.activity?.shellCwd || null, [session]);
  const shellCwd = useRuntimeValue(['activity'], sessionId, readCwd);
  const [, setRender] = useState(0);
  const rerender = useCallback(() => setRender((value) => value + 1), []);
  const [menu, setMenu] = useState(null);
  const [editing, setEditing] = useState(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [focused, setFocused] = useState(null);
  // Pasta destacada durante um arraste, e o efeito que o soltar vai ter.
  const [drop, setDrop] = useState(null);
  const treeRef = useRef(null);
  const hoverExpand = useRef({ path: null, timer: null });
  const reloadTimers = useRef(new Map());
  const gitTimer = useRef(null);
  const searchTimer = useRef(null);

  /* ── carregamento ────────────────────────────────────────────────── */

  const loadDir = useCallback(async (path, { quiet = false } = {}) => {
    const nodes = session.explorer.nodes;
    const current = nodes.get(path);
    if (current?.loading) return;
    nodes.set(path, { ...(current || {}), loading: !quiet || !current, error: null });
    markExplorerChanged(sessionId);
    try {
      const listing = await fs.listDir(path);
      nodes.set(path, { entries: listing.entries, total: listing.total, truncated: listing.truncated, loading: false, error: null, loadedAt: Date.now() });
    } catch (error) {
      nodes.set(path, { entries: current?.entries || [], total: 0, truncated: false, loading: false, error: error?.message || String(error) });
    }
    markExplorerChanged(sessionId);
  }, [session, sessionId]);

  const scheduleReload = useCallback((path) => {
    const timers = reloadTimers.current;
    if (timers.has(path)) clearTimeout(timers.get(path));
    timers.set(path, setTimeout(() => { timers.delete(path); loadDir(path, { quiet: true }); }, DIR_RELOAD_DEBOUNCE_MS));
  }, [loadDir]);

  const refreshGit = useCallback(async ({ force = false } = {}) => {
    // Piso de 5 s: um foco, uma visibilidade ou um evento do watcher logo depois
    // de um status recém rodado não abre outro par de processos à toa. O
    // primeiro carregamento tem gitAt em zero e sempre passa.
    if (!force && Date.now() - (session.explorer.gitAt || 0) < GIT_MIN_INTERVAL_MS) return;
    // Marca o início para uma segunda chamada na mesma janela não escapar
    // enquanto o git_status ainda corre.
    session.explorer.gitAt = Date.now();
    try {
      const status = await git.status(root);
      session.explorer.git = status;
    } catch (_error) {
      session.explorer.git = { isRepo: false, changes: [] };
    }
    session.explorer.gitAt = Date.now();
    markExplorerChanged(sessionId);
  }, [root, session, sessionId]);

  const scheduleGit = useCallback(() => {
    if (gitTimer.current) clearTimeout(gitTimer.current);
    gitTimer.current = setTimeout(() => { gitTimer.current = null; refreshGit(); }, GIT_DEBOUNCE_MS);
  }, [refreshGit]);

  // Pastas expandidas e visiveis: cada uma carregada e observada. Recolher
  // uma pasta devolve o observador dela e dos filhos.
  const visibleDirs = useMemo(() => {
    const result = [];
    const walk = (path) => {
      result.push(path);
      const node = explorer.nodes.get(path);
      if (!node?.entries) return;
      node.entries.forEach((entry) => {
        if (isDirEntry(entry) && explorer.expanded.has(entry.path)) walk(entry.path);
      });
    };
    walk(root);
    return result;
  }, [explorer, root, explorer.revision]);

  const watched = useRef(new Set());
  useEffect(() => {
    const next = new Set(visibleDirs);
    visibleDirs.forEach((path) => {
      if (!explorer.nodes.has(path)) loadDir(path);
      if (!watched.current.has(path)) { watched.current.add(path); watchPath(session, path); }
    });
    [...watched.current].forEach((path) => {
      if (!next.has(path)) { watched.current.delete(path); unwatchPath(session, path); }
    });
  }, [visibleDirs, explorer, loadDir, session]);

  useEffect(() => () => {
    [...watched.current].forEach((path) => unwatchPath(session, path));
    watched.current.clear();
  }, [session]);

  // Recarrega o que esta a vista: as pastas abertas e o estado do Git. O
  // observador kqueue ja avisa quase sempre; isto e a rede de seguranca para
  // o que ele nao viu, como uma pasta criada por um agente enquanto a janela
  // estava atras de outra.
  const visibleDirsRef = useRef(visibleDirs);
  visibleDirsRef.current = visibleDirs;
  const refreshAll = useCallback(() => {
    visibleDirsRef.current.forEach((path) => loadDir(path, { quiet: true }));
    refreshGit();
  }, [loadDir, refreshGit]);

  useEffect(() => {
    if (!explorer.nodes.has(root)) loadDir(root);
    refreshGit();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') refreshAll();
    }, GIT_REFRESH_MS);
    // Voltar para a janela mostra o disco como ele esta agora.
    const onFocus = () => refreshAll();
    const onVisible = () => { if (document.visibilityState === 'visible') refreshAll(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [root, explorer, loadDir, refreshGit, refreshAll]);

  useEffect(() => subscribeChanges((event) => {
    if (!isInside(root, event.path) && event.path !== root) return;
    if (event.dir && explorer.nodes.has(event.path)) scheduleReload(event.path);
    scheduleGit();
  }), [root, explorer, scheduleReload, scheduleGit]);

  // Um pedido de revelar vindo da busca rapida: expande os ancestrais.
  useEffect(() => {
    if (!revealRequest || revealRequest.sessionId !== sessionId) return;
    const target = revealRequest.path;
    if (!isInside(root, target)) return;
    let cursor = dirName(target);
    const ancestors = [];
    while (isInside(root, cursor) && cursor !== root) { ancestors.push(cursor); cursor = dirName(cursor); }
    ancestors.forEach((path) => explorer.expanded.add(path));
    setFocused(target);
    markExplorerChanged(sessionId);
    setTimeout(() => {
      treeRef.current?.querySelector(`[data-path="${CSS.escape(target)}"]`)?.scrollIntoView({ block: 'center' });
    }, 200);
  }, [revealRequest, root, explorer, sessionId]);

  /* ── git ─────────────────────────────────────────────────────────── */

  const gitIndex = useMemo(() => {
    const status = explorer.git;
    const files = new Map();
    const dirs = new Set();
    if (!status?.isRepo || !status.root) return { files, dirs, status };
    status.changes.forEach((change) => {
      const path = joinPath(status.root, change.path.replace(/\/$/, ''));
      files.set(path, change);
      let cursor = dirName(path);
      while (cursor.length >= status.root.length && !dirs.has(cursor)) {
        dirs.add(cursor);
        if (cursor === status.root) break;
        cursor = dirName(cursor);
      }
    });
    return { files, dirs, status };
  }, [explorer.git]);

  /* ── acoes ───────────────────────────────────────────────────────── */

  const toggleDir = (path) => {
    if (explorer.expanded.has(path)) explorer.expanded.delete(path);
    else explorer.expanded.add(path);
    markExplorerChanged(sessionId);
    rerender();
  };

  // Recolhe todas as pastas, como o botao do explorador do VS Code.
  const collapseAll = () => {
    explorer.expanded = new Set([root]);
    setFocused(null);
    markExplorerChanged(sessionId);
  };

  const startCreate = (parent, kind) => {
    explorer.expanded.add(parent);
    setEditing({ kind: kind === 'dir' ? 'new-dir' : 'new-file', parent, value: '' });
    markExplorerChanged(sessionId);
  };

  const commitEditing = async (value) => {
    const current = editing;
    setEditing(null);
    if (!current) return;
    const name = String(value || '').trim();
    if (!name) return;
    if (name.includes('/')) { notify(translate('terminal.explorer.invalidName'), 'warning'); return; }
    try {
      if (current.kind === 'rename') {
        const target = joinPath(dirName(current.path), name);
        if (target === current.path) return;
        await fs.rename(current.path, target);
        await loadDir(dirName(current.path), { quiet: true });
        setFocused(target);
      } else {
        const target = joinPath(current.parent, name);
        if (current.kind === 'new-dir') await fs.createDir(target);
        else await fs.createFile(target);
        await loadDir(current.parent, { quiet: true });
        setFocused(target);
        if (current.kind === 'new-file') onOpenFile(target);
      }
      scheduleGit();
    } catch (error) {
      notify(error?.message || String(error), 'warning');
    }
  };

  // Copia ao lado, com o sufixo do Finder: `nota copy.md`, `nota copy 2.md`.
  const duplicate = useCallback(async (path) => {
    const dir = dirName(path);
    try {
      const nome = await freeName(dir, baseName(path));
      await fs.copy(path, joinPath(dir, nome));
      await loadDir(dir, { quiet: true });
      setFocused(joinPath(dir, nome));
      scheduleGit();
      notify(translate('terminal.explorer.duplicatedAs', { name: nome }), 'success');
    } catch (error) {
      notify(error?.message || String(error), 'warning');
    }
  }, [loadDir, scheduleGit, notify]);

  const copyPath = async (path, relative) => {
    const text = relative ? (relativePath(root, path) || path) : path;
    const ok = await copyToClipboard(text);
    notify(ok ? translate('terminal.common.pathCopied') : translate('terminal.common.copyFailed'), ok ? 'success' : 'warning');
  };

  const openEntry = (entry) => {
    if (isDirEntry(entry)) toggleDir(entry.path);
    else onOpenFile(entry.path);
  };

  // O arraste comeca no mousedown e so passa a valer depois de alguns
  // pixels, entao um clique continua abrindo o arquivo.
  const startDrag = (event, path, dir = false) => {
    if (editing) return;
    setFocused(path);
    beginDrag(event, { path, label: baseName(path), dir });
  };

  /* ── arrastar e soltar na arvore ─────────────────────────────────── */

  // Pasta que recebe o item solto: a propria linha quando e pasta, a pasta
  // que contem a linha quando e arquivo, a raiz no espaco vazio.
  const dropDirAt = useCallback((node) => {
    const row = node && node.closest ? node.closest('[data-path][data-kind]') : null;
    if (!row) return root;
    const path = row.getAttribute('data-path');
    return row.getAttribute('data-kind') === 'dir' ? path : dirName(path);
  }, [root]);

  const cancelHoverExpand = useCallback(() => {
    if (hoverExpand.current.timer) clearTimeout(hoverExpand.current.timer);
    hoverExpand.current = { path: null, timer: null };
  }, []);

  // Parar sobre uma pasta recolhida durante o arraste abre ela.
  const scheduleHoverExpand = useCallback((path) => {
    if (hoverExpand.current.path === path) return;
    cancelHoverExpand();
    if (!path || explorer.expanded.has(path)) return;
    hoverExpand.current = {
      path,
      timer: setTimeout(() => {
        hoverExpand.current = { path: null, timer: null };
        explorer.expanded.add(path);
        markExplorerChanged(sessionId);
      }, HOVER_EXPAND_MS),
    };
  }, [explorer, sessionId, cancelHoverExpand]);

  const clearDrop = useCallback(() => { cancelHoverExpand(); setDrop(null); }, [cancelHoverExpand]);

  useEffect(() => () => cancelHoverExpand(), [cancelHoverExpand]);

  // Move ou copia um item para dentro de uma pasta. Mover mantem o nome e
  // recusa nome ocupado; copiar procura um nome livre, como o Finder.
  const dropInto = useCallback(async (source, dir, { copy = false } = {}) => {
    if (!source || !dir) return;
    if (source === root) { notify(translate('terminal.explorer.rootCannotMove'), 'warning'); return; }
    if (isInside(source, dir)) { notify(translate('terminal.explorer.folderCannotContainItself'), 'warning'); return; }
    const from = dirName(source);
    if (!copy && from === dir) return;
    const name = baseName(source);
    try {
      const finalName = copy ? await freeName(dir, name) : name;
      const target = joinPath(dir, finalName);
      if (copy) {
        await fs.copy(source, target);
      } else {
        await fs.rename(source, target);
        retargetTabs(source, target);
        // As pastas que estavam abertas continuam abertas no lugar novo.
        const moved = [...explorer.expanded].filter((path) => path === source || path.startsWith(`${source}/`));
        moved.forEach((path) => {
          explorer.expanded.delete(path);
          explorer.expanded.add(`${target}${path.slice(source.length)}`);
        });
      }
      explorer.expanded.add(dir);
      await loadDir(dir, { quiet: true });
      if (!copy && from !== dir) await loadDir(from, { quiet: true });
      setFocused(target);
      markExplorerChanged(sessionId);
      scheduleGit();
      if (copy && finalName !== name) notify(translate('terminal.explorer.copiedAs', { name: finalName }), 'info');
    } catch (error) {
      notify(error?.message || String(error), 'warning');
    }
  }, [root, explorer, sessionId, loadDir, scheduleGit, notify]);

  // Itens vindos do gerenciador de arquivos do sistema entram sempre como
  // copia. No Windows o caminho chega como `C:\\Users\\...`, entao a guarda
  // aceita letra de unidade e compartilhamento de rede, nao so a barra inicial.
  const importPaths = useCallback(async (paths, dir) => {
    for (const source of paths) {
      if (typeof source !== 'string' || !isAbsolutePath(source)) continue;
      // eslint-disable-next-line no-await-in-loop
      await dropInto(source, dir, { copy: true });
    }
  }, [dropInto]);

  // O destino e decidido pelo ponto do cursor, nao por evento do HTML: o
  // arraste interno nao passa pelo drag-and-drop do WebKit dentro do app.
  useEffect(() => onDrag((event) => {
    if (event.kind && event.kind !== 'path') return;
    if (event.type === 'end' || event.type === 'cancel') { clearDrop(); return; }
    if (!inside(treeRef.current, event.x, event.y)) {
      if (event.type === 'move') clearDrop();
      return;
    }
    const dir = dropDirAt(document.elementFromPoint(event.x, event.y));
    if (event.type === 'move') {
      scheduleHoverExpand(dir);
      setDrop((current) => (current?.dir === dir && current.copy === event.alt ? current : { dir, copy: event.alt }));
      return;
    }
    if (event.type === 'drop') {
      clearDrop();
      dropInto(event.path, dir, { copy: event.alt });
    }
  }), [dropDirAt, clearDrop, scheduleHoverExpand, dropInto]);

  // O macOS entrega os caminhos de um arraste do Finder pelo evento nativo,
  // nunca pelo dataTransfer do webview. A posicao ja chega em pontos CSS.
  // Um item que saiu desta arvore pela borda da janela e voltou chega pelo
  // mesmo evento; ele continua sendo movido, como no arraste interno.
  useEffect(() => {
    let disposed = false;
    let unlisten;
    onNativeDragDrop((event) => {
      if (disposed) return;
      const point = event.position ? document.elementFromPoint(event.position.x, event.position.y) : null;
      const inside = point && treeRef.current?.contains(point);
      if (!inside) { setDrop(null); return; }
      const dir = dropDirAt(point);
      const own = nativeDragOutPath();
      const paths = event.paths || [];
      const mine = Boolean(own && paths.length === 1 && paths[0] === own);
      if (event.type === 'drop') {
        clearDrop();
        if (mine) dropInto(own, dir, { copy: false });
        else importPaths(paths, dir);
        return;
      }
      cancelHoverExpand();
      const copy = !mine;
      setDrop((current) => (current?.dir === dir && current.copy === copy ? current : { dir, copy }));
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    }).catch((error) => console.error('[terminais] Arraste nativo indisponível:', error));
    return () => { disposed = true; unlisten?.(); };
  }, [dropDirAt, clearDrop, cancelHoverExpand, importPaths, dropInto]);


  const menuFor = (entry, anchor) => {
    const dir = isDirEntry(entry);
    const change = gitIndex.files.get(entry.path);
    const items = [
      dir
        ? { id: 'toggle', label: translate(explorer.expanded.has(entry.path) ? 'terminal.explorer.collapse' : 'terminal.explorer.expand'), run: () => toggleDir(entry.path) }
        : { id: 'open', label: translate('terminal.explorer.openEditor'), run: () => onOpenFile(entry.path) },
      { id: 'default', label: translate('terminal.common.openDefault'), run: () => fs.openDefault(entry.path).catch((error) => notify(error.message, 'warning')) },
      { id: 'reveal', label: translate('terminal.common.reveal'), run: () => fs.reveal(entry.path).catch((error) => notify(error.message, 'warning')) },
      change && !dir ? { id: 'diff', label: translate('terminal.explorer.compareChanges'), run: () => onOpenDiff(gitIndex.status.root, entry.path) } : null,
      { separator: true },
      dir ? { id: 'session', label: translate('terminal.explorer.newSessionHere'), run: () => onNewSessionAt(entry.path) } : null,
      onShowInGraph && (dir || /\.md$/i.test(entry.name)) ? { id: 'docgraph', label: translate('terminal.docgraph.showInGraph'), run: () => onShowInGraph(entry.path) } : null,
      { id: 'insert', label: translate('terminal.explorer.insertPath'), run: () => onInsertPath(entry.path) },
      { id: 'copy', label: translate('terminal.explorer.copyPath'), run: () => copyPath(entry.path, false) },
      { id: 'copy-rel', label: translate('terminal.explorer.copyRelativePath'), run: () => copyPath(entry.path, true) },
      { separator: true },
      { id: 'duplicate', label: translate('terminal.explorer.duplicate'), run: () => duplicate(entry.path) },
      dir ? { id: 'new-file', label: translate('terminal.explorer.newFile'), run: () => startCreate(entry.path, 'file') } : null,
      dir ? { id: 'new-dir', label: translate('terminal.explorer.newFolder'), run: () => startCreate(entry.path, 'dir') } : null,
      { id: 'rename', label: translate('terminal.explorer.rename'), run: () => setEditing({ kind: 'rename', path: entry.path, value: entry.name }) },
      { id: 'delete', label: translate('terminal.explorer.moveTrash'), danger: true, run: () => onDeleteRequest({ path: entry.path, name: entry.name, kind: dir ? 'dir' : 'file', parent: dirName(entry.path) }) },
    ];
    setMenu({ anchor, items });
  };

  /* ── busca ───────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!searching) { setResults(null); return undefined; }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      try {
        const found = await fs.find(root, query, 80);
        setResults(found);
      } catch (error) {
        setResults({ items: [], error: error?.message || String(error) });
      }
    }, 140);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [searching, query, root]);

  /* ── arvore achatada ─────────────────────────────────────────────── */

  const rows = useMemo(() => {
    const list = [];
    const walk = (path, depth) => {
      const node = explorer.nodes.get(path);
      if (editing && editing.kind !== 'rename' && editing.parent === path) list.push({ type: 'edit', path: `${path}/__new__`, depth, parent: path });
      if (!node) { list.push({ type: 'loading', path: `${path}/__loading__`, depth }); return; }
      if (node.error) { list.push({ type: 'error', path: `${path}/__error__`, depth, message: node.error }); return; }
      if (node.loading && !node.entries) { list.push({ type: 'loading', path: `${path}/__loading__`, depth }); return; }
      if (node.entries && node.entries.length === 0) list.push({ type: 'empty', path: `${path}/__empty__`, depth });
      (node.entries || []).forEach((entry) => {
        const dir = isDirEntry(entry);
        const expanded = dir && explorer.expanded.has(entry.path);
        list.push({ type: 'entry', entry, path: entry.path, depth, dir, expanded });
        if (expanded) walk(entry.path, depth + 1);
      });
      if (node.truncated) list.push({ type: 'truncated', path: `${path}/__more__`, depth, total: node.total, shown: node.entries.length });
    };
    walk(root, 0);
    return list;
  }, [explorer, root, explorer.revision, editing]);
  // Linhas que acabaram de aparecer entram uma atras da outra. Acima do
  // limite, como uma pasta enorme, nenhuma anima: so a arvore.
  const seenPathsRef = useRef(null);
  const freshPaths = useMemo(() => {
    const seen = seenPathsRef.current;
    const fresh = new Set();
    for (const row of rows) {
      const path = row.entry ? row.entry.path : row.path;
      if (!seen || !seen.has(path)) fresh.add(path);
    }
    return fresh.size <= FRESH_ROWS_LIMIT ? fresh : new Set();
  }, [rows]);
  useEffect(() => {
    seenPathsRef.current = new Set(rows.map((row) => (row.entry ? row.entry.path : row.path)));
  }, [rows]);
  let freshIndex = 0;

  const onTreeKeyDown = (event) => {
    if (editing) return;
    const entries = rows.filter((row) => row.type === 'entry');
    if (!entries.length) return;
    const index = Math.max(0, entries.findIndex((row) => row.path === focused));
    const current = entries[index];
    const focusRow = (row) => {
      setFocused(row.path);
      treeRef.current?.querySelector(`[data-path="${CSS.escape(row.path)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    if (event.key === 'ArrowDown') { event.preventDefault(); focusRow(entries[Math.min(entries.length - 1, index + 1)]); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusRow(entries[Math.max(0, index - 1)]); }
    else if (event.key === 'ArrowRight' && current?.dir) { event.preventDefault(); if (!current.expanded) toggleDir(current.path); }
    else if (event.key === 'ArrowLeft' && current) {
      event.preventDefault();
      if (current.dir && current.expanded) toggleDir(current.path);
      else { const parent = entries.find((row) => row.path === dirName(current.path)); if (parent) focusRow(parent); }
    } else if (event.key === 'Enter' && current) { event.preventDefault(); openEntry(current.entry); }
    else if (isExplorerDeleteShortcut(event) && current) {
      event.preventDefault();
      onDeleteRequest({ path: current.path, name: current.entry.name, kind: current.dir ? 'dir' : 'file', parent: dirName(current.path) });
    }
  };

  const cwdDiffers = shellCwd && shellCwd !== root;
  const gitStatus = gitIndex.status;

  return (
    <aside className="terminais-explorer" id="terminais-explorer" aria-label={translate('terminal.explorer.projectFiles')}>
      <div className="terminais-pane__head">
        <span className="terminais-pane__title">{translate('terminal.explorer.files')}</span>
        <span className="terminais-pane__count" title={shortPath(root)}>{baseName(root)}</span>
        <span className="terminais-pane__spacer" />
        <button type="button" className="terminais-pane__tool" onClick={() => startCreate(root, 'file')} aria-label={translate('terminal.explorer.newFile')} title={translate('terminal.explorer.newFile')}><FilePlus2 size={14} strokeWidth={1.75} /></button>
        <button type="button" className="terminais-pane__tool" onClick={() => startCreate(root, 'dir')} aria-label={translate('terminal.explorer.newFolder')} title={translate('terminal.explorer.newFolder')}><FolderPlus size={14} strokeWidth={1.75} /></button>
        <button type="button" className="terminais-pane__tool" onClick={refreshAll} aria-label={translate('terminal.explorer.refresh')} title={translate('terminal.explorer.refreshTitle')}><RefreshCw size={13} strokeWidth={1.75} /></button>
        <button type="button" className="terminais-pane__tool" onClick={collapseAll} disabled={explorer.expanded.size <= 1} aria-label={translate('terminal.explorer.collapseAll')} title={translate('terminal.explorer.collapseAll')}><ChevronsDownUp size={13} strokeWidth={1.75} /></button>
        <button type="button" className={`terminais-pane__tool${searching ? ' is-on' : ''}`} onClick={() => { setSearching((value) => !value); setQuery(''); }} aria-label={translate('terminal.explorer.searchByName')} aria-pressed={searching} title={translate('terminal.explorer.searchName')}><Search size={13} strokeWidth={2} /></button>
      </div>
      {gitStatus?.isRepo ? (
        <div className="terminais-explorer__git" title={gitStatus.upstream ? translate('terminal.explorer.tracks', { upstream: gitStatus.upstream }) : translate('terminal.explorer.noRemote')}>
          <span className="terminais-explorer__branch">{gitStatus.detached ? translate('terminal.explorer.detachedHead') : gitStatus.branch}</span>
          {gitStatus.ahead ? <span>↑{gitStatus.ahead}</span> : null}
          {gitStatus.behind ? <span>↓{gitStatus.behind}</span> : null}
          <span className="terminais-explorer__changes">{gitStatus.changes.length === 0 ? translate('terminal.explorer.clean') : translate(gitStatus.changes.length === 1 ? 'terminal.explorer.oneChange' : 'terminal.explorer.manyChanges', { count: gitStatus.changes.length.toLocaleString(getLocale()) })}</span>
        </div>
      ) : null}
      {cwdDiffers || explorer.followCwd ? (
        <div className={`terminais-explorer__cwd${explorer.followCwd ? ' is-following' : ''}`}>
          <span className="terminais-explorer__cwd-label">{translate('terminal.explorer.terminalAt')}</span>
          <span className="terminais-explorer__cwd-path" title={shellCwd || root}>{compactPath(shellCwd || root)}</span>
          {cwdDiffers ? <button type="button" className="terminais-pane__tool" onClick={() => setExplorerRoot(sessionId, shellCwd)} title={translate('terminal.explorer.showInTree')} aria-label={translate('terminal.explorer.goCurrentDirectory')}><Locate size={13} strokeWidth={1.75} /></button> : null}
          <button type="button" className={`terminais-pane__tool${explorer.followCwd ? ' is-on' : ''}`} onClick={() => setFollowCwd(sessionId, !explorer.followCwd)} aria-pressed={explorer.followCwd} title={translate(explorer.followCwd ? 'terminal.explorer.stopFollowing' : 'terminal.explorer.follow')} aria-label={translate('terminal.explorer.followCurrent')}><Crosshair size={13} strokeWidth={1.75} /></button>
        </div>
      ) : null}
      {searching ? (
        <div className="terminais-search terminais-search--explorer">
          <Search size={13} strokeWidth={2} aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={translate('terminal.explorer.fileName')}
            aria-label={translate('terminal.explorer.searchByName')}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); setSearching(false); }
              if (event.key === 'Enter' && results?.items?.[0]) { event.preventDefault(); const first = results.items[0]; if (first.kind === 'dir') { explorer.expanded.add(first.path); markExplorerChanged(sessionId); } else onOpenFile(first.path); }
            }}
          />
          <button type="button" className="terminais-search__clear" onClick={() => setSearching(false)} aria-label={translate('terminal.explorer.closeSearch')}><X size={12} strokeWidth={2} /></button>
        </div>
      ) : null}
      <div
        className={`terminais-tree${drop && drop.dir === root ? ' is-drop-root' : ''}`}
        role="tree"
        aria-label={translate('terminal.explorer.filesOf', { name: baseName(root) })}
        ref={treeRef}
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
      >
        {searching ? (
          <div className="terminais-results">
            {results?.error ? <div className="terminais-tree__note">{results.error}</div> : null}
            {results && !results.error && results.items.length === 0 ? <div className="terminais-tree__note">{translate(query ? 'terminal.explorer.nothingFound' : 'terminal.explorer.typeToSearch')}</div> : null}
            {(results?.items || []).map((item, index) => (
              <button
                type="button"
                key={item.path}
                style={{ '--i': Math.min(index, 14) }}
                className="terminais-result"
                onMouseDown={(event) => startDrag(event, item.path, item.kind === 'dir')}
                onClick={() => {
                  if (wasDragged()) return;
                  if (item.kind === 'dir') { let cursor = item.path; while (isInside(root, cursor) && cursor !== root) { explorer.expanded.add(cursor); cursor = dirName(cursor); } setSearching(false); setFocused(item.path); markExplorerChanged(sessionId); }
                  else onOpenFile(item.path);
                }}
                onContextMenu={(event) => { event.preventDefault(); menuFor({ name: baseName(item.path), path: item.path, kind: item.kind }, anchorFromEvent(event)); }}
                title={translate('terminal.explorer.dragTitle', { path: item.path })}
              >
                <IconFor entry={{ name: baseName(item.path), kind: item.kind }} />
                <span className="terminais-result__name">{baseName(item.path)}</span>
                <span className="terminais-result__dir">{dirName(item.relative) === '/' || !item.relative.includes('/') ? '' : dirName(item.relative)}</span>
              </button>
            ))}
            {results?.truncated ? <div className="terminais-tree__note">{translate('terminal.explorer.largeProject')}</div> : null}
          </div>
        ) : rows.map((row) => {
          if (row.type === 'loading') return <div key={row.path} className="terminais-tree__note" style={{ '--depth': row.depth }}>{translate('terminal.explorer.loading')}</div>;
          if (row.type === 'empty') return <div key={row.path} className="terminais-tree__note" style={{ '--depth': row.depth }}>{translate('terminal.explorer.emptyFolder')}</div>;
          if (row.type === 'error') return <div key={row.path} className="terminais-tree__note is-error" style={{ '--depth': row.depth }}>{row.message}</div>;
          if (row.type === 'truncated') return <div key={row.path} className="terminais-tree__note" style={{ '--depth': row.depth }}>{translate('terminal.explorer.showingEntries', { shown: row.shown.toLocaleString(getLocale()), total: row.total.toLocaleString(getLocale()) })}</div>;
          if (row.type === 'edit') {
            return (
              <div key={row.path} className="terminais-row terminais-row--edit" style={{ '--depth': row.depth }}>
                {editing.kind === 'new-dir' ? <Folder size={14} strokeWidth={1.75} aria-hidden="true" /> : <File size={14} strokeWidth={1.75} aria-hidden="true" />}
                <InlineInput initial="" placeholder={translate(editing.kind === 'new-dir' ? 'terminal.explorer.folderName' : 'terminal.explorer.fileName')} onCommit={commitEditing} onCancel={() => setEditing(null)} />
              </div>
            );
          }
          const { entry } = row;
          const change = gitIndex.files.get(entry.path);
          const dirChanged = row.dir && gitIndex.dirs.has(entry.path);
          const renaming = editing?.kind === 'rename' && editing.path === entry.path;
          const isFocused = focused === entry.path;
          const fresh = freshPaths.has(entry.path);
          const order = fresh ? freshIndex++ : 0;
          return (
            <div
              key={entry.path}
              role="treeitem"
              aria-expanded={row.dir ? row.expanded : undefined}
              aria-selected={isFocused}
              data-path={entry.path}
              data-kind={row.dir ? 'dir' : 'file'}
              className={`terminais-row${fresh ? ' is-new' : ''}${isFocused ? ' is-focused' : ''}${entry.hidden ? ' is-hidden' : ''}${change ? ` is-git is-git--${change.status}` : ''}${dirChanged ? ' is-git-dir' : ''}${drop && drop.dir === entry.path ? ' is-drop' : ''}`}
              style={{ '--depth': row.depth, '--i': order }}
              onMouseDown={(event) => { if (!renaming) startDrag(event, entry.path, row.dir); }}
              onClick={() => { if (wasDragged()) return; setFocused(entry.path); openEntry(entry); }}
              onContextMenu={(event) => { event.preventDefault(); setFocused(entry.path); menuFor(entry, anchorFromEvent(event)); }}
              title={translate('terminal.explorer.dragTitle', { path: change ? `${entry.name}: ${statusLabel(change.status)}` : entry.name })}
            >
              <span className={`terminais-row__chevron${row.dir ? '' : ' is-blank'}${row.expanded ? ' is-open' : ''}`} aria-hidden="true">
                {row.dir ? <ChevronRight size={12} strokeWidth={2} /> : null}
              </span>
              <span className="terminais-row__icon"><IconFor entry={entry} expanded={row.expanded} /></span>
              {renaming ? (
                <InlineInput initial={entry.name} onCommit={commitEditing} onCancel={() => setEditing(null)} />
              ) : (
                <span className="terminais-row__name">{entry.name}</span>
              )}
              {change ? <span className="terminais-row__git" aria-label={statusLabel(change.status)}>{STATUS_LETTER[change.status] || '•'}</span> : null}
              {!change && dirChanged ? <span className="terminais-row__git terminais-row__git--dir" aria-label={translate('terminal.explorer.containsChanges')}>•</span> : null}
            </div>
          );
        })}
      </div>
      {menu ? <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} label={translate('terminal.explorer.fileActions')} /> : null}
    </aside>
  );
}

function InlineInput({ initial, placeholder, onCommit, onCancel }) {
  const [value, setValue] = useState(initial);
  const ref = useRef(null);
  const done = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      const input = ref.current;
      if (!input) return;
      input.focus();
      const dot = initial.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }, 10);
    return () => clearTimeout(timer);
  }, [initial]);
  const commit = () => { if (done.current) return; done.current = true; onCommit(value); };
  const cancel = () => { if (done.current) return; done.current = true; onCancel(); };
  return (
    <input
      ref={ref}
      className="terminais-row__input"
      value={value}
      placeholder={placeholder}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => (value.trim() ? commit() : cancel())}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      }}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      aria-label={placeholder || translate('terminal.common.name')}
    />
  );
}
