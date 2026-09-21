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
  ArrowDown, ArrowUp, Bell, Copy, FileSearch, Files, FolderOpen, FolderSearch, Globe, Maximize2, Palette, PanelLeft, PanelLeftOpen, PanelRightOpen, Pin, PinOff,
  FilePlus2, Network, Plus, Power, RotateCcw, SquareTerminal, Tag, TextCursorInput, UserRound,
} from 'lucide-react';
import { AppModal, useToast } from '../../components/ui.jsx';
import { hasBridge, invoke } from '../../lib/native.js';
import { copyToClipboard } from '../../lib/helpers.js';
import { registerPaletteProvider } from '../../desktop/palette-registry.js';
import { shell } from '../../desktop/shell-bridge.js';
import {
  SESSION_COLORS, activateTab, canMoveSession, changeDirectory, clearAttention, closeSession, describe, focusSelected, getRecent, getSession,
  getState, hydrate, insertPaths, insertText, isDemo, localizeDemo, moveSessionBy, onCloseRequest, onNewFileRequest, onNewTerminalRequest, openSession, orderedSessions, pasteText, pickAndOpen,
  renameSession, reopen, restart, runningLabel, selectNext, selectNextAttention, selectSession, sessionsNeedingAttention,
  setSessionColor, setSessionSubtitle, subscribe, togglePinned, viewMounted,
} from '../runtime.js';
import { closeTab, installEditorWatch, newUntitled, openDiff, openFile, reconvertTab, refreshPreview, reloadTab, restoreTabs, saveTab, setTabMode, viewAsPdf } from '../editor.js';
import { copyPort, openBrowserTab, reconcileBrowsers, stopBrowser } from '../browser/runtime.js';
import { closeDocGraphPreview, docGraphTabId, openDocGraphPreview, openDocGraphTab } from '../docgraph/tab.js';
import { STRINGS as DOCGRAPH } from '../docgraph/copy.js';
import { LAYOUT_LIMITS, setLayout, useLayout } from '../layout.js';
import { INITIAL_PANELS, choosePanel, panelCollapsed, resizePanels } from '../panels.js';
import { baseName, fs, isPreviewable, shortPath } from '../files.js';
import { useRuntimeEvents } from '../hooks.js';
import AgentProfiles from './AgentProfiles.jsx';
import SessionsPane from './SessionsPane.jsx';
import WorkArea, { ToolbarSlot } from './WorkArea.jsx';
import ExplorerPane from './ExplorerPane.jsx';
import Splitter from './Splitter.jsx';
import Menu from './Menu.jsx';
import NewSessionPopover from './NewSessionPopover.jsx';
import QuickOpen from './QuickOpen.jsx';
import { CloseSessionDialog, ConflictDialog, DeleteDialog, NameDialog, UnsavedDialog } from './dialogs.jsx';
import { isShortcut, isTerminalFocused, shortcutLabel } from '../../lib/keys.js';
import { isTerminalAppShortcut, terminalEditAction, workbenchShortcutAction } from '../shortcut-actions.js';
import { getLocale, translate, useI18n } from '../../shared/i18n.js';

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
  const { locale } = useI18n();
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
  // Contas dos agentes com porta propria no estudio, fora de Configuracoes.
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [revealRequest, setRevealRequest] = useState(null);
  const [editorFocusKey, setEditorFocusKey] = useState(0);
  const [auto, setAuto] = useState(INITIAL_PANELS);
  const rootRef = useRef(null);
  const newButtonRef = useRef(null);
  const focusRestore = useRef(null);
  const sessionsCollapsed = panelCollapsed(auto, 'sessions', { preferred: layout.sessionsCollapsed, focus: layout.focus });
  const explorerCollapsed = panelCollapsed(auto, 'explorer', { preferred: layout.explorerCollapsed, focus: layout.focus });
  // Mostrar ou esconder uma coluna grava a preferencia e, em janela estreita,
  // vence o recolhimento automatico. Na primeira vez que cada coluna recolhe,
  // um aviso diz onde reabri-la: `display: none` some com a lista inteira, e
  // sem isso o caminho de volta fica invisivel.
  const showPanel = (panel, visible, patch = {}) => {
    const noticed = panel === 'sessions' ? 'noticedSessions' : 'noticedExplorer';
    const firstTime = !visible && !layout[noticed];
    setLayout({ [`${panel}Collapsed`]: !visible, ...(firstTime ? { [noticed]: true } : {}), ...patch });
    setAuto((current) => choosePanel(current, panel, visible));
    if (firstTime) {
      notify(translate(panel === 'sessions' ? 'terminal.work.sessionsHidden' : 'terminal.work.filesHidden', {
        shortcut: shortcutLabel(panel === 'sessions' ? 'Mod+Shift+J' : 'Mod+Shift+E'),
      }), 'info');
    }
  };
  // `showPanel` nasce de novo a cada desenho; o ref deixa as acoes por
  // caminho chamarem a versao atual sem entrar na lista de dependencias e
  // desestabilizar `editorActions`, que o painel memoizado compara.
  const showPanelRef = useRef(showPanel);
  showPanelRef.current = showPanel;
  const native = hasBridge() || isDemo();

  const { selected, hydrated } = getState();
  const sessions = orderedSessions();
  const selectedId = selected?.id || null;
  const tabs = selected ? selected.editor.tabs : [];
  const activeTab = selected ? tabs.find((tab) => tab.id === selected.editor.activeId) || null : null;

  /* ── ciclo de vida ───────────────────────────────────────────────── */

  const openPicker = useCallback(() => {
    if (!native) { notify(translate('terminal.common.desktopOnly'), 'warning'); return; }
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
    if (!current) { notify(translate('terminal.session.openOneFirst'), 'info'); openPickerRef.current?.(); return; }
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
    const restoring = selected && selected.editor.restoreTabs?.length
      ? restoreTabs(selected.id).catch(() => {})
      : Promise.resolve();
    // A aba do browser volta parada, com a ultima URL, sem lancar o Chromium.
    if (selected && selected.browser?.restoreOpen) {
      selected.browser.restoreOpen = false;
      openBrowserTab(selected.id, { start: false });
    }
    // A aba do grafo volta depois das abas de arquivo, para nao virar a
    // primeira da lista, e so fica ativa se era a ativa.
    if (selected && selected.docgraph?.restoreOpen) {
      selected.docgraph.restoreOpen = false;
      const session = selected;
      const graphWasActive = session.editor.activeId === docGraphTabId(session.id);
      restoring.then(() => {
        if (!getSession(session.id)) return;
        const orphan = !session.editor.tabs.some((tab) => tab.id === session.editor.activeId);
        openDocGraphTab(session.id, { activate: graphWasActive || orphan });
      });
    }
  }, [selectedId]);

  useEffect(() => { setFindOpen(false); }, [selectedId]);

  useEffect(() => { localizeDemo(); }, [locale]);

  // Recolhimento automatico em janelas estreitas.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width || root.clientWidth;
      setAuto((current) => resizePanels(current, width));
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
    setCloseRequest({ id: session.id, name: session.name, running: busy ? (running?.text || translate('terminal.session.processFallback')) : null, dirtyTabs: dirty });
  }, []);

  // Grade de amostras: com dezoito tons a lista vertical ficaria maior que
  // a janela. Cada amostra continua sendo um item do menu para o teclado.
  const colorMenu = useCallback((session, anchor) => {
    const dark = isDark();
    const items = [
      { id: 'default', label: translate('terminal.menu.noColor'), icon: swatch('transparent'), hint: !session.color ? translate('terminal.common.current') : undefined, run: () => setSessionColor(session.id, null) },
      { separator: true },
      {
        id: 'colors',
        swatches: SESSION_COLORS.map((color) => ({
          id: color.id,
          label: translate(`terminal.color.${color.id}`),
          color: dark ? color.dark : color.light,
          current: session.color === color.id,
          run: () => setSessionColor(session.id, color.id),
        })),
      },
    ];
    setMenu({ anchor, items });
  }, []);

  // Submenu com as contas do agente. Um terminal ja aberto nao muda de
  // ambiente, entao trocar de conta nele e abrir o agente com as variaveis na
  // propria linha, o que so vale com o shell no prompt.
  const launchMenu = useCallback(async (session, anchor) => {
    let profiles = [];
    try {
      profiles = await invoke('agent_profiles') || [];
    } catch (error) {
      notify(error.message, 'warning');
      return;
    }
    if (!profiles.length) { notify(translate('terminal.profiles.none'), 'warning'); return; }
    setMenu({
      anchor,
      items: profiles.map((profile) => ({
        id: `launch:${profile.id}`,
        label: translate('terminal.profiles.launchAs', { agent: translate(`terminal.profiles.agent.${profile.agent}`), profile: profile.label }),
        icon: UserRound,
        run: () => invoke('pty_launch_agent', { id: session.ptyId, agent: profile.agent, profile: profile.id })
          .catch((error) => notify(error.message, 'warning')),
      })),
    });
  }, [notify]);

  const sessionMenu = useCallback((session, anchor) => {
    const items = [
      { id: 'rename', label: translate('terminal.menu.renameSession'), icon: TextCursorInput, run: () => setRenamingId(session.id) },
      { id: 'subtitle', label: translate(session.subtitle ? 'terminal.menu.editSubtitle' : 'terminal.menu.setSubtitle'), icon: Tag, run: () => setNameRequest({ kind: 'subtitle', sessionId: session.id, title: translate('terminal.menu.subtitleTitle'), description: translate('terminal.menu.subtitleDescription'), initial: session.subtitle, placeholder: translate('terminal.menu.subtitlePlaceholder'), confirmLabel: translate('terminal.common.save') }) },
      { id: 'color', label: translate('terminal.menu.sessionColor'), icon: Palette, run: () => setTimeout(() => colorMenu(session, anchor), 0) },
      { id: 'pin', label: translate(session.pinned ? 'terminal.menu.unpin' : 'terminal.menu.pin'), icon: session.pinned ? PinOff : Pin, run: () => togglePinned(session.id) },
      { id: 'up', label: translate('terminal.menu.moveUp'), icon: ArrowUp, hint: shortcutLabel('Alt+ArrowUp'), disabled: !canMoveSession(session.id, -1), run: () => moveSessionBy(session.id, -1) },
      { id: 'down', label: translate('terminal.menu.moveDown'), icon: ArrowDown, hint: shortcutLabel('Alt+ArrowDown'), disabled: !canMoveSession(session.id, 1), run: () => moveSessionBy(session.id, 1) },
      { separator: true },
      { id: 'browser', label: translate('terminal.browser.openDevBrowser'), icon: Globe, hint: shortcutLabel('Mod+Shift+B'), run: () => openBrowserTab(session.id) },
      session.browser?.status === 'ready' || session.browser?.status === 'starting'
        ? { id: 'browser-stop', label: translate('terminal.browser.stopDevBrowser'), icon: Globe, run: () => stopBrowser(session.id).catch(() => {}) }
        : null,
      { separator: true },
      { id: 'copy', label: translate('terminal.explorer.copyPath'), icon: Copy, run: async () => { const ok = await copyToClipboard(session.cwd); notify(translate(ok ? 'terminal.common.pathCopied' : 'terminal.common.copyFailed'), ok ? 'success' : 'warning'); } },
      { id: 'finder', label: translate('terminal.menu.openFolder'), icon: FolderOpen, run: () => fs.reveal(session.cwd).catch((error) => notify(error.message, 'warning')) },
      { id: 'clone', label: translate('terminal.menu.newSessionDirectory'), icon: Plus, run: () => openSession(session.cwd) },
      {
        id: 'launch',
        label: translate('terminal.profiles.launchHere'),
        icon: UserRound,
        disabled: session.status !== 'running' || Boolean(session.activity?.foreground),
        hint: session.activity?.foreground ? translate('terminal.profiles.launchBusy') : undefined,
        run: () => setTimeout(() => launchMenu(session, anchor), 0),
      },
      { id: 'dir', label: translate('terminal.menu.changeFolder'), icon: FolderSearch, run: () => changeDirectory(session.id).catch((error) => notify(error.message, 'warning')) },
      { separator: true },
      { id: 'restart', label: translate('terminal.menu.restartTerminal'), icon: RotateCcw, run: () => restart(session.id) },
      { id: 'close', label: translate('terminal.menu.closeSession'), icon: Power, danger: true, run: () => requestCloseSession(session) },
    ];
    setMenu({ anchor, items });
  }, [notify, requestCloseSession, colorMenu, launchMenu]);

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
      notify(translate('terminal.session.saved', { name: tab.name }), 'success');
      after?.();
    } catch (error) {
      if (error?.code === 'conflict' || tab.conflict) setConflictRequest({ tab, name: tab.name, conflict: tab.conflict || 'disk-changed', after });
      else notify(error?.message || String(error), 'warning');
    }
  }, [notify]);

  // Acoes por caminho, e nao por aba: o grafo da documentacao trabalha com o
  // caminho do documento e nao tem aba por tras. Sem elas, `Abrir no editor`,
  // `Visualizar` e `Revelar no explorador` do grafo caiam em
  // `actions.openPath is not a function`.
  const openPath = useCallback((path) => {
    const current = getState().selected;
    if (!current || !path) return;
    openFile(current.id, path).then(() => setEditorFocusKey((value) => value + 1)).catch((error) => notify(error?.message || String(error), 'warning'));
  }, [notify]);

  const previewPath = useCallback((path) => {
    const current = getState().selected;
    if (!current || !path) return;
    openDocGraphPreview(current.id, path);
  }, []);

  const revealPathInExplorer = useCallback((path) => {
    const current = getState().selected;
    if (!current || !path) return;
    showPanelRef.current?.('explorer', true);
    setRevealRequest({ sessionId: current.id, path, at: Date.now() });
  }, []);

  // Janela separada do documento, quando o app nativo pode abrir uma. A
  // divisao interna fecha junto: a area volta inteira para o grafo, e
  // `Visualizar` de novo traz a divisao de volta.
  const detachPreview = useCallback((path) => {
    const current = getState().selected;
    if (!current || !path) return;
    invoke('doc_preview_window', { path })
      .then(() => closeDocGraphPreview(current.id))
      .catch((error) => notify(error?.message || String(error), 'warning'));
  }, [notify]);

  // Acoes do editor num objeto estavel: o painel e memoizado e so redesenha
  // nos eventos de editor da propria sessao.
  const editorActions = useMemo(() => ({
    openPath,
    previewPath,
    revealInExplorer: revealPathInExplorer,
    detachPreview: hasBridge() ? detachPreview : undefined,
    activate: (tab) => { if (tab.session) activateTab(tab.session.id, tab.id); setEditorFocusKey((value) => value + 1); },
    close: requestCloseTab,
    setMode: (tab, mode) => setTabMode(tab, mode),
    togglePreview: (tab) => { if (isPreviewable(tab.kind)) setTabMode(tab, tab.mode === 'preview' ? 'edit' : 'preview'); },
    refreshPreview: (tab) => refreshPreview(tab),
    reload: (tab) => reloadTab(tab).catch((error) => notify(error?.message || String(error), 'warning')),
    keepConflict: (tab) => { tab.conflict = null; setTabMode(tab, tab.mode); },
    saveAgain: (tab) => saveTab(tab, { force: true }).then(() => notify(translate('terminal.session.saved', { name: tab.name }), 'success')).catch((error) => notify(error?.message || String(error), 'warning')),
    openDefault: (tab) => fs.openDefault(tab.path).catch((error) => notify(error.message, 'warning')),
    reveal: (tab) => fs.reveal(tab.path).catch((error) => notify(error.message, 'warning')),
    reconvert: (tab) => reconvertTab(tab).catch((error) => notify(error?.message || String(error), 'warning')),
    viewAsPdf: (tab) => viewAsPdf(tab).catch((error) => notify(error?.message || String(error), 'warning')),
  }), [requestCloseTab, notify, openPath, previewPath, revealPathInExplorer, detachPreview]);

  // ⌘W fecha o que esta mais por dentro: a aba ativa do editor enquanto
  // houver abas, e so depois a sessao, com a confirmacao que couber.
  const closeShortcut = useCallback(() => {
    if (!selected) return false;
    if (activeTab) { requestCloseTab(activeTab); return true; }
    requestCloseSession(selected);
    return true;
  }, [selected, activeTab, requestCloseTab, requestCloseSession]);
  closeShortcutRef.current = closeShortcut;

  // Conta nova de um agente: a pasta nasce vazia e o login e feito pelo
  // proprio programa, num terminal ja aberto naquele perfil. O Cialai nunca
  // toca em credencial. E o mesmo caminho do celular.
  const createAgentProfile = useCallback(async (request, name) => {
    try {
      const id = await invoke('agent_profile_create', { agent: request.agent, name });
      request.reload?.();
      notify(translate('terminal.profiles.created', { name }), 'success');
      const current = getState().selected;
      if (current?.ptyId != null) await invoke('pty_launch_agent', { id: current.ptyId, agent: request.agent, profile: id });
    } catch (error) {
      notify(error?.message || String(error), 'warning');
    }
  }, [notify]);

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
    const copyTerminalSelection = () => {
      const text = selected.term.getSelection();
      if (!text) { notify(translate('terminal.common.nothingSelected'), 'info'); return; }
      copyToClipboard(text).then((ok) => notify(translate(ok ? 'terminal.common.selectionCopied' : 'terminal.common.copyFailed'), ok ? 'success' : 'warning'));
    };
    const pasteTerminalClipboard = () => {
      if (!navigator.clipboard?.readText) { notify(translate('terminal.common.pasteFailed'), 'warning'); return; }
      navigator.clipboard.readText()
        .then((text) => { if (text) pasteText(selected.id, text); })
        .catch(() => notify(translate('terminal.common.pasteFailed'), 'warning'));
    };
    selected.term.attachCustomKeyEventHandler((event) => {
      if (isShiftEnter(event)) {
        if (!selected.activity?.foreground) return true;
        if (event.type === 'keydown') insertText(selected.id, '\n');
        return false;
      }
      const editAction = terminalEditAction(event);
      if (editAction) {
        if (event.type === 'keydown') {
          event.preventDefault?.();
          if (editAction === 'copy') copyTerminalSelection();
          else if (editAction === 'paste') pasteTerminalClipboard();
          else insertText(selected.id, '\x15');
        }
        return false;
      }
      return !(event.type === 'keydown' && isTerminalAppShortcut(event));
    });
    return () => { try { selected.term.attachCustomKeyEventHandler(() => true); } catch (_error) { /* descartado */ } };
  }, [selected, notify]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const inTerminal = isTerminalFocused();
      const action = workbenchShortcutAction(event, { inTerminal });
      if (!action) return;
      if (action === 'quick-open' && (!selected || selected.status === 'disconnected')) return;
      if (!inTerminal && ['find', 'font-increase', 'font-decrease', 'font-reset'].includes(action)) return;
      if (action === 'open-browser' && !selected) return;
      event.preventDefault();
      if (action === 'toggle-explorer') showPanel('explorer', explorerCollapsed);
      else if (action === 'toggle-sessions') showPanel('sessions', sessionsCollapsed);
      else if (action === 'open-browser') openBrowserTab(selected.id);
      else if (action === 'next-session') selectNext(1);
      else if (action === 'previous-session') selectNext(-1);
      else if (action === 'quick-open') setQuickOpen(true);
      else if (action === 'find') setFindOpen(true);
      else if (action === 'font-increase') setLayout({ fontSize: Math.min(LAYOUT_LIMITS.fontSize.max, layout.fontSize + 1) });
      else if (action === 'font-decrease') setLayout({ fontSize: Math.max(LAYOUT_LIMITS.fontSize.min, layout.fontSize - 1) });
      else if (action === 'font-reset') setLayout({ fontSize: LAYOUT_LIMITS.fontSize.default });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [layout, selected, explorerCollapsed, sessionsCollapsed]);

  // Mod Shift D abre o grafo da documentacao. Na fase de captura e parando a
  // propagacao: o CodeMirror, sem atalho proprio para ela, cairia no `Mod-d`
  // dele e selecionaria a proxima ocorrencia junto.
  const openDocGraph = useCallback(() => {
    const current = getState().selected;
    if (!current) { notify(DOCGRAPH.needSession, 'info'); openPickerRef.current?.(); return; }
    openDocGraphTab(current.id);
  }, [notify]);
  const openDocGraphRef = useRef(openDocGraph);
  openDocGraphRef.current = openDocGraph;
  useEffect(() => {
    const onKeyDown = (event) => {
      if (!isShortcut(event, 'Mod+Shift+D')) return;
      event.preventDefault();
      event.stopPropagation();
      openDocGraphRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  /* ── paleta de comandos ──────────────────────────────────────────── */

  useEffect(() => registerPaletteProvider(() => {
    const items = [
      { id: 'terminais:new', kind: translate('terminal.palette.sessions'), label: translate('terminal.session.new'), shortcut: shortcutLabel('Mod+T'), icon: Plus, run: () => openPickerRef.current?.() },
      { id: 'terminais:new-file', kind: translate('terminal.palette.studio'), label: translate('terminal.palette.newTemporaryFile'), shortcut: shortcutLabel('Mod+N'), icon: FilePlus2, run: () => newFileRef.current?.() },
    ];
    orderedSessions().forEach((session) => {
      const state = describe(session);
      items.push({ id: `terminais:go:${session.id}`, kind: translate('terminal.palette.sessions'), label: translate(session.subtitle ? 'terminal.palette.goToSubtitle' : 'terminal.palette.goTo', { name: session.name, subtitle: session.subtitle }), hint: state.label, icon: SquareTerminal, run: () => { shell.navigate('terminais'); selectSession(session.id); setTimeout(focusSelected, 80); } });
    });
    if (sessionsNeedingAttention().length) {
      items.push({ id: 'terminais:attention', kind: translate('terminal.palette.sessions'), label: translate('terminal.session.attentionNext'), icon: Bell, run: () => { shell.navigate('terminais'); selectNextAttention(); } });
    }
    getRecent().slice(0, 6).forEach((path) => {
      items.push({ id: `terminais:recent:${path}`, kind: translate('terminal.palette.recent'), label: translate('terminal.palette.reopen', { name: baseName(path) }), hint: shortPath(path), icon: FolderOpen, run: () => { shell.navigate('terminais'); openSession(path); } });
    });
    const current = getState().selected;
    if (current && current.status !== 'disconnected') {
      items.push({ id: 'terminais:file', kind: translate('terminal.palette.studio'), label: translate('terminal.palette.findProjectFile'), shortcut: shortcutLabel('Mod+P'), icon: FileSearch, run: () => { shell.navigate('terminais'); setTimeout(() => setQuickOpen(true), 60); } });
    }
    items.push({ id: 'terminais:explorer', kind: translate('terminal.palette.studio'), label: translate(explorerCollapsed ? 'terminal.palette.showExplorer' : 'terminal.palette.hideExplorer'), shortcut: shortcutLabel('Mod+Shift+E'), icon: Files, run: () => showPanel('explorer', explorerCollapsed) });
    if (current) items.push({ id: 'terminais:docgraph', kind: translate('terminal.palette.studio'), label: translate('terminal.palette.openDocGraph', { name: current.name }), shortcut: shortcutLabel('Mod+Shift+D'), icon: Network, run: () => { shell.navigate('terminais'); openDocGraphTab(current.id); } });
    items.push({ id: 'terminais:sessions', kind: translate('terminal.palette.studio'), label: translate(sessionsCollapsed ? 'terminal.palette.showSessions' : 'terminal.palette.hideSessions'), shortcut: shortcutLabel('Mod+Shift+J'), icon: PanelLeft, run: () => showPanel('sessions', sessionsCollapsed) });
    items.push({ id: 'terminais:focus', kind: translate('terminal.palette.studio'), label: translate(layout.focus ? 'terminal.work.exitFocus' : 'terminal.work.focusMode'), icon: Maximize2, run: toggleFocus });
    if (current) items.push({ id: 'terminais:restart', kind: translate('terminal.palette.studio'), label: translate('terminal.palette.restartNamed', { name: current.name }), icon: RotateCcw, run: () => restart(current.id) });
    if (current && current.status !== 'disconnected') {
      items.push({ id: 'terminais:browser', kind: translate('terminal.palette.studio'), label: translate('terminal.browser.openForSession', { name: current.name }), shortcut: shortcutLabel('Mod+Shift+B'), icon: Globe, run: () => { shell.navigate('terminais'); openBrowserTab(current.id); } });
      if (current.browser?.status === 'ready') {
        items.push({ id: 'terminais:browser-port', kind: translate('terminal.palette.studio'), label: translate('terminal.browser.copyPort', { port: current.browser.info?.port || '' }), icon: Copy, run: () => copyPort(current.id) });
        items.push({ id: 'terminais:browser-stop', kind: translate('terminal.palette.studio'), label: translate('terminal.browser.stopForSession', { name: current.name }), icon: Power, run: () => stopBrowser(current.id).catch(() => {}) });
      }
    }
    return items;
  }), [explorerCollapsed, sessionsCollapsed, layout.focus, toggleFocus, locale]);

  /* ── layout ──────────────────────────────────────────────────────── */

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
    if (!ok) notify(translate('terminal.session.terminalClosed'), 'warning');
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
      notify(translate('terminal.session.trashed', { name: request.name }), 'success');
    } catch (error) {
      notify(error?.message || String(error), 'warning');
    }
  }, [deleteRequest, notify]);

  /* ── render ──────────────────────────────────────────────────────── */

  const toolbar = (
    <ToolbarSlot>
      <button ref={newButtonRef} type="button" className="mac-tool" onClick={openPicker} disabled={!native} title={translate('terminal.session.openFolderShortcut', { shortcut: shortcutLabel('Mod+T') })}>
        <Plus size={15} strokeWidth={1.75} />
        <span>{translate('terminal.session.new')}</span>
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
          <h2 className="page-empty__title" id="terminais-empty-title">{translate('terminal.session.noneOpen')}</h2>
          <p className="page-empty__text">
            {native
              ? translate('terminal.session.emptyDescription')
              : translate('terminal.common.desktopOnly')}
          </p>
          {native ? <div className="terminais-empty__actions"><button type="button" className="btn btn-primary" onClick={openPicker}><Plus size={14} strokeWidth={2} />{translate('terminal.session.new')}</button><button type="button" className="btn btn-secondary" onClick={() => window.dispatchEvent(new CustomEvent('cialai:pair-device'))}>{translate('terminal.session.pairPhone')}</button></div> : null}
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
  // Resumo do que a coluna de arquivos esconde quando recolhida.
  const gitChanges = selected?.explorer?.git?.changes?.length || 0;

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
            onAccounts={native ? () => setAccountsOpen(true) : null}
          />
          <Splitter orientation="vertical" label={translate('terminal.work.sessionsWidth')} onDrag={dragSessions} onReset={() => setLayout({ sessionsWidth: LAYOUT_LIMITS.sessions.default })} onStep={(step) => setLayout({ sessionsWidth: layout.sessionsWidth + step })} />
        </>
      ) : (
        <button
          type="button"
          className="terminais-edge terminais-edge--left"
          onClick={() => { showPanel('sessions', true, { focus: false }); if (layout.focus) toggleFocus(); }}
          aria-label={translate('terminal.work.showSessions')}
          aria-expanded={false}
          aria-controls="terminais-sessions"
          title={translate('terminal.work.showSessionsShortcut', { shortcut: shortcutLabel('Mod+Shift+J') })}
        >
          <PanelLeftOpen size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="terminais-edge__summary">
            <span className="terminais-edge__count">{sessions.length.toLocaleString(getLocale())}</span>
            {attention ? <span className="terminais-edge__badge">{attention.toLocaleString(getLocale())}</span> : null}
          </span>
        </button>
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
          panels={{
            sessionsCollapsed,
            explorerCollapsed,
            onToggleSessions: () => showPanel('sessions', sessionsCollapsed, { focus: false }),
            onToggleExplorer: () => showPanel('explorer', explorerCollapsed),
          }}
          findOpen={findOpen}
          onFindClose={() => { setFindOpen(false); focusSelected(); }}
          editorFocusKey={editorFocusKey}
        />
      ) : <section className="terminais-work" />}
      {!explorerCollapsed && selected ? (
        <>
          <Splitter orientation="vertical" label={translate('terminal.work.explorerWidth')} onDrag={dragExplorer} onReset={() => setLayout({ explorerWidth: LAYOUT_LIMITS.explorer.default })} onStep={(step) => setLayout({ explorerWidth: layout.explorerWidth - step })} />
          <ExplorerPane
            key={`${selected.id}:${selected.explorer.root}`}
            session={selected}
            onOpenFile={openInEditor}
            onOpenDiff={openDiffFor}
            onNewSessionAt={newSessionAt}
            onShowInGraph={(path) => openDocGraphTab(selected.id, { focusPath: path })}
            onInsertPath={insertPath}
            onDeleteRequest={setDeleteRequest}
            notify={notify}
            revealRequest={revealRequest}
          />
        </>
      ) : (
        <button
          type="button"
          className="terminais-edge terminais-edge--right"
          onClick={() => { showPanel('explorer', true); if (layout.focus) toggleFocus(); }}
          aria-label={translate('terminal.work.showFiles')}
          aria-expanded={false}
          aria-controls="terminais-explorer"
          title={translate('terminal.work.showFilesShortcut', { shortcut: shortcutLabel('Mod+Shift+E') })}
        >
          <PanelRightOpen size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="terminais-edge__summary">
            {gitChanges ? <span className="terminais-edge__count">{gitChanges.toLocaleString(getLocale())}</span> : null}
          </span>
        </button>
      )}
      {pickerNode}
      {menu ? <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} label={translate('terminal.menu.sessionActions')} /> : null}
      {quickOpen && selected ? (
        <QuickOpen
          root={selected.explorer.root}
          onClose={() => { setQuickOpen(false); setTimeout(focusSelected, 30); }}
          onOpenFile={openInEditor}
          onRevealDir={(path) => { showPanel('explorer', true); setRevealRequest({ sessionId: selected.id, path, at: Date.now() }); }}
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
        onOverwrite={() => { const { tab, after } = conflictRequest || {}; setConflictRequest(null); if (tab) saveTab(tab, { force: true }).then(() => { notify(translate('terminal.session.saved', { name: tab.name }), 'success'); after?.(); }).catch((error) => notify(error?.message || String(error), 'warning')); }}
      />
      <DeleteDialog request={deleteRequest} onCancel={() => setDeleteRequest(null)} onConfirm={confirmDelete} />
      <NameDialog
        request={nameRequest}
        onCancel={() => setNameRequest(null)}
        onConfirm={(value) => {
          const request = nameRequest;
          setNameRequest(null);
          if (request?.kind === 'subtitle') { setSessionSubtitle(request.sessionId, value); return; }
          if (request?.kind === 'profile') createAgentProfile(request, value);
        }}
      />
      <AppModal
        open={accountsOpen}
        title={translate('terminal.profiles.title')}
        onClose={() => setAccountsOpen(false)}
        maxWidth="md"
        footer={<button type="button" className="btn btn-quiet" onClick={() => setAccountsOpen(false)}>{translate('terminal.common.close')}</button>}
      >
        <AgentProfiles
          onCreate={(agent, reload) => setNameRequest({
            kind: 'profile',
            agent,
            reload,
            title: translate('terminal.profiles.createTitle'),
            description: translate('terminal.profiles.createDescription'),
            required: true,
            confirmLabel: translate('terminal.profiles.create'),
          })}
        />
      </AppModal>
    </div>
  );
}
