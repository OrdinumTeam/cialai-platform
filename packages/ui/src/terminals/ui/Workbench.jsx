// SPDX-License-Identifier: Apache-2.0
// Estudio de terminais: sessoes a esquerda, trabalho ao centro e arquivos a
// direita. Este componente so compoe os paineis e traduz intencoes do
// usuario em chamadas ao runtime; o ciclo de vida das sessoes vive la.
//
// Redesenha so em eventos estruturais: lista, selecao e abas. A saida dos
// terminais e as metricas chegam direto aos cards e ao cabecalho, que
// assinam a propria sessao.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, Bell, ChevronLeft, ChevronRight, Copy, FileSearch, Files, FolderOpen, FolderSearch, Globe, Maximize2, Palette, PanelLeft, Pin, PinOff,
  FilePlus2, Plus, Power, RotateCcw, SquareTerminal, Tag, TextCursorInput,
} from 'lucide-react';
import { useToast } from '../../components/ui.jsx';
import { isTauri, hasBridge, NATIVE_ONLY_MESSAGE } from '../../lib/native.js';
import { copyToClipboard } from '../../lib/helpers.js';
import { registerPaletteProvider } from '../../desktop/palette-registry.js';
import { shell } from '../../desktop/shell-bridge.js';
import {
  SESSION_COLORS, activateTab, canMoveSession, changeDirectory, clearAttention, closeSession, describe, focusSelected, getRecent, getSession,
  getState, hydrate, insertPaths, insertText, isDemo, moveSessionBy, onCloseRequest, onNewFileRequest, onNewTerminalRequest, openSession, orderedSessions, pickAndOpen,
  renameSession, reopen, restart, runningLabel, selectNext, selectNextAttention, selectSession, sessionsNeedingAttention,
  setSessionColor, setSessionSubtitle, subscribe, togglePinned, viewMounted,
} from '../runtime.js';
import { closeTab, installEditorWatch, newUntitled, openDiff, openFile, reconvertTab, refreshPreview, reloadTab, restoreTabs, saveTab, setTabMode, viewAsPdf } from '../editor.js';
import { copyPort, openBrowserTab, reconcileBrowsers, stopBrowser } from '../browser/runtime.js';
import { LAYOUT_LIMITS, setLayout, useLayout } from '../layout.js';
import { baseName, fs, isPreviewable, shortPath } from '../files.js';
import { useRuntimeEvents } from '../hooks.js';
import SessionsPane from './SessionsPane.jsx';
import WorkArea, { ToolbarSlot } from './WorkArea.jsx';
import ExplorerPane from './ExplorerPane.jsx';
import Splitter from './Splitter.jsx';
import Menu from './Menu.jsx';
import NewSessionPopover from './NewSessionPopover.jsx';
import QuickOpen from './QuickOpen.jsx';
import { CloseSessionDialog, ConflictDialog, DeleteDialog, NameDialog, UnsavedDialog } from './dialogs.jsx';

// Abaixo destas larguras os paineis laterais recolhem sozinhos, sem mexer
// na preferencia do usuario, e voltam quando a janela cresce.
const AUTO_COLLAPSE_EXPLORER = 980;
const AUTO_COLLAPSE_SESSIONS = 720;

function isTerminalFocused() {
  const active = document.activeElement;
  return Boolean(active && active.closest && active.closest('.terminais-terminal'));
}

function isDark() {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

// Bolinha de cor para os itens do menu de cores.
function swatch(color) {
  return function Swatch() {
    return <span className="terminais-menu__swatch" style={{ background: color }} aria-hidden="true" />;
  };
}

export default function Workbench() {
  const notify = useToast();
  useRuntimeEvents(['sessions', 'editor', 'theme']);
  const layout = useLayout();
  const [picker, setPicker] = useState(null);
  const [menu, setMenu] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [closeRequest, setCloseRequest] = useState(null);
  const [unsavedRequest, setUnsavedRequest] = useState(null);
  const [conflictRequest, setConflictRequest] = useState(null);
  const [deleteRequest, setDeleteRequest] = useState(null);
  const [nameRequest, setNameRequest] = useState(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [revealRequest, setRevealRequest] = useState(null);
  const [editorFocusKey, setEditorFocusKey] = useState(0);
  const [auto, setAuto] = useState({ sessions: false, explorer: false });
  const rootRef = useRef(null);
  const newButtonRef = useRef(null);
  const focusRestore = useRef(null);
  const native = hasBridge() || isDemo();

  const { selected, hydrated } = getState();
  const sessions = orderedSessions();
  const selectedId = selected?.id || null;
  const tabs = selected ? selected.editor.tabs : [];
  const activeTab = selected ? tabs.find((tab) => tab.id === selected.editor.activeId) || null : null;

  /* ── ciclo de vida ───────────────────────────────────────────────── */

  const openPicker = useCallback(() => {
    if (!native) { notify(NATIVE_ONLY_MESSAGE, 'warning'); return; }
    const rect = newButtonRef.current?.getBoundingClientRect();
    setPicker(rect ? { top: rect.bottom, right: rect.right } : { top: 52, right: 16 });
  }, [native, notify]);
  const openPickerRef = useRef(openPicker);
  openPickerRef.current = openPicker;

  // ⌘N: arquivo temporario na sessao selecionada, como o `Sem título` do VS
  // Code. Sem sessao aberta nao ha onde salvar depois, entao o seletor de
  // pasta vem antes.
  const newFile = useCallback(() => {
    const current = getState().selected;
    if (!current) { notify('Abra uma sessão para criar um arquivo', 'info'); openPickerRef.current?.(); return; }
    newUntitled(current.id);
    setEditorFocusKey((value) => value + 1);
  }, [notify]);
  const newFileRef = useRef(newFile);
  newFileRef.current = newFile;

  const closeShortcutRef = useRef(() => false);

  useEffect(() => {
    hydrate().then(() => reconcileBrowsers()).catch(() => {});
    viewMounted(true);
    installEditorWatch();
    const unsubscribe = subscribe((event) => {
      if (event?.type === 'error') notify(event.message, 'warning');
      if (event?.type === 'notify') notify(event.message, 'info');
    });
    const releaseNew = onNewTerminalRequest(() => openPickerRef.current?.());
    const releaseNewFile = onNewFileRequest(() => newFileRef.current?.());
    const releaseClose = onCloseRequest(() => closeShortcutRef.current());
    // A janela volta do fundo com o teclado na NSView do tao; o terminal
    // selecionado retoma quando nada mais tem foco.
    const onWindowFocus = () => {
      const focused = document.activeElement;
      if (!focused || focused === document.body) focusSelected();
    };
    window.addEventListener('focus', onWindowFocus);
    return () => {
      viewMounted(false);
      unsubscribe();
      releaseNew();
      releaseNewFile();
      releaseClose();
      window.removeEventListener('focus', onWindowFocus);
    };
  }, [notify]);

  // Abas lembradas de uma sessao voltam quando ela e selecionada pela
  // primeira vez depois da abertura do app.
  useEffect(() => {
    if (selected && selected.editor.restoreTabs?.length) restoreTabs(selected.id).catch(() => {});
    // A aba do browser volta parada, com a ultima URL, sem lancar o Chromium.
    if (selected && selected.browser?.restoreOpen) {
      selected.browser.restoreOpen = false;
      openBrowserTab(selected.id, { start: false });
    }
  }, [selectedId]);

  useEffect(() => { setFindOpen(false); }, [selectedId]);

  // Recolhimento automatico em janelas estreitas.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width || root.clientWidth;
      setAuto((current) => {
        const next = { explorer: width < AUTO_COLLAPSE_EXPLORER, sessions: width < AUTO_COLLAPSE_SESSIONS };
        return next.explorer === current.explorer && next.sessions === current.sessions ? current : next;
      });
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [hydrated, sessions.length]);

  // Modo foco: recolhe as laterais e a navegacao principal, e devolve tudo
  // ao sair.
  const toggleFocus = useCallback(() => {
    if (!layout.focus) {
      focusRestore.current = { sidebarHidden: shell.isSidebarHidden() };
      shell.setSidebarHidden(true);
      setLayout({ focus: true });
    } else {
      const restore = focusRestore.current;
      focusRestore.current = null;
      if (restore && !restore.sidebarHidden) shell.setSidebarHidden(false);
      setLayout({ focus: false });
    }
    setTimeout(focusSelected, 50);
  }, [layout.focus]);

  useEffect(() => () => {
    // Sair da secao com o modo foco ligado devolve a navegacao.
    if (focusRestore.current && !focusRestore.current.sidebarHidden) shell.setSidebarHidden(false);
    focusRestore.current = null;
    setLayout({ focus: false });
  }, []);

  /* ── sessoes ─────────────────────────────────────────────────────── */

  const requestCloseSession = useCallback((session) => {
    const running = runningLabel(session);
    const busy = session.status === 'running' && Boolean(session.activity?.foreground);
    const dirty = session.editor.tabs.filter((tab) => tab.dirty).length;
    if (!busy && !dirty) { closeSession(session.id); return; }
    setCloseRequest({ id: session.id, name: session.name, running: busy ? (running?.text || 'Um processo') : null, dirtyTabs: dirty });
  }, []);

  // Grade de amostras: com dezoito tons a lista vertical ficaria maior que
  // a janela. Cada amostra continua sendo um item do menu para o teclado.
  const colorMenu = useCallback((session, anchor) => {
    const dark = isDark();
    const items = [
      { id: 'default', label: 'Sem cor', icon: swatch('transparent'), hint: !session.color ? 'atual' : undefined, run: () => setSessionColor(session.id, null) },
      { separator: true },
      {
        id: 'colors',
        swatches: SESSION_COLORS.map((color) => ({
          id: color.id,
          label: color.label,
          color: dark ? color.dark : color.light,
          current: session.color === color.id,
          run: () => setSessionColor(session.id, color.id),
        })),
      },
    ];
    setMenu({ anchor, items });
  }, []);

  const sessionMenu = useCallback((session, anchor) => {
    const items = [
      { id: 'rename', label: 'Renomear sessão', icon: TextCursorInput, run: () => setRenamingId(session.id) },
      { id: 'subtitle', label: session.subtitle ? 'Editar subtítulo…' : 'Definir subtítulo…', icon: Tag, run: () => setNameRequest({ kind: 'subtitle', sessionId: session.id, title: 'Subtítulo da sessão', description: 'Para que serve esta sessão. Aparece sob o nome e entra na busca.', initial: session.subtitle, placeholder: 'Servidor de desenvolvimento', confirmLabel: 'Salvar' }) },
      { id: 'color', label: 'Cor da sessão…', icon: Palette, run: () => setTimeout(() => colorMenu(session, anchor), 0) },
      { id: 'pin', label: session.pinned ? 'Desafixar do topo' : 'Fixar no topo', icon: session.pinned ? PinOff : Pin, run: () => togglePinned(session.id) },
      { id: 'up', label: 'Mover para cima', icon: ArrowUp, hint: '⌥↑', disabled: !canMoveSession(session.id, -1), run: () => moveSessionBy(session.id, -1) },
      { id: 'down', label: 'Mover para baixo', icon: ArrowDown, hint: '⌥↓', disabled: !canMoveSession(session.id, 1), run: () => moveSessionBy(session.id, 1) },
      { separator: true },
      { id: 'browser', label: 'Abrir Dev Browser', icon: Globe, hint: '⇧⌘B', run: () => openBrowserTab(session.id) },
      session.browser?.status === 'ready' || session.browser?.status === 'starting'
        ? { id: 'browser-stop', label: 'Encerrar Dev Browser', icon: Globe, run: () => stopBrowser(session.id).catch(() => {}) }
        : null,
      { separator: true },
      { id: 'copy', label: 'Copiar caminho', icon: Copy, run: async () => { const ok = await copyToClipboard(session.cwd); notify(ok ? 'Caminho copiado' : 'Não foi possível copiar', ok ? 'success' : 'warning'); } },
      { id: 'finder', label: 'Abrir pasta no Finder', icon: FolderOpen, run: () => fs.reveal(session.cwd).catch((error) => notify(error.message, 'warning')) },
      { id: 'clone', label: 'Nova sessão neste diretório', icon: Plus, run: () => openSession(session.cwd) },
      { id: 'dir', label: 'Trocar pasta…', icon: FolderSearch, run: () => changeDirectory(session.id).catch((error) => notify(error.message, 'warning')) },
      { separator: true },
      { id: 'restart', label: 'Reiniciar terminal', icon: RotateCcw, run: () => restart(session.id) },
      { id: 'close', label: 'Encerrar sessão', icon: Power, danger: true, run: () => requestCloseSession(session) },
    ];
    setMenu({ anchor, items });
  }, [notify, requestCloseSession, colorMenu]);

  const onSelect = useCallback((id) => {
    selectSession(id);
    clearAttention(id);
    setTimeout(focusSelected, 30);
  }, []);
  const onRename = useCallback((session) => setRenamingId(session.id), []);
  const onRenameDone = useCallback((value) => {
    setRenamingId((current) => {
      if (current && value !== null) renameSession(current, value);
      return null;
    });
    setTimeout(focusSelected, 30);
  }, []);

  const reopenAll = useCallback(() => {
    orderedSessions().filter((session) => session.status === 'disconnected').forEach((session) => reopen(session.id));
  }, []);

  /* ── abas ────────────────────────────────────────────────────────── */

  const doClose = useCallback((tab) => {
    const session = tab.session;
    if (!session) return;
    closeTab(session.id, tab);
    setTimeout(() => { if (!getSession(session.id)?.editor.tabs.length) focusSelected(); }, 30);
  }, []);

  const requestCloseTab = useCallback((tab, { force: forced = false } = {}) => {
    if (!tab.dirty || forced) { doClose(tab); return; }
    setUnsavedRequest({ tab, name: tab.name });
  }, [doClose]);

  const saveWithConflict = useCallback(async (tab, after) => {
    try {
      // Uma aba temporaria abre o painel de salvar; fechar o painel sem
      // escolher devolve false e nada acontece.
      if (!await saveTab(tab)) return;
      notify(`${tab.name} salvo`, 'success');
      after?.();
    } catch (error) {
      if (error?.code === 'conflict' || tab.conflict) setConflictRequest({ tab, name: tab.name, conflict: tab.conflict || 'disk-changed', after });
      else notify(error?.message || String(error), 'warning');
    }
  }, [notify]);

  // Acoes do editor num objeto estavel: o painel e memoizado e so redesenha
  // nos eventos de editor da propria sessao.
  const editorActions = useMemo(() => ({
    activate: (tab) => { if (tab.session) activateTab(tab.session.id, tab.id); setEditorFocusKey((value) => value + 1); },
    close: requestCloseTab,
    setMode: (tab, mode) => setTabMode(tab, mode),
    togglePreview: (tab) => { if (isPreviewable(tab.kind)) setTabMode(tab, tab.mode === 'preview' ? 'edit' : 'preview'); },
    refreshPreview: (tab) => refreshPreview(tab),
    reload: (tab) => reloadTab(tab).catch((error) => notify(error?.message || String(error), 'warning')),
    keepConflict: (tab) => { tab.conflict = null; setTabMode(tab, tab.mode); },
    saveAgain: (tab) => saveTab(tab, { force: true }).then(() => notify(`${tab.name} salvo`, 'success')).catch((error) => notify(error?.message || String(error), 'warning')),
    openDefault: (tab) => fs.openDefault(tab.path).catch((error) => notify(error.message, 'warning')),
    reveal: (tab) => fs.reveal(tab.path).catch((error) => notify(error.message, 'warning')),
    reconvert: (tab) => reconvertTab(tab).catch((error) => notify(error?.message || String(error), 'warning')),
    viewAsPdf: (tab) => viewAsPdf(tab).catch((error) => notify(error?.message || String(error), 'warning')),
  }), [requestCloseTab, notify]);

  // ⌘W fecha o que esta mais por dentro: a aba ativa do editor enquanto
  // houver abas, e so depois a sessao, com a confirmacao que couber.
  const closeShortcut = useCallback(() => {
    if (!selected) return false;
    if (activeTab) { requestCloseTab(activeTab); return true; }
    requestCloseSession(selected);
    return true;
  }, [selected, activeTab, requestCloseTab, requestCloseSession]);
  closeShortcutRef.current = closeShortcut;

  const openInEditor = useCallback((path) => {
    const current = getState().selected;
    if (!current) return;
    openFile(current.id, path).then(() => setEditorFocusKey((value) => value + 1)).catch((error) => notify(error?.message || String(error), 'warning'));
  }, [notify]);

  /* ── atalhos e teclas do terminal ────────────────────────────────── */

  useEffect(() => {
    if (!selected) return undefined;
    // Shift+Enter com um programa em primeiro plano vira quebra de linha: o
    // avanco de linha de Ctrl+J, que Claude Code, Codex e Gemini CLI tratam
    // como quebra dentro da mensagem. No prompt do shell continua sendo
    // Enter. O xterm recebe keydown, keypress e keyup da mesma tecla, e no
    // keypress mandaria um CR por conta propria: os tres ficam com ele
    // bloqueados.
    const isShiftEnter = (event) => event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
    const handled = (event) => {
      if (!event.metaKey || event.ctrlKey || event.altKey) return false;
      const key = event.key.toLowerCase();
      if (key === 'f' && !event.shiftKey) return true;
      if (key === 'p' && !event.shiftKey) return true;
      if (key === 'n' && !event.shiftKey) return true;
      if ((key === '=' || key === '+' || key === '-' || key === '0') && !event.shiftKey) return true;
      if (event.shiftKey && (key === 'e' || key === 'j' || key === 'b' || key === '[' || key === ']')) return true;
      return false;
    };
    // ⌘⌫ apaga a linha inteira, o mesmo que o editor faz: no shell isso e o
    // kill-whole-line do zsh, em Ctrl+U.
    const isDeleteLine = (event) => event.key === 'Backspace' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    selected.term.attachCustomKeyEventHandler((event) => {
      if (isShiftEnter(event)) {
        if (!selected.activity?.foreground) return true;
        if (event.type === 'keydown') insertText(selected.id, '\n');
        return false;
      }
      if (isDeleteLine(event)) {
        if (event.type === 'keydown') insertText(selected.id, '\x15');
        return false;
      }
      return !(event.type === 'keydown' && handled(event));
    });
    return () => { try { selected.term.attachCustomKeyEventHandler(() => true); } catch (_error) { /* descartado */ } };
  }, [selected]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (!event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      const inTerminal = isTerminalFocused();
      if (event.shiftKey) {
        if (key === 'e') { event.preventDefault(); setLayout({ explorerCollapsed: !layout.explorerCollapsed }); return; }
        if (key === 'j') { event.preventDefault(); setLayout({ sessionsCollapsed: !layout.sessionsCollapsed }); return; }
        if (key === 'b') { event.preventDefault(); if (selected) openBrowserTab(selected.id); return; }
        if (key === ']') { event.preventDefault(); selectNext(1); return; }
        if (key === '[') { event.preventDefault(); selectNext(-1); return; }
        return;
      }
      if (key === 'p' && selected && selected.status !== 'disconnected') { event.preventDefault(); setQuickOpen(true); return; }
      if (!inTerminal) return;
      if (key === 'f') { event.preventDefault(); setFindOpen(true); return; }
      if (key === '=' || key === '+') { event.preventDefault(); setLayout({ fontSize: Math.min(LAYOUT_LIMITS.fontSize.max, layout.fontSize + 1) }); return; }
      if (key === '-') { event.preventDefault(); setLayout({ fontSize: Math.max(LAYOUT_LIMITS.fontSize.min, layout.fontSize - 1) }); return; }
      if (key === '0') { event.preventDefault(); setLayout({ fontSize: LAYOUT_LIMITS.fontSize.default }); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [layout, selected]);

  /* ── paleta de comandos ──────────────────────────────────────────── */

  useEffect(() => registerPaletteProvider(() => {
    const items = [
      { id: 'terminais:new', kind: 'Sessões', label: 'Nova sessão', shortcut: '⌘T', icon: Plus, run: () => openPickerRef.current?.() },
      { id: 'terminais:new-file', kind: 'Estúdio', label: 'Novo arquivo temporário', shortcut: '⌘N', icon: FilePlus2, run: () => newFileRef.current?.() },
    ];
    orderedSessions().forEach((session) => {
      const state = describe(session);
      items.push({ id: `terminais:go:${session.id}`, kind: 'Sessões', label: `Ir para ${session.name}${session.subtitle ? `, ${session.subtitle}` : ''}`, hint: state.label, icon: SquareTerminal, run: () => { shell.navigate('terminais'); selectSession(session.id); setTimeout(focusSelected, 80); } });
    });
    if (sessionsNeedingAttention().length) {
      items.push({ id: 'terminais:attention', kind: 'Sessões', label: 'Ir para a próxima sessão que pede atenção', icon: Bell, run: () => { shell.navigate('terminais'); selectNextAttention(); } });
    }
    getRecent().slice(0, 6).forEach((path) => {
      items.push({ id: `terminais:recent:${path}`, kind: 'Recentes', label: `Reabrir ${baseName(path)}`, hint: shortPath(path), icon: FolderOpen, run: () => { shell.navigate('terminais'); openSession(path); } });
    });
    const current = getState().selected;
    if (current && current.status !== 'disconnected') {
      items.push({ id: 'terminais:file', kind: 'Estúdio', label: 'Buscar arquivo no projeto', shortcut: '⌘P', icon: FileSearch, run: () => { shell.navigate('terminais'); setTimeout(() => setQuickOpen(true), 60); } });
    }
    items.push({ id: 'terminais:explorer', kind: 'Estúdio', label: layout.explorerCollapsed ? 'Mostrar explorador de arquivos' : 'Ocultar explorador de arquivos', shortcut: '⇧⌘E', icon: Files, run: () => setLayout({ explorerCollapsed: !layout.explorerCollapsed }) });
    items.push({ id: 'terminais:sessions', kind: 'Estúdio', label: layout.sessionsCollapsed ? 'Mostrar coluna de sessões' : 'Ocultar coluna de sessões', shortcut: '⇧⌘J', icon: PanelLeft, run: () => setLayout({ sessionsCollapsed: !layout.sessionsCollapsed }) });
    items.push({ id: 'terminais:focus', kind: 'Estúdio', label: layout.focus ? 'Sair do modo foco' : 'Modo foco', icon: Maximize2, run: toggleFocus });
    if (current) items.push({ id: 'terminais:restart', kind: 'Estúdio', label: `Reiniciar terminal de ${current.name}`, icon: RotateCcw, run: () => restart(current.id) });
    if (current && current.status !== 'disconnected') {
      items.push({ id: 'terminais:browser', kind: 'Estúdio', label: `Abrir o Dev Browser de ${current.name}`, shortcut: '⇧⌘B', icon: Globe, run: () => { shell.navigate('terminais'); openBrowserTab(current.id); } });
      if (current.browser?.status === 'ready') {
        items.push({ id: 'terminais:browser-port', kind: 'Estúdio', label: `Copiar a porta do Dev Browser, ${current.browser.info?.port || ''}`, icon: Copy, run: () => copyPort(current.id) });
        items.push({ id: 'terminais:browser-stop', kind: 'Estúdio', label: `Encerrar o Dev Browser de ${current.name}`, icon: Power, run: () => stopBrowser(current.id).catch(() => {}) });
      }
    }
    return items;
  }), [layout.explorerCollapsed, layout.sessionsCollapsed, layout.focus, toggleFocus]);

  /* ── layout ──────────────────────────────────────────────────────── */

  const sessionsCollapsed = layout.sessionsCollapsed || layout.focus || auto.sessions;
  const explorerCollapsed = layout.explorerCollapsed || layout.focus || auto.explorer;

  const dragSessions = useCallback((delta) => {
    const root = rootRef.current;
    if (!root) return;
    if (delta === null) { const width = parseFloat(root.style.getPropertyValue('--terminais-sessions')) || layout.sessionsWidth; setLayout({ sessionsWidth: width }); return; }
    const next = Math.min(LAYOUT_LIMITS.sessions.max, Math.max(LAYOUT_LIMITS.sessions.min, layout.sessionsWidth + delta));
    root.style.setProperty('--terminais-sessions', `${next}px`);
  }, [layout.sessionsWidth]);

  const dragExplorer = useCallback((delta) => {
    const root = rootRef.current;
    if (!root) return;
    if (delta === null) { const width = parseFloat(root.style.getPropertyValue('--terminais-explorer')) || layout.explorerWidth; setLayout({ explorerWidth: width }); return; }
    const next = Math.min(LAYOUT_LIMITS.explorer.max, Math.max(LAYOUT_LIMITS.explorer.min, layout.explorerWidth - delta));
    root.style.setProperty('--terminais-explorer', `${next}px`);
  }, [layout.explorerWidth]);

  /* ── acoes do explorador ─────────────────────────────────────────── */

  const insertPath = useCallback((path) => {
    const current = getState().selected;
    if (!current) return;
    const ok = insertPaths(current.id, [path]);
    if (!ok) notify('O terminal desta sessão não está aberto', 'warning');
  }, [notify]);

  const openDiffFor = useCallback((root, path) => {
    const current = getState().selected;
    if (!current) return;
    openDiff(current.id, root, path).catch((error) => notify(error?.message || String(error), 'warning'));
  }, [notify]);

  const newSessionAt = useCallback((path) => { openSession(path); }, []);

  const confirmDelete = useCallback(async () => {
    const request = deleteRequest;
    setDeleteRequest(null);
    if (!request) return;
    try {
      await fs.trash(request.path);
      orderedSessions().forEach((session) => {
        session.editor.tabs.filter((tab) => tab.path && (tab.path === request.path || tab.path.startsWith(`${request.path}/`))).forEach((tab) => closeTab(session.id, tab));
      });
      notify(`${request.name} foi para a Lixeira`, 'success');
    } catch (error) {
      notify(error?.message || String(error), 'warning');
    }
  }, [deleteRequest, notify]);

  /* ── render ──────────────────────────────────────────────────────── */

  const toolbar = (
    <ToolbarSlot>
      <button ref={newButtonRef} type="button" className="mac-tool" onClick={openPicker} disabled={!native} title="Abrir uma sessão numa pasta, ⌘T">
        <Plus size={15} strokeWidth={1.75} />
        <span>Nova sessão</span>
      </button>
    </ToolbarSlot>
  );

  const pickerNode = picker ? (
    <NewSessionPopover
      anchor={picker}
      onClose={() => setPicker(null)}
      onPick={(path, name) => { setPicker(null); openSession(path, { name }); }}
      onBrowse={(name) => { setPicker(null); pickAndOpen(undefined, { name }).catch((error) => notify(String(error?.message || error), 'warning')); }}
    />
  ) : null;

  if (!hydrated) return <div className="view active terminais-page" id="view-terminais" ref={rootRef}>{toolbar}</div>;

  if (sessions.length === 0) {
    const recent = getRecent().slice(0, 6);
    return (
      <div className="view active page terminais-page terminais-page--empty" id="view-terminais" ref={rootRef}>
        {toolbar}
        <section className="page-empty terminais-empty" aria-labelledby="terminais-empty-title">
          <SquareTerminal strokeWidth={1.75} aria-hidden="true" />
          <h2 className="page-empty__title" id="terminais-empty-title">Nenhuma sessão aberta</h2>
          <p className="page-empty__text">
            {native
              ? 'Abra uma sessão numa pasta de projeto. Cada sessão tem o próprio terminal, os arquivos do projeto e um card para acompanhar o que está rodando.'
              : NATIVE_ONLY_MESSAGE}
          </p>
          {native ? <div className="terminais-empty__actions"><button type="button" className="btn btn-primary" onClick={openPicker}><Plus size={14} strokeWidth={2} />Nova sessão</button><button type="button" className="btn btn-secondary" onClick={() => window.dispatchEvent(new CustomEvent('cialai:pair-device'))}>Vincular celular</button></div> : null}
          {native && recent.length ? (
            <div className="terminais-empty__recent">
              {recent.map((path) => (
                <button key={path} type="button" className="btn btn-ghost btn-sm" onClick={() => openSession(path)} title={shortPath(path)}>
                  <FolderOpen size={13} /><span>{baseName(path)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </section>
        {pickerNode}
      </div>
    );
  }

  const classes = ['view', 'active', 'terminais-page'];
  if (sessionsCollapsed) classes.push('is-sessions-collapsed');
  if (explorerCollapsed) classes.push('is-explorer-collapsed');
  if (layout.focus) classes.push('is-focus');
  const attention = sessionsNeedingAttention().length;
  const disconnected = sessions.filter((session) => session.status === 'disconnected').length;

  return (
    <div
      className={classes.join(' ')}
      id="view-terminais"
      ref={rootRef}
      style={{ '--terminais-sessions': `${layout.sessionsWidth}px`, '--terminais-explorer': `${layout.explorerWidth}px` }}
    >
      {toolbar}
      {!sessionsCollapsed ? (
        <>
          <SessionsPane
            sessions={sessions}
            selectedId={selectedId}
            onSelect={onSelect}
            onNew={openPicker}
            onMenu={sessionMenu}
            renamingId={renamingId}
            onRename={onRename}
            onRenameDone={onRenameDone}
            attentionCount={attention}
            onJumpAttention={selectNextAttention}
            disconnectedCount={disconnected}
            onReopenAll={reopenAll}
            onCollapse={() => setLayout({ sessionsCollapsed: true })}
          />
          <Splitter orientation="vertical" label="Largura das sessões" onDrag={dragSessions} onReset={() => setLayout({ sessionsWidth: LAYOUT_LIMITS.sessions.default })} onStep={(step) => setLayout({ sessionsWidth: layout.sessionsWidth + step })} />
        </>
      ) : (
        <div className="terminais-edge terminais-edge--left">
          <button type="button" className="terminais-edge__btn" onClick={() => { setLayout({ sessionsCollapsed: false, focus: false }); if (layout.focus) toggleFocus(); }} aria-label="Mostrar sessões" title="Mostrar sessões, ⇧⌘J"><ChevronRight size={12} strokeWidth={2} /></button>
        </div>
      )}
      {selected ? (
        <WorkArea
          key={selected.id}
          session={selected}
          layout={layout}
          tabs={tabs}
          activeTab={activeTab}
          editorActions={editorActions}
          onCloseSession={requestCloseSession}
          onChangeDir={(session) => changeDirectory(session.id).catch((error) => notify(error.message, 'warning'))}
          onToggleFocus={toggleFocus}
          findOpen={findOpen}
          onFindOpen={() => setFindOpen(true)}
          onFindClose={() => { setFindOpen(false); focusSelected(); }}
          editorFocusKey={editorFocusKey}
          notify={notify}
        />
      ) : <section className="terminais-work" />}
      {!explorerCollapsed && selected ? (
        <>
          <Splitter orientation="vertical" label="Largura do explorador" onDrag={dragExplorer} onReset={() => setLayout({ explorerWidth: LAYOUT_LIMITS.explorer.default })} onStep={(step) => setLayout({ explorerWidth: layout.explorerWidth - step })} />
          <ExplorerPane
            key={`${selected.id}:${selected.explorer.root}`}
            session={selected}
            onOpenFile={openInEditor}
            onOpenDiff={openDiffFor}
            onNewSessionAt={newSessionAt}
            onInsertPath={insertPath}
            onDeleteRequest={setDeleteRequest}
            notify={notify}
            revealRequest={revealRequest}
            onCollapse={() => setLayout({ explorerCollapsed: true })}
          />
        </>
      ) : (
        <div className="terminais-edge terminais-edge--right">
          <button type="button" className="terminais-edge__btn" onClick={() => { setLayout({ explorerCollapsed: false }); if (layout.focus) toggleFocus(); }} aria-label="Mostrar arquivos" title="Mostrar arquivos, ⇧⌘E"><ChevronLeft size={12} strokeWidth={2} /></button>
        </div>
      )}
      {pickerNode}
      {menu ? <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} label="Ações da sessão" /> : null}
      {quickOpen && selected ? (
        <QuickOpen
          root={selected.explorer.root}
          onClose={() => { setQuickOpen(false); setTimeout(focusSelected, 30); }}
          onOpenFile={openInEditor}
          onRevealDir={(path) => { setLayout({ explorerCollapsed: false }); setRevealRequest({ sessionId: selected.id, path, at: Date.now() }); }}
        />
      ) : null}
      <CloseSessionDialog
        request={closeRequest}
        onCancel={() => setCloseRequest(null)}
        onConfirm={() => { const id = closeRequest?.id; setCloseRequest(null); if (id) closeSession(id); }}
      />
      <UnsavedDialog
        request={unsavedRequest}
        onCancel={() => setUnsavedRequest(null)}
        onDiscard={() => { const tab = unsavedRequest?.tab; setUnsavedRequest(null); if (tab) doClose(tab); }}
        onSave={() => { const tab = unsavedRequest?.tab; setUnsavedRequest(null); if (tab) saveWithConflict(tab, () => doClose(tab)); }}
      />
      <ConflictDialog
        request={conflictRequest}
        onCancel={() => setConflictRequest(null)}
        onReload={() => { const { tab, after } = conflictRequest || {}; setConflictRequest(null); if (tab) reloadTab(tab).then(() => after?.()).catch((error) => notify(error?.message || String(error), 'warning')); }}
        onOverwrite={() => { const { tab, after } = conflictRequest || {}; setConflictRequest(null); if (tab) saveTab(tab, { force: true }).then(() => { notify(`${tab.name} salvo`, 'success'); after?.(); }).catch((error) => notify(error?.message || String(error), 'warning')); }}
      />
      <DeleteDialog request={deleteRequest} onCancel={() => setDeleteRequest(null)} onConfirm={confirmDelete} />
      <NameDialog
        request={nameRequest}
        onCancel={() => setNameRequest(null)}
        onConfirm={(value) => {
          const request = nameRequest;
          setNameRequest(null);
          if (request?.kind === 'subtitle') setSessionSubtitle(request.sessionId, value);
        }}
      />
    </div>
  );
}
