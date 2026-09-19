// SPDX-License-Identifier: Apache-2.0
// Coluna de sessoes: cabecalho compacto com contagem e botao de nova
// sessao, busca por nome, subtitulo ou pasta, e os cards empilhados com
// rolagem propria. Reordenar por arraste so vale sem filtro, para a busca
// nao mexer na ordem manual. Os handlers sao estaveis para os cards, que
// sao memoizados, so redesenharem quando a propria sessao muda.
//
// O arraste dos cards usa o mesmo arraste por ponteiro do explorador,
// `drag.js`: dentro do app o drag-and-drop do HTML nunca chega a pagina. O
// destino e decidido pelo ponto do cursor, antes ou depois do card pela
// metade da altura, e abaixo do ultimo card e o fim do grupo.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, PanelLeftClose, Plus, RotateCcw, Search, UserRound, X } from 'lucide-react';
import SessionCard from './SessionCard.jsx';
import { deliverPaths, moveSession, moveSessionBy } from '../runtime.js';
import { beginDrag, inside, onDrag } from '../drag.js';
import { shortPath } from '../files.js';
import { onNativeDragDrop } from '../../lib/native.js';
import { shortcutLabel } from '../../lib/keys.js';
import { getLocale, translate, useI18n } from '../../shared/i18n.js';

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function sameTarget(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.edge === b.edge && Boolean(a.end) === Boolean(b.end);
}

export default function SessionsPane({
  sessions, selectedId, onSelect, onNew, onMenu, renamingId, onRename, onRenameDone, attentionCount,
  onJumpAttention, disconnectedCount, onReopenAll, onAccounts, onCollapse,
}) {
  useI18n();
  const [query, setQuery] = useState('');
  const [drag, setDrag] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [pathTarget, setPathTarget] = useState(null);
  const listRef = useRef(null);
  const stateRef = useRef({ filtering: false, sessions });

  const filtering = query.trim().length > 0;
  stateRef.current = { filtering, sessions };

  const filtered = useMemo(() => {
    const needle = normalize(query.trim());
    if (!needle) return sessions;
    return sessions.filter((session) => normalize(session.name).includes(needle)
      || normalize(session.subtitle).includes(needle)
      || normalize(shortPath(session.cwd)).includes(needle));
  }, [sessions, query]);

  // Comeca no mousedown do card; so vira arraste depois de alguns pixels,
  // entao clicar continua selecionando.
  const onDragStart = useCallback((event, session) => {
    if (stateRef.current.filtering) return;
    beginDrag(event, { kind: 'session', id: session.id, label: session.name });
  }, []);

  // Card sob o cursor e a borda mais proxima. Um destino so vale dentro do
  // grupo do card arrastado, fixadas ou nao, que e a regra de `moveSession`.
  const targetAt = useCallback((event) => {
    const list = listRef.current;
    if (!list || !inside(list, event.x, event.y)) return null;
    const dragged = stateRef.current.sessions.find((session) => session.id === event.id);
    if (!dragged) return null;
    const node = document.elementFromPoint(event.x, event.y)?.closest?.('[data-session-id]');
    if (!node) {
      const last = stateRef.current.sessions.filter((session) => session.pinned === dragged.pinned).at(-1);
      return last && last.id !== dragged.id ? { end: true } : null;
    }
    const id = node.getAttribute('data-session-id');
    const target = stateRef.current.sessions.find((session) => session.id === id);
    if (!target || target.id === dragged.id || target.pinned !== dragged.pinned) return null;
    const rect = node.getBoundingClientRect();
    return { id, edge: event.y < rect.top + rect.height / 2 ? 'before' : 'after' };
  }, []);

  useEffect(() => onDrag((event) => {
    if (event.kind !== 'session') return;
    if (event.type === 'end' || event.type === 'cancel') { setDrag(null); setDropTarget(null); return; }
    const target = targetAt(event);
    if (event.type === 'move') {
      setDrag(event.id);
      setDropTarget((current) => (sameTarget(current, target) ? current : target));
      return;
    }
    if (event.type !== 'drop') return;
    setDrag(null);
    setDropTarget(null);
    if (!target) return;
    if (target.end) { moveSession(event.id, null); return; }
    if (target.edge === 'before') { moveSession(event.id, target.id); return; }
    // Depois do alvo: antes do card seguinte do mesmo grupo, senao no fim.
    const ordered = stateRef.current.sessions;
    const index = ordered.findIndex((session) => session.id === target.id);
    const next = ordered[index + 1];
    const dragged = ordered.find((session) => session.id === event.id);
    moveSession(event.id, next && dragged && next.pinned === dragged.pinned ? next.id : null);
  }), [targetAt]);

  // Soltar um arquivo ou pasta num card manda o caminho para o terminal
  // daquela sessao e a traz para frente, venha do explorador ou do Finder.
  // So sessoes com shell vivo aceitam; as outras nem destacam.
  const runningCardAt = useCallback((x, y) => {
    if (!inside(listRef.current, x, y)) return null;
    const node = document.elementFromPoint(x, y)?.closest?.('[data-session-id]');
    const id = node?.getAttribute('data-session-id');
    const session = id ? stateRef.current.sessions.find((item) => item.id === id) : null;
    return session && session.status === 'running' ? session.id : null;
  }, []);
  const deliver = useCallback((id, paths) => { deliverPaths(id, paths); }, []);
  useEffect(() => onDrag((event) => {
    if (event.kind !== 'path') return;
    if (event.type === 'end' || event.type === 'cancel') { setPathTarget(null); return; }
    const target = runningCardAt(event.x, event.y);
    if (event.type === 'move') { setPathTarget(target); return; }
    if (event.type !== 'drop') return;
    setPathTarget(null);
    if (target) deliver(target, [event.path]);
  }), [runningCardAt, deliver]);
  useEffect(() => {
    let disposed = false;
    let unlisten;
    onNativeDragDrop((event) => {
      if (disposed) return;
      const target = event.position ? runningCardAt(event.position.x, event.position.y) : null;
      setPathTarget(target && (event.type === 'enter' || event.type === 'over') ? target : null);
      if (event.type === 'drop' && target) deliver(target, event.paths || []);
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    }).catch((error) => console.error('[terminais] Arraste nativo indisponível:', error));
    return () => { disposed = true; unlisten?.(); };
  }, [runningCardAt, deliver]);

  const onListKeyDown = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    // ⌥ com as setas move o card selecionado dentro do grupo.
    if (event.altKey && selectedId && !filtering) {
      if (moveSessionBy(selectedId, delta)) {
        setTimeout(() => listRef.current?.querySelector(`[data-session-id="${selectedId}"]`)?.focus(), 0);
      }
      return;
    }
    const index = filtered.findIndex((session) => session.id === selectedId);
    const next = filtered[index + delta];
    if (next) {
      onSelect(next.id);
      const node = listRef.current?.querySelector(`[data-session-id="${next.id}"]`);
      node?.focus();
      node?.scrollIntoView({ block: 'nearest' });
    }
  };

  return (
    <aside className="terminais-sessions" id="terminais-sessions" aria-label={translate('terminal.session.sessions')}>
      <div className="terminais-pane__head">
        <span className="terminais-pane__title">{translate('terminal.session.sessions')}</span>
        <span className="terminais-pane__count">{sessions.length.toLocaleString(getLocale())}</span>
        {attentionCount > 0 ? (
          <button type="button" className="terminais-pane__chip" onClick={onJumpAttention} title={translate('terminal.session.attentionNext')}>
            <Bell size={11} strokeWidth={2} aria-hidden="true" />
            {attentionCount.toLocaleString(getLocale())}
          </button>
        ) : null}
        <span className="terminais-pane__spacer" />
        {onAccounts ? (
          <button type="button" className="terminais-pane__tool" onClick={onAccounts} aria-label={translate('terminal.profiles.title')} title={translate('terminal.profiles.title')}>
            <UserRound size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
        ) : null}
        <button type="button" className="terminais-pane__tool" onClick={onNew} aria-label={translate('terminal.session.new')} title={translate('terminal.session.newShortcut', { shortcut: shortcutLabel('Mod+T') })}>
          <Plus size={15} strokeWidth={2} aria-hidden="true" />
        </button>
        <button type="button" className="terminais-pane__tool" onClick={onCollapse} aria-label={translate('terminal.session.collapse')} title={translate('terminal.session.collapseShortcut', { shortcut: shortcutLabel('Mod+Shift+J') })}>
          <PanelLeftClose size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className="terminais-search">
        <Search size={13} strokeWidth={2} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={translate('terminal.session.searchPlaceholder')}
          aria-label={translate('terminal.session.search')}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setQuery(''); } }}
        />
        {query ? <button type="button" className="terminais-search__clear" onClick={() => setQuery('')} aria-label={translate('terminal.session.clearSearch')}><X size={12} strokeWidth={2} /></button> : null}
      </div>
      {disconnectedCount > 0 ? (
        <button type="button" className="terminais-sessions__reopen" onClick={onReopenAll}>
          <RotateCcw size={12} strokeWidth={2} aria-hidden="true" />
          <span>{translate(disconnectedCount === 1 ? 'terminal.session.reopenDisconnectedOne' : 'terminal.session.reopenDisconnectedMany', { count: disconnectedCount.toLocaleString(getLocale()) })}</span>
        </button>
      ) : null}
      <div className="terminais-sessions__list" role="listbox" aria-label={translate('terminal.session.openSessions')} ref={listRef} onKeyDown={onListKeyDown}>
        {filtered.map((session, index) => (
          <SessionCard
            key={session.id}
            order={Math.min(index, 8)}
            session={session}
            selected={session.id === selectedId}
            dragging={drag === session.id}
            dropBefore={Boolean(dropTarget && dropTarget.id === session.id && dropTarget.edge === 'before')}
            dropAfter={Boolean(dropTarget && dropTarget.id === session.id && dropTarget.edge === 'after')}
            dropInto={pathTarget === session.id}
            renaming={renamingId === session.id}
            onSelect={onSelect}
            onMenu={onMenu}
            onRename={onRename}
            onRenameDone={onRenameDone}
            onDragStart={onDragStart}
          />
        ))}
        {filtered.length === 0 && sessions.length > 0 ? <div className="terminais-sessions__empty">{translate('terminal.session.noMatch')}</div> : null}
        {drag && !filtering ? <div className={`terminais-sessions__dropend${dropTarget?.end ? ' is-active' : ''}`} aria-hidden="true" /> : null}
      </div>
    </aside>
  );
}
