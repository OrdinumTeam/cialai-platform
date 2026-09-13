// SPDX-License-Identifier: Apache-2.0
// Area central: cabecalho da sessao com nome, subtitulo, pasta e branch, o
// editor com abas quando ha arquivos abertos e o terminal real da sessao.
// O terminal e adotado do runtime, nunca recriado; a divisao com o editor
// tem altura ajustavel e qualquer um dos dois pode ser maximizado.
//
// O cabecalho assina so a atividade e o explorador da sessao exibida. O
// painel do editor e memoizado e recebe as acoes num objeto estavel.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown, ChevronDown, ChevronUp, Copy, Eye, EyeOff, GitBranch, Globe, Maximize2, Minimize2, Minus, PanelBottomClose, PanelTopClose, Plus, RotateCcw, Search, X,
} from 'lucide-react';
import EditorPane from './EditorPane.jsx';
import Splitter from './Splitter.jsx';
import { accentStyle } from './SessionCard.jsx';
import { describe, fitAndResize, hostTerminal, insertPaths, isWorking, releaseTerminal, reopen, runningLabel, setEditorRatio, setMaximized } from '../runtime.js';
import { swapIn } from '../motion.js';
import { LAYOUT_LIMITS, getLayout, setLayout } from '../layout.js';
import { fs, isPreviewable, shortPath } from '../files.js';
import { openFile } from '../editor.js';
import { inside, onDrag as subscribeDrag } from '../drag.js';
import { onNativeDragDrop } from '../../lib/native.js';
import { copyToClipboard } from '../../lib/helpers.js';
import { useRuntimeEvents } from '../hooks.js';
import { openBrowserTab } from '../browser/runtime.js';
import { shortcutLabel } from '../../lib/keys.js';

function exitLabel(session) {
  const base = session.signal
    ? `Sessão encerrada por ${session.signal}`
    : `Processo finalizado, código ${session.exitCode}`;
  return session.early ? `${base}. O shell saiu logo após abrir. Confira o .zshrc` : base;
}

function FindBar({ session, onClose }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 20);
    return () => { clearTimeout(timer); session.search.clearDecorations(); };
  }, [session]);
  const options = { incremental: true, decorations: { matchOverviewRuler: 'var(--mac-warn)', activeMatchColorOverviewRuler: 'var(--mac-accent)', matchBackground: 'var(--terminais-editor-search)', activeMatchBackground: 'var(--mac-accent-soft-hover)' } };
  const next = () => { if (query) session.search.findNext(query, options); };
  const previous = () => { if (query) session.search.findPrevious(query, options); };
  useEffect(() => { if (query) session.search.findNext(query, options); else session.search.clearDecorations(); }, [query]);
  return (
    <div className="terminais-find" role="search">
      <Search size={13} strokeWidth={2} aria-hidden="true" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Buscar na saída"
        aria-label="Buscar na saída do terminal"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); if (event.shiftKey) previous(); else next(); }
          if (event.key === 'Escape') { event.preventDefault(); onClose(); }
        }}
      />
      <button type="button" className="terminais-pane__tool" onClick={previous} aria-label="Anterior" title="Anterior, ⇧Enter"><ChevronUp size={13} strokeWidth={2} /></button>
      <button type="button" className="terminais-pane__tool" onClick={next} aria-label="Próximo" title="Próximo, Enter"><ChevronDown size={13} strokeWidth={2} /></button>
      <button type="button" className="terminais-pane__tool" onClick={onClose} aria-label="Fechar busca" title="Fechar, Esc"><X size={13} strokeWidth={2} /></button>
    </div>
  );
}

// Sessao que o app perdeu ao fechar. Com o historico restaurado, o aviso vai
// para a barra do pe do terminal, para o historico continuar legivel; sem
// historico, ocupa o centro. Quando um agente rodava, Reabrir o retoma.
function DisconnectedNotice({ session }) {
  const resume = session.saved?.resume || null;
  const action = resume ? `Reabrir e retomar ${resume.agent}` : `Abrir shell em ${shortPath(session.cwd)}`;
  if (session.saved?.historyBytes > 0) {
    return (
      <div className="terminais-terminal__end" role="status">
        <span>{resume ? `Histórico restaurado. ${resume.agent} volta à mesma conversa.` : 'Histórico restaurado. O shell anterior foi encerrado quando o app fechou.'}</span>
        <span className="terminais-terminal__end-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => reopen(session.id)}><RotateCcw size={12} />{action}</button>
        </span>
      </div>
    );
  }
  return (
    <div className="terminais-terminal__disconnected">
      <strong>Sessão desconectada</strong>
      <span>{resume ? `O shell anterior foi encerrado quando o app fechou. ${resume.agent} volta à mesma conversa ao reabrir.` : 'O shell anterior não sobreviveu ao reinício do app. Nada foi executado de novo.'}</span>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => reopen(session.id)}>{action}</button>
    </div>
  );
}

function TerminalPane({ session, onCloseSession, onChangeDir, findOpen, onFindClose }) {
  const paneRef = useRef(null);
  const hostRef = useRef(null);
  const [atBottom, setAtBottom] = useState(true);
  const [dropping, setDropping] = useState(false);

  // Arraste vindo do explorador: o caminho e inserido no terminal, sem
  // executar nada. O destino e decidido pelo ponto do cursor, porque o
  // drag-and-drop do HTML nao chega a pagina dentro do app.
  useEffect(() => subscribeDrag((event) => {
    if (event.kind && event.kind !== 'path') return;
    if (event.type === 'end' || event.type === 'cancel') { setDropping(false); return; }
    const over = session.status === 'running' && inside(paneRef.current, event.x, event.y);
    if (event.type === 'move') { setDropping(over); return; }
    if (event.type === 'drop') {
      setDropping(false);
      if (over) insertPaths(session.id, [event.path]);
    }
  }), [session]);

  useEffect(() => {
    let disposed = false;
    let unlisten;
    setDropping(false);
    onNativeDragDrop((event) => {
      if (disposed) return;
      const pane = paneRef.current;
      // elementFromPoint tambem exclui paineis ocultos e modais sobrepostos.
      // A posicao ja chega em pontos CSS, normalizada em native.js.
      const target = event.position && document.elementFromPoint(event.position.x, event.position.y);
      const inside = session.status === 'running' && target && pane?.contains(target);
      setDropping(Boolean(inside && (event.type === 'enter' || event.type === 'over')));
      if (event.type === 'drop' && inside) insertPaths(session.id, event.paths || []);
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    }).catch((error) => console.error('[terminais] Arraste nativo indisponível:', error));
    return () => { disposed = true; unlisten?.(); };
  }, [session]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    hostTerminal(session.id, host);
    const observer = new ResizeObserver(() => fitAndResize(session.id));
    observer.observe(host);
    const term = session.term;
    const update = () => {
      const buffer = term.buffer.active;
      const bottom = buffer.viewportY >= buffer.baseY;
      setAtBottom((current) => (current === bottom ? current : bottom));
    };
    const scroll = term.onScroll(update);
    const parsed = term.onWriteParsed(update);
    update();
    return () => {
      observer.disconnect();
      scroll.dispose();
      parsed.dispose();
      releaseTerminal(session.id);
    };
  }, [session]);

  const ended = session.status === 'exited';
  const failed = session.status === 'error';
  const disconnected = session.status === 'disconnected';

  return (
    <div
      ref={paneRef}
      className={`terminais-terminal${dropping ? ' is-dropping' : ''}`}
    >
      <div className="terminais-terminal__host" ref={hostRef} />
      {findOpen ? <FindBar session={session} onClose={onFindClose} /> : null}
      {!atBottom && !disconnected ? (
        <button type="button" className="terminais-terminal__tobottom" onClick={() => { session.term.scrollToBottom(); session.term.focus(); }}>
          <ArrowDown size={12} strokeWidth={2} aria-hidden="true" />
          Ir para o fim
        </button>
      ) : null}
      {dropping ? <div className="terminais-terminal__drop">Soltar para inserir o caminho</div> : null}
      {ended ? (
        <div className="terminais-terminal__end" role="status">
          <span>{exitLabel(session)}</span>
          <span className="terminais-terminal__end-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => reopen(session.id)}><RotateCcw size={12} />Reabrir</button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => onCloseSession(session)}>Encerrar sessão</button>
          </span>
        </div>
      ) : null}
      {failed ? (
        <div className="terminais-terminal__end" role="alert">
          <span>{session.error}</span>
          <span className="terminais-terminal__end-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChangeDir(session)}>Trocar pasta</button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => onCloseSession(session)}>Encerrar sessão</button>
          </span>
        </div>
      ) : null}
      {disconnected ? <DisconnectedNotice session={session} /> : null}
    </div>
  );
}

export default function WorkArea({
  session, layout, tabs, activeTab, editorActions, onCloseSession, onChangeDir, onToggleFocus, findOpen, onFindOpen, onFindClose,
  editorFocusKey, notify,
}) {
  useRuntimeEvents(['activity', 'explorer', 'browser'], session.id);
  const bodyRef = useRef(null);
  const sectionRef = useRef(null);
  // Outra sessao no centro: o conteudo surge de novo, sem remontar nada.
  useEffect(() => { swapIn(sectionRef.current, { y: 6 }); }, [session.id]);
  const ratio = session.editor.ratio ?? layout.editorRatio;
  const maximized = session.editor.maximized;
  const hasTabs = tabs.length > 0;
  const status = describe(session);
  const running = runningLabel(session);
  const working = isWorking(session);
  const gitStatus = session.explorer.git;
  const previewable = activeTab && isPreviewable(activeTab.kind);
  const previewing = previewable && activeTab.mode === 'preview';

  const onDrag = useCallback((delta, event) => {
    const body = bodyRef.current;
    if (!body) return;
    if (delta === null) { setEditorRatio(session.id, session.editor.ratio ?? layout.editorRatio); setLayout({ editorRatio: session.editor.ratio ?? layout.editorRatio }); return; }
    const rect = body.getBoundingClientRect();
    const next = Math.min(LAYOUT_LIMITS.editorRatio.max, Math.max(LAYOUT_LIMITS.editorRatio.min, (event.clientY - rect.top) / rect.height));
    session.editor.ratio = next;
    body.style.setProperty('--terminais-ratio', String(next));
  }, [session, layout.editorRatio]);

  const copySelection = async () => {
    const text = session.term.getSelection();
    if (!text) { notify('Nada selecionado no terminal', 'info'); return; }
    const ok = await copyToClipboard(text);
    notify(ok ? 'Seleção copiada' : 'Não foi possível copiar', ok ? 'success' : 'warning');
    session.term.focus();
  };
  const changeFont = (delta) => {
    const current = getLayout().fontSize;
    setLayout({ fontSize: Math.min(LAYOUT_LIMITS.fontSize.max, Math.max(LAYOUT_LIMITS.fontSize.min, current + delta)) });
  };

  const showEditor = hasTabs && maximized !== 'terminal';
  const showTerminal = !hasTabs || maximized !== 'editor';

  // Soltar um arquivo sobre o editor abre ele numa aba, venha do explorador
  // ou do Finder. Pastas nao entram: o editor nao tem o que fazer com elas.
  const [editorDrop, setEditorDrop] = useState(false);
  const editorAt = useCallback((x, y) => {
    const editor = bodyRef.current?.querySelector('.terminais-editor');
    const node = document.elementFromPoint(x, y);
    return Boolean(editor && node && editor.contains(node));
  }, []);
  // `onDrag` aqui e o do divisor; a assinatura do arraste vem pelo alias.
  useEffect(() => subscribeDrag((event) => {
    if (event.kind && event.kind !== 'path') return;
    if (event.type === 'end' || event.type === 'cancel') { setEditorDrop(false); return; }
    const over = !event.dir && editorAt(event.x, event.y);
    if (event.type === 'move') { setEditorDrop(over); return; }
    if (event.type === 'drop') {
      setEditorDrop(false);
      if (over) openFile(session.id, event.path).catch(() => {});
    }
  }), [session, editorAt]);
  useEffect(() => {
    let disposed = false;
    let unlisten;
    setEditorDrop(false);
    const openDropped = async (paths) => {
      for (const path of paths) {
        const stat = await fs.stat(path).catch(() => null);
        if (stat?.exists && stat.kind !== 'dir') await openFile(session.id, path).catch(() => {});
      }
    };
    onNativeDragDrop((event) => {
      if (disposed) return;
      const over = Boolean(event.position && editorAt(event.position.x, event.position.y));
      setEditorDrop(over && (event.type === 'enter' || event.type === 'over'));
      if (event.type === 'drop' && over) openDropped(event.paths || []);
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    }).catch((error) => console.error('[terminais] Arraste nativo indisponível:', error));
    return () => { disposed = true; unlisten?.(); };
  }, [session, editorAt]);
  const browserOn = session.browser?.status === 'ready' || session.browser?.status === 'starting';
  const browserActive = activeTab?.kind === 'browser';

  return (
    <section className="terminais-work" ref={sectionRef} aria-label={`Sessão ${session.name}`} style={accentStyle(session)}>
      <header className="terminais-work__head">
        <span className={`dot terminais-work__dot terminais-work__dot--${status.tone}${working ? ' is-working' : ''}`} aria-hidden="true" />
        <span className="terminais-work__name">{session.name}</span>
        {session.subtitle ? <span className="terminais-work__subtitle">{session.subtitle}</span> : null}
        <span className="terminais-work__path" title={session.cwd}>{shortPath(session.activity?.shellCwd || session.cwd)}</span>
        {gitStatus?.isRepo ? (
          <span className="terminais-work__branch" title={gitStatus.changes?.length ? `${gitStatus.changes.length} ${gitStatus.changes.length === 1 ? 'arquivo alterado' : 'arquivos alterados'}` : 'Sem alterações'}>
            <GitBranch size={12} strokeWidth={2} aria-hidden="true" />
            {gitStatus.detached ? 'HEAD solto' : gitStatus.branch}
            {gitStatus.changes?.length ? <em>{gitStatus.changes.length}</em> : null}
          </span>
        ) : null}
        {running ? <span className={`terminais-work__running${running.agent ? ' is-agent' : ''}`}>{running.text}</span> : null}
        <span className="terminais-pane__spacer" />
        <div className="terminais-work__actions">
          <button type="button" className={`terminais-pane__tool${browserOn || browserActive ? ' is-on' : ''}`} onClick={() => openBrowserTab(session.id)} aria-pressed={browserActive} title={browserOn ? `Dev Browser desta sessão, aberto. ${shortcutLabel('Mod+Shift+B')}` : `Abrir o Dev Browser desta sessão, ${shortcutLabel('Mod+Shift+B')}`} aria-label="Dev Browser"><Globe size={14} strokeWidth={1.75} /></button>
          {previewable ? (
            <button type="button" className={`terminais-pane__tool${previewing ? ' is-on' : ''}`} onClick={() => editorActions.togglePreview(activeTab)} aria-pressed={previewing} title={previewing ? 'Voltar ao código' : (activeTab.kind === 'html' ? 'Visualizar o HTML' : activeTab.kind === 'csv' ? 'Visualizar como tabela' : 'Visualizar o Markdown')} aria-label="Visualizar">{previewing ? <EyeOff size={14} strokeWidth={1.75} /> : <Eye size={14} strokeWidth={1.75} />}</button>
          ) : null}
          {hasTabs ? (
            <>
              <button type="button" className={`terminais-pane__tool${maximized === 'editor' ? ' is-on' : ''}`} onClick={() => setMaximized(session.id, 'editor')} aria-pressed={maximized === 'editor'} title={maximized === 'editor' ? 'Voltar à divisão' : 'Maximizar o editor'} aria-label="Maximizar o editor"><PanelBottomClose size={14} strokeWidth={1.75} /></button>
              <button type="button" className={`terminais-pane__tool${maximized === 'terminal' ? ' is-on' : ''}`} onClick={() => setMaximized(session.id, 'terminal')} aria-pressed={maximized === 'terminal'} title={maximized === 'terminal' ? 'Voltar à divisão' : 'Maximizar o terminal'} aria-label="Maximizar o terminal"><PanelTopClose size={14} strokeWidth={1.75} /></button>
              <span className="terminais-work__sep" aria-hidden="true" />
            </>
          ) : null}
          <button type="button" className={`terminais-pane__tool${findOpen ? ' is-on' : ''}`} onClick={findOpen ? onFindClose : onFindOpen} aria-pressed={findOpen} title={`Buscar na saída, ${shortcutLabel('Mod+F')}`} aria-label="Buscar na saída"><Search size={14} strokeWidth={1.75} /></button>
          <button type="button" className="terminais-pane__tool" onClick={copySelection} title="Copiar seleção do terminal" aria-label="Copiar seleção"><Copy size={14} strokeWidth={1.75} /></button>
          <button type="button" className="terminais-pane__tool" onClick={() => changeFont(-1)} title={`Diminuir fonte, ${shortcutLabel('Mod+Minus')}`} aria-label="Diminuir fonte"><Minus size={14} strokeWidth={1.75} /></button>
          <span className="terminais-work__font" aria-live="polite">{layout.fontSize}</span>
          <button type="button" className="terminais-pane__tool" onClick={() => changeFont(1)} title={`Aumentar fonte, ${shortcutLabel('Mod+Equal')}`} aria-label="Aumentar fonte"><Plus size={14} strokeWidth={1.75} /></button>
          <span className="terminais-work__sep" aria-hidden="true" />
          <button type="button" className={`terminais-pane__tool${layout.focus ? ' is-on' : ''}`} onClick={onToggleFocus} aria-pressed={layout.focus} title={layout.focus ? 'Sair do modo foco' : 'Modo foco'} aria-label="Modo foco">{layout.focus ? <Minimize2 size={14} strokeWidth={1.75} /> : <Maximize2 size={14} strokeWidth={1.75} />}</button>
        </div>
      </header>
      <div
        className={`terminais-work__body${showEditor && showTerminal ? ' is-split' : ''}${showEditor && !showTerminal ? ' is-editor-only' : ''}`}
        ref={bodyRef}
        style={{ '--terminais-ratio': ratio }}
      >
        {showEditor ? (
          <EditorPane session={session} tabs={tabs} activeTab={activeTab} actions={editorActions} focusKey={editorFocusKey} dropping={editorDrop} />
        ) : null}
        {showEditor && showTerminal ? (
          <Splitter
            orientation="horizontal"
            label="Altura do editor"
            onDrag={onDrag}
            onReset={() => { session.editor.ratio = LAYOUT_LIMITS.editorRatio.default; setEditorRatio(session.id, LAYOUT_LIMITS.editorRatio.default); }}
            onStep={(step) => { const next = Math.min(LAYOUT_LIMITS.editorRatio.max, Math.max(LAYOUT_LIMITS.editorRatio.min, ratio + step / 600)); setEditorRatio(session.id, next); }}
          />
        ) : null}
        {showTerminal ? (
          <TerminalPane
            session={session}
            onCloseSession={onCloseSession}
            onChangeDir={onChangeDir}
            findOpen={findOpen}
            onFindClose={onFindClose}
          />
        ) : null}
      </div>
    </section>
  );
}

// Botao da toolbar da casca, por portal no slot de acoes da secao.
export function ToolbarSlot({ children }) {
  const [slot, setSlot] = useState(null);
  useEffect(() => { setSlot(document.getElementById('mac-toolbar-slot')); }, []);
  return slot ? createPortal(children, slot) : null;
}
