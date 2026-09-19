// SPDX-License-Identifier: Apache-2.0
// O que fica por cima do canvas do grafo da documentacao: os estados de
// indexacao, vazio, falha e raiz ampla, o cartao de detalhes, a legenda dos
// agrupamentos, a dica do ponteiro, a lista de ocorrencias da leitura parcial,
// a busca com a lista de resultados e o espelho acessivel da arvore.
//
// Tudo aqui e DOM comum, com os tokens da casca e o molde do popover da
// toolbar. O canvas nao carrega texto de interface: o que o usuario le e o que
// o leitor de tela anuncia mora nestes componentes.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, FileText, Folder, FolderOpen, Network, Search, X } from 'lucide-react';
import { ORGANIZATION_COLORS } from '../../lib/organization-colors.js';
import {
  STRINGS, docsCount, excludedLines, fmtModified, fmtSize, foldersCount, indexingProgress, issueReason, issuesCount, moreIssues,
  nodeAnnouncement, subfoldersCount,
} from '../docgraph/copy.js';

const ROOT = '.';

function toneColor(tone, dark) {
  const entry = ORGANIZATION_COLORS.find((color) => color.id === (tone || 'cinza'));
  return entry ? (dark ? entry.dark : entry.light) : undefined;
}

/* ── estados ──────────────────────────────────────────────────────── */

function Overlay({ role = 'status', title, hint, children }) {
  return (
    <div className="terminais-docgraph__overlay" role={role}>
      <Network size={22} strokeWidth={1.5} aria-hidden="true" />
      <strong>{title}</strong>
      {hint ? <span>{hint}</span> : null}
      {children}
    </div>
  );
}

export function GraphState({ controller, native, onRetry, onChangeDir, onConfirmBroad, onCreateReadme }) {
  const [, tick] = useState(0);
  const indexing = controller.status === 'indexing';
  useEffect(() => {
    if (!indexing) return undefined;
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [indexing]);

  if (!native) return <Overlay title={STRINGS.unavailable} />;
  if (controller.status === 'broad') {
    return (
      <Overlay title={STRINGS.broad} hint={STRINGS.broadHint}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onConfirmBroad}>{STRINGS.broadAction}</button>
      </Overlay>
    );
  }
  if (controller.status === 'error') {
    return (
      <Overlay role="alert" title={STRINGS.error} hint={controller.error?.message}>
        <span className="terminais-docgraph__overlay-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={onRetry}>{STRINGS.retry}</button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={onChangeDir}>{STRINGS.changeDir}</button>
        </span>
      </Overlay>
    );
  }
  if (controller.status === 'empty') {
    // Vazio com leitura incompleta nao e um projeto sem documentacao.
    if (controller.meta?.partial) {
      return (
        <Overlay role="alert" title={STRINGS.emptyPartial} hint={controller.meta.stopped === 'timeout' ? STRINGS.partialTimeout : controller.meta.stopped === 'limit' ? STRINGS.partialLimit : issuesCount(controller.meta.issuesTotal)}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>{STRINGS.retry}</button>
        </Overlay>
      );
    }
    return (
      <Overlay title={STRINGS.empty} hint={STRINGS.emptyHint}>
        <button type="button" className="btn btn-primary btn-sm" onClick={onCreateReadme}>{STRINGS.emptyAction}</button>
      </Overlay>
    );
  }
  if (indexing || controller.status === 'idle') {
    const seconds = controller.indexingSince ? (Date.now() - controller.indexingSince) / 1000 : 0;
    return (
      <Overlay title={STRINGS.indexing} hint={indexingProgress(seconds)}>
        <div className="terminais-docgraph__progress is-loading" aria-hidden="true" />
      </Overlay>
    );
  }
  return null;
}

/* ── cartao de detalhes ───────────────────────────────────────────── */

function Fact({ label, value }) {
  return (
    <div className="terminais-docgraph__fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function DetailCard({ controller, node, stat, rootName, onOpen, onPreview, onReveal, onToggle, onClose }) {
  if (!node) return null;
  const isDoc = node.kind === 'doc';
  const isRoot = node.kind === 'root';
  const open = controller.expanded.has(node.id);
  const title = isRoot ? rootName : node.name;
  const Icon = isDoc ? FileText : open ? FolderOpen : Folder;
  return (
    <section className="terminais-docgraph__card" aria-label={title}>
      <header className="terminais-docgraph__card-head">
        <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
        <div className="terminais-docgraph__card-title" title={title}>{title}</div>
        <button type="button" className="terminais-pane__tool" onClick={onClose} aria-label={STRINGS.closeCard} title={STRINGS.closeCardTitle}><X size={13} strokeWidth={2} /></button>
      </header>
      <div className="terminais-docgraph__card-kind">{isRoot ? STRINGS.kindRoot : isDoc ? (node.symlink ? STRINGS.kindLink : STRINGS.kindDoc) : STRINGS.kindDir}</div>
      {!isRoot ? <div className="terminais-docgraph__card-path" title={node.id}>{node.id}</div> : null}
      <div className="terminais-docgraph__facts">
        {isDoc ? (
          <>
            {stat?.size != null ? <Fact label={STRINGS.factSize} value={fmtSize(stat.size)} /> : null}
            {stat?.modifiedMs ? <Fact label={STRINGS.factModified} value={fmtModified(stat.modifiedMs)} /> : null}
            {node.target ? <Fact label={STRINGS.factTarget} value={node.target} /> : null}
          </>
        ) : (
          <>
            <Fact label={STRINGS.factDocs} value={docsCount(node.docCount)} />
            <Fact label={STRINGS.factDirect} value={docsCount(node.docs.length)} />
            <Fact label={STRINGS.factSubdirs} value={subfoldersCount(node.dirs.length)} />
          </>
        )}
      </div>
      {node.partial ? (
        <div className="terminais-docgraph__card-warn"><AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />{STRINGS.partialNode}</div>
      ) : null}
      <div className="terminais-docgraph__card-actions">
        {isDoc ? (
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={onOpen}>{STRINGS.openInEditor}</button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={onPreview}>{STRINGS.preview}</button>
          </>
        ) : null}
        {!isDoc && !isRoot ? <button type="button" className="btn btn-ghost btn-sm" onClick={onToggle}>{open ? STRINGS.collapse : STRINGS.expand}</button> : null}
        <button type="button" className="btn btn-quiet btn-sm" onClick={onReveal}>{STRINGS.revealInExplorer}</button>
      </div>
    </section>
  );
}

/* ── legenda ──────────────────────────────────────────────────────── */

// Sempre presente: a cor nunca e o unico jeito de saber de que grupo e um no.
export function Legend({ controller, dark, onFocus }) {
  const tree = controller.tree;
  if (!tree || !controller.groups.length) return null;
  return (
    <section className="terminais-docgraph__legend" aria-label={STRINGS.legend}>
      {controller.groups.map((group) => (
        <button key={group.id} type="button" className="terminais-docgraph__legend-item" onClick={() => onFocus(group.id)} title={group.id}>
          <span className="terminais-docgraph__swatch" style={{ background: toneColor(group.tone, dark) }} aria-hidden="true" />
          <span className="terminais-docgraph__legend-name">{tree.nodes.get(group.id)?.name || group.id}</span>
          <em>{group.docCount.toLocaleString('pt-BR')}</em>
        </button>
      ))}
      {controller.otherDocs > 0 ? (
        <div className="terminais-docgraph__legend-item is-static">
          <span className="terminais-docgraph__swatch" style={{ background: toneColor(null, dark) }} aria-hidden="true" />
          <span className="terminais-docgraph__legend-name">{STRINGS.otherGroups}</span>
          <em>{controller.otherDocs.toLocaleString('pt-BR')}</em>
        </div>
      ) : null}
    </section>
  );
}

/* ── ocorrencias da leitura parcial ───────────────────────────────── */

export function IssuesPopover({ meta, onClose }) {
  const boxRef = useRef(null);
  useEffect(() => {
    const onDown = (event) => { if (!boxRef.current?.contains(event.target)) onClose(); };
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey, true); };
  }, [onClose]);
  const issues = meta?.issues || [];
  const more = (meta?.issuesTotal || 0) - issues.length;
  const excluded = excludedLines(meta?.excluded);
  return (
    <div className="terminais-docgraph__issues" ref={boxRef} role="dialog" aria-label={STRINGS.partialTitle}>
      <strong>{STRINGS.partialTitle}</strong>
      {meta?.stopped ? <p>{meta.stopped === 'timeout' ? STRINGS.partialTimeout : STRINGS.partialLimit}</p> : null}
      {issues.length ? (
        <>
          <div className="terminais-docgraph__issues-title">{STRINGS.partialIssues}</div>
          <ul>
            {issues.slice(0, 12).map((issue, index) => (
              <li key={`${issue.relative}-${index}`}>
                <span title={issue.relative || STRINGS.kindRoot}>{issue.relative || STRINGS.kindRoot}</span>
                <em>{issueReason(issue.code)}</em>
              </li>
            ))}
          </ul>
          {issues.length > 12 || more > 0 ? <p>{moreIssues(Math.max(0, issues.length - 12) + Math.max(0, more))}</p> : null}
        </>
      ) : null}
      {excluded.length ? (
        <>
          <div className="terminais-docgraph__issues-title">{STRINGS.excludedTitle}</div>
          <ul>{excluded.map((line) => <li key={line}><span>{line}</span></li>)}</ul>
        </>
      ) : null}
    </div>
  );
}

/* ── busca ────────────────────────────────────────────────────────── */

// Campo com lista de resultados no molde da busca rapida: setas, Enter e Esc.
// Com o campo vazio a lista traz todos os documentos, que e a alternativa
// tabular ao grafo para quem navega so pelo teclado.
export function SearchBox({ controller, search, inputRef, onQuery, onPick, onLeave }) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const listRef = useRef(null);
  const tree = controller.tree;
  const query = controller.query;
  const items = useMemo(() => (tree && open ? search(tree, query, { limit: query ? 40 : 200 }) : []), [tree, open, query, search, controller.meta?.fingerprint]);
  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => { listRef.current?.children?.[index]?.scrollIntoView?.({ block: 'nearest' }); }, [index]);

  const pick = (item) => { setOpen(false); onPick(item.id); };
  const onKeyDown = (event) => {
    event.stopPropagation();
    if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setIndex((value) => Math.min(value + 1, items.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((value) => Math.max(value - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); if (items[index]) pick(items[index]); }
    else if (event.key === 'Escape') {
      event.preventDefault();
      if (query) onQuery(''); else { setOpen(false); onLeave(); }
    }
  };

  return (
    <div className="terminais-docgraph__searchbox" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <div className="terminais-search terminais-docgraph__search" role="search">
        <Search size={13} strokeWidth={2} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => { onQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={STRINGS.search}
          aria-label={STRINGS.searchLabel}
          aria-expanded={open}
          aria-controls="docgraph-results"
          role="combobox"
          aria-autocomplete="list"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
        {query ? <button type="button" className="terminais-search__clear" onClick={() => { onQuery(''); inputRef.current?.focus(); }} aria-label={STRINGS.clearSearch}><X size={12} strokeWidth={2} /></button> : null}
      </div>
      {open && tree ? (
        <div className="terminais-docgraph__results" id="docgraph-results">
          {!query ? <div className="terminais-docgraph__results-title">{STRINGS.searchAll}</div> : null}
          <ul role="listbox" ref={listRef} aria-label={STRINGS.searchLabel}>
            {items.length === 0 ? <li className="terminais-docgraph__results-empty">{STRINGS.searchEmpty}</li> : null}
            {items.map((item, position) => {
              const node = tree.nodes.get(item.id);
              if (!node) return null;
              const parent = node.parent === ROOT || node.parent === null ? '' : node.parent;
              const Icon = node.kind === 'doc' ? FileText : Folder;
              return (
                <li
                  key={item.id}
                  role="option"
                  aria-selected={position === index}
                  className={`terminais-result${position === index ? ' is-active' : ''}`}
                  onMouseEnter={() => setIndex(position)}
                  onMouseDown={(event) => { event.preventDefault(); pick(item); }}
                >
                  <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
                  <span className="terminais-result__name">{node.name}</span>
                  <span className="terminais-result__dir">{parent}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/* ── dica do ponteiro ─────────────────────────────────────────────── */

export function HoverTip({ hover, controller, rootName }) {
  const node = hover ? controller.tree?.nodes.get(hover.id) : null;
  if (!node) return null;
  const style = { left: Math.round(hover.x + 14), top: Math.round(hover.y + 16) };
  return (
    <div className="terminais-docgraph__tip" style={style} role="tooltip">
      <strong>{node.kind === 'root' ? rootName : node.name}</strong>
      {node.kind === 'root' ? null : <span>{node.id}</span>}
      {node.kind === 'doc' ? null : <em>{docsCount(node.docCount)}</em>}
    </div>
  );
}

/* ── espelho acessivel ────────────────────────────────────────────── */

// O canvas nao existe para o leitor de tela. Este espelho e uma janela da
// arvore em volta do no ativo: os ancestrais, os irmaos e os filhos, com nivel,
// posicao e estado, para `aria-activedescendant` ter para onde apontar.
export function TreeMirror({ controller, rootName, idFor }) {
  const tree = controller.tree;
  if (!tree || !tree.docCount) return null;
  const active = controller.selected && tree.nodes.has(controller.selected) ? controller.selected : ROOT;
  const node = tree.nodes.get(active);
  const wanted = new Set([ROOT, active]);
  let cursor = node.parent;
  while (cursor !== null && cursor !== undefined) { wanted.add(cursor); cursor = tree.nodes.get(cursor).parent; }
  const siblingsOf = (id) => { const parent = tree.nodes.get(tree.nodes.get(id).parent); return parent ? [...parent.dirs, ...parent.docs] : [id]; };
  siblingsOf(active).slice(0, 60).forEach((id) => wanted.add(id));
  if (node.kind !== 'doc' && controller.expanded.has(active)) [...node.dirs, ...node.docs].slice(0, 60).forEach((id) => wanted.add(id));
  const order = (controller.scene.order || []).filter((id) => wanted.has(id));
  return (
    <div className="sr-only">
      {order.map((id) => {
        const item = tree.nodes.get(id);
        const siblings = siblingsOf(id);
        return (
          <div
            key={id}
            id={idFor(id)}
            role="treeitem"
            aria-level={item.depth + 1}
            aria-setsize={siblings.length}
            aria-posinset={siblings.indexOf(id) + 1}
            aria-selected={id === controller.selected}
            aria-expanded={item.kind === 'doc' ? undefined : controller.expanded.has(id)}
          >
            {nodeAnnouncement(item, { expanded: controller.expanded.has(id), rootName })}
          </div>
        );
      })}
    </div>
  );
}

export function countsLabel(controller) {
  const tree = controller.tree;
  if (!tree) return '';
  return `${docsCount(tree.docCount)} · ${foldersCount(tree.dirCount)}`;
}
