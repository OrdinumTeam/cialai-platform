// SPDX-License-Identifier: Apache-2.0
// O que fica por cima do canvas do grafo da documentacao: os estados de
// indexacao, vazio, falha e raiz ampla, o cartao de detalhes, a legenda do
// modo de cor, a dica do ponteiro, a lista de ocorrencias da leitura parcial,
// a busca com a lista de resultados, o painel de opcoes, os avisos dos
// Vizinhos e do 3D e o espelho acessivel da arvore.
//
// Tudo aqui e DOM comum, com os tokens da casca e o molde do popover da
// toolbar. O canvas nao carrega texto de interface: o que o usuario le e o que
// o leitor de tela anuncia mora nestes componentes.
//
// As paletas e as listas de modos chegam pelo `engine`, carregado sob demanda,
// para este arquivo nao puxar o modelo do grafo para o pacote principal.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, FileText, Folder, FolderOpen, Network, Plus, Search, X } from 'lucide-react';
import { ORGANIZATION_COLORS, organizationColorStyle } from '../../lib/organization-colors.js';
import { getLocale, translate } from '../../shared/i18n.js';
import {
  STRINGS, ageBinLabel, colorModeName, excludedLines, fmtModified, fmtSize, foldersCount, indexingProgress, issueReason, issuesCount,
  itemsCount, linksCount, moreIssues, neighborsCapped, nodeAnnouncement, paletteName, rulesLimit, sizeBinLabel, subfoldersCount, typeLabel,
} from '../docgraph/copy.js';
import { DEPTH_LIMIT } from '../docgraph/options.js';

const ROOT = '.';
const CATEGORICAL = ['group', 'folder', 'type'];

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

export function GraphState({ controller, native, onRetry, onChangeDir, onConfirmBroad, onCreateReadme, onReadProject }) {
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
    if (controller.scope === 'project') return <Overlay title={STRINGS.emptyProject} hint={STRINGS.emptyProjectHint} />;
    return (
      <Overlay title={STRINGS.empty} hint={STRINGS.emptyHint}>
        <span className="terminais-docgraph__overlay-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={onCreateReadme}>{STRINGS.emptyAction}</button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={onReadProject}>{STRINGS.scopeProjectAction}</button>
        </span>
      </Overlay>
    );
  }
  if (indexing || controller.status === 'idle') {
    const seconds = controller.indexingSince ? (Date.now() - controller.indexingSince) / 1000 : 0;
    return (
      <Overlay title={STRINGS.indexing} hint={indexingProgress(seconds, controller.scope)}>
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
  const scope = controller.scope;
  const links = controller.tree?.links;
  const outgoing = links?.out.get(node.id)?.length || 0;
  const incoming = links?.into.get(node.id)?.length || 0;
  const docKind = scope === 'project' ? STRINGS.kindFile : STRINGS.kindDoc;
  return (
    <section className="terminais-docgraph__card" aria-label={title}>
      <header className="terminais-docgraph__card-head">
        <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
        <div className="terminais-docgraph__card-title" title={title}>{title}</div>
        <button type="button" className="terminais-pane__tool" onClick={onClose} aria-label={STRINGS.closeCard} title={STRINGS.closeCardTitle}><X size={13} strokeWidth={2} /></button>
      </header>
      <div className="terminais-docgraph__card-kind">{isRoot ? STRINGS.kindRoot : isDoc ? (node.symlink ? STRINGS.kindLink : docKind) : STRINGS.kindDir}</div>
      {!isRoot ? <div className="terminais-docgraph__card-path" title={node.id}>{node.id}</div> : null}
      <div className="terminais-docgraph__facts">
        {isDoc ? (
          <>
            {stat?.size != null ? <Fact label={STRINGS.factSize} value={fmtSize(stat.size)} /> : null}
            {stat?.modifiedMs ? <Fact label={STRINGS.factModified} value={fmtModified(stat.modifiedMs)} /> : null}
            {node.target ? <Fact label={STRINGS.factTarget} value={node.target} /> : null}
            {links?.count ? <Fact label={STRINGS.factRefsOut} value={itemsCount(outgoing, scope)} /> : null}
            {links?.count ? <Fact label={STRINGS.factRefsIn} value={itemsCount(incoming, scope)} /> : null}
          </>
        ) : (
          <>
            <Fact label={scope === 'project' ? STRINGS.factFiles : STRINGS.factDocs} value={itemsCount(node.docCount, scope)} />
            <Fact label={STRINGS.factDirect} value={itemsCount(node.docs.length, scope)} />
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

// Nome de cada entrada da legenda, pelo tipo dela.
function legendName(entry, tree, steps) {
  if (entry.kind === 'folder') return tree.nodes.get(entry.id)?.name || entry.id;
  if (entry.kind === 'type') return typeLabel(entry.ext);
  if (entry.kind === 'size') return sizeBinLabel(entry.bin, steps);
  if (entry.kind === 'age') return ageBinLabel(entry.bin);
  return entry.query || STRINGS.ruleQuery;
}

function otherName(mode) {
  if (mode === 'type') return STRINGS.otherTypes;
  if (mode === 'modified') return STRINGS.noDate;
  if (mode === 'rules') return STRINGS.otherRules;
  return STRINGS.otherGroups;
}

// Sempre presente quando a cor diz algo: ela nunca e o unico jeito de saber
// de que grupo e um no. Na paleta monocromatica as categorias ficam todas no
// neutro e a legenda delas some; as faixas de tamanho e de data continuam, e
// as regras tambem, porque a cor de cada uma e escolhida e nao sai da paleta.
export function Legend({ controller, engine, dark, onFocus }) {
  const tree = controller.tree;
  const colors = controller.colors;
  if (!tree || !colors?.legend) return null;
  const mode = colors.mode;
  if (controller.palette === 'mono' && CATEGORICAL.includes(mode)) return null;
  const entries = colors.legend.filter((entry) => entry.count > 0 || entry.kind === 'rule');
  if (!entries.length && !colors.other) return null;
  const palette = engine.paletteColors(controller.palette, dark);
  const swatch = (key) => engine.toneColor(key, palette);
  const locale = getLocale();
  const format = (value) => value.toLocaleString(locale);
  return (
    <section className="terminais-docgraph__legend" aria-label={`${STRINGS.legend}, ${colorModeName(mode)}`}>
      <div className="terminais-docgraph__legend-title">{colorModeName(mode)}</div>
      {entries.map((entry, at) => {
        const name = legendName(entry, tree, engine.SIZE_STEPS);
        const key = `${entry.kind}-${entry.id || entry.ext || entry.bin || ''}-${at}`;
        const body = (
          <>
            <span className="terminais-docgraph__swatch" style={{ background: swatch(entry.key) }} aria-hidden="true" />
            <span className="terminais-docgraph__legend-name">{name}</span>
            <em>{format(entry.count)}</em>
          </>
        );
        if (entry.kind === 'folder') {
          return <button key={key} type="button" className="terminais-docgraph__legend-item" onClick={() => onFocus(entry.id)} title={entry.id}>{body}</button>;
        }
        return <div key={key} className="terminais-docgraph__legend-item is-static" title={name}>{body}</div>;
      })}
      {colors.other > 0 ? (
        <div className="terminais-docgraph__legend-item is-static">
          <span className="terminais-docgraph__swatch" style={{ background: swatch(null) }} aria-hidden="true" />
          <span className="terminais-docgraph__legend-name">{otherName(mode)}</span>
          <em>{format(colors.other)}</em>
        </div>
      ) : null}
    </section>
  );
}

/* ── opcoes ───────────────────────────────────────────────────────── */

function Section({ title, children }) {
  return (
    <section className="terminais-docgraph__options-section">
      {title ? <div className="terminais-docgraph__options-title">{title}</div> : null}
      {children}
    </section>
  );
}

function Segmented({ label, value, options, onChange }) {
  return (
    <div className="segmented terminais-docgraph__segmented" role="radiogroup" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} className={`segmented__option${value === id ? ' is-selected' : ''}`} onClick={() => onChange(id)}>{text}</button>
      ))}
    </div>
  );
}

// Cor da regra nova: a primeira das cores compartilhadas que ainda nao esta
// em uso, para duas regras seguidas nao nascerem iguais.
function nextRuleColor(rules) {
  const used = new Set(rules.map((rule) => rule.color));
  return (ORGANIZATION_COLORS.find((color) => !used.has(color.id)) || ORGANIZATION_COLORS[0]).id;
}

// Campo da regra com estado proprio. O controlador avisa a mudanca depois do
// evento, e um campo controlado so por ele perderia letras digitadas em
// sequencia e pularia o cursor para o fim.
function RuleQuery({ value, textLimit, onCommit }) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(value); }, [value]);
  return (
    <input
      className="terminais-docgraph__rule-query"
      value={draft}
      maxLength={textLimit}
      placeholder={STRINGS.ruleQuery}
      aria-label={STRINGS.ruleQuery}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      onFocus={() => { editing.current = true; }}
      onBlur={() => { editing.current = false; }}
      onChange={(event) => { setDraft(event.target.value); onCommit(event.target.value); }}
      onKeyDown={(event) => event.stopPropagation()}
    />
  );
}

// `readRules` le a lista viva do controlador: entre duas teclas o painel pode
// ainda nao ter renderizado a lista nova.
function RulesEditor({ rules, readRules, limit, textLimit, onChange }) {
  const [picking, setPicking] = useState(-1);
  const update = (at, patch) => onChange(readRules().map((rule, index) => (index === at ? { ...rule, ...patch } : rule)));
  const remove = (at) => { setPicking(-1); onChange(readRules().filter((_, index) => index !== at)); };
  const full = rules.length >= limit;
  return (
    <Section title={STRINGS.colorRules}>
      <p className="terminais-docgraph__options-hint">{STRINGS.rulesHint}</p>
      {rules.length ? (
        <ul className="terminais-docgraph__rules">
          {rules.map((rule, at) => {
            const colorLabel = translate(`terminal.color.${rule.color}`);
            return (
              // A ordem das regras e a identidade delas: nao ha outra chave.
              <li key={at}>
                <div className="terminais-docgraph__rule">
                  <button
                    type="button"
                    className="terminais-pop__swatch is-current terminais-docgraph__rule-swatch"
                    style={organizationColorStyle(rule.color)}
                    aria-label={`${STRINGS.ruleColor}, ${colorLabel}`}
                    title={`${STRINGS.ruleColor}, ${colorLabel}`}
                    aria-expanded={picking === at}
                    onClick={() => setPicking(picking === at ? -1 : at)}
                  >
                    <i aria-hidden="true" />
                  </button>
                  <RuleQuery value={rule.query} textLimit={textLimit} onCommit={(query) => update(at, { query })} />
                  <button type="button" className="terminais-pane__tool" onClick={() => remove(at)} aria-label={STRINGS.ruleRemove} title={STRINGS.ruleRemove}><X size={12} strokeWidth={2} /></button>
                </div>
                {picking === at ? (
                  <div className="terminais-pop__grid terminais-docgraph__rule-colors" role="radiogroup" aria-label={STRINGS.ruleColor}>
                    {ORGANIZATION_COLORS.map((entry) => {
                      const label = translate(`terminal.color.${entry.id}`);
                      const active = rule.color === entry.id;
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          className={`terminais-pop__swatch${active ? ' is-current' : ''}`}
                          style={organizationColorStyle(entry.id)}
                          aria-label={label}
                          title={label}
                          onClick={() => { update(at, { color: entry.id }); setPicking(-1); }}
                        >
                          <i aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="terminais-docgraph__options-hint">{STRINGS.rulesEmpty}</p>}
      <button
        type="button"
        className="btn btn-quiet btn-sm terminais-docgraph__options-action"
        disabled={full}
        title={full ? rulesLimit(limit) : STRINGS.ruleAdd}
        onClick={() => { const current = readRules(); onChange([...current, { query: '', color: nextRuleColor(current) }]); setPicking(-1); }}
      >
        <Plus size={12} strokeWidth={2} aria-hidden="true" />
        {STRINGS.ruleAdd}
      </button>
    </Section>
  );
}

// Painel das opcoes do grafo: o que se le, a cor, a paleta, os links e, nos
// Vizinhos, a profundidade. Fecha com Esc e com clique fora, como as
// ocorrencias da leitura parcial.
const OPTIONS_MAX_HEIGHT = 560;

export function GraphOptions({ controller, engine, dark, onClose, onScope, onColorBy, onPalette, onRules, onRefs, onDepth, onRegroup }) {
  const boxRef = useRef(null);
  useEffect(() => {
    const onDown = (event) => {
      if (event.target.closest?.('.terminais-docgraph__options-toggle')) return;
      if (!boxRef.current?.contains(event.target)) onClose();
    };
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey, true); };
  }, [onClose]);
  // O painel nasce na barra e nao passa da borda de baixo do grafo, que corta
  // o que sai dela. O que nao cabe rola dentro do painel.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const pane = box?.closest('.terminais-docgraph');
    if (!box || !pane) return undefined;
    const fit = () => {
      const room = pane.getBoundingClientRect().bottom - box.getBoundingClientRect().top - 8;
      box.style.maxHeight = `${Math.max(120, Math.min(OPTIONS_MAX_HEIGHT, Math.floor(room)))}px`;
    };
    fit();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    observer?.observe(pane);
    return () => observer?.disconnect();
  }, []);
  const sequential = controller.colorBy === 'size' || controller.colorBy === 'modified';
  const depths = Array.from({ length: DEPTH_LIMIT }, (_, index) => String(index + 1));
  return (
    <div className="terminais-docgraph__options" ref={boxRef} role="dialog" aria-label={STRINGS.options}>
      <Section title={STRINGS.scope}>
        <Segmented label={STRINGS.scope} value={controller.scope} options={[['docs', STRINGS.scopeDocs], ['project', STRINGS.scopeProject]]} onChange={onScope} />
      </Section>
      <Section title={STRINGS.colorBy}>
        <div className="terminais-docgraph__choices" role="radiogroup" aria-label={STRINGS.colorBy}>
          {engine.COLOR_MODES.map((mode) => (
            <button key={mode} type="button" role="radio" aria-checked={controller.colorBy === mode} className={`terminais-docgraph__choice${controller.colorBy === mode ? ' is-selected' : ''}`} onClick={() => onColorBy(mode)}>
              {colorModeName(mode)}
            </button>
          ))}
        </div>
        {CATEGORICAL.includes(controller.colorBy) ? (
          <button type="button" className="btn btn-quiet btn-sm terminais-docgraph__options-action" onClick={onRegroup}>{STRINGS.regroup}</button>
        ) : null}
      </Section>
      {controller.colorBy === 'rules' ? (
        <RulesEditor rules={controller.rules} readRules={() => controller.rules} limit={engine.RULE_LIMIT} textLimit={engine.RULE_TEXT_LIMIT} onChange={onRules} />
      ) : (
        <Section title={STRINGS.palette}>
          <div className="terminais-docgraph__palettes" role="radiogroup" aria-label={STRINGS.palette}>
            {engine.PALETTES.map((palette) => {
              const colors = engine.paletteColors(palette, dark);
              const chips = sequential ? colors.ramp : colors.slots;
              const current = controller.palette === palette;
              return (
                <button key={palette} type="button" role="radio" aria-checked={current} className={`terminais-docgraph__palette${current ? ' is-selected' : ''}`} onClick={() => onPalette(palette)}>
                  <span className="terminais-docgraph__palette-chips" aria-hidden="true">
                    {chips.map((color, at) => <i key={`${color}-${at}`} style={{ background: color }} />)}
                  </span>
                  <span className="terminais-docgraph__palette-name">{paletteName(palette)}</span>
                  {palette === 'safe' ? <em>{STRINGS.paletteSafeHint}</em> : null}
                </button>
              );
            })}
          </div>
        </Section>
      )}
      <Section>
        <label className="terminais-docgraph__switch">
          <span>
            <strong>{STRINGS.links}</strong>
            <em>{STRINGS.linksHint}</em>
          </span>
          <input type="checkbox" className="mac-switch" role="switch" checked={controller.refs} onChange={(event) => onRefs(event.target.checked)} />
        </label>
      </Section>
      {controller.mode === 'neighbors' ? (
        <Section title={STRINGS.depth}>
          <Segmented label={STRINGS.depth} value={String(controller.depth)} options={depths.map((value) => [value, value])} onChange={(value) => onDepth(Number(value))} />
        </Section>
      ) : null}
    </div>
  );
}

/* ── avisos das vistas ────────────────────────────────────────────── */

// Vizinhos sem nada para mostrar, ou cortados no teto. O aviso fica no alto
// e deixa o arquivo em foco a vista.
export function ViewNote({ controller, onReadProject }) {
  const scene = controller.scene;
  if (scene.mode === 'neighbors') {
    if (scene.empty === 'noLinks') {
      const project = controller.scope === 'project';
      return (
        <div className="terminais-docgraph__note" role="status">
          <strong>{STRINGS.neighborsNoLinks}</strong>
          <span>{STRINGS.neighborsNoLinksHint}</span>
          {!project ? <button type="button" className="btn btn-quiet btn-sm" onClick={onReadProject}>{STRINGS.scopeProjectAction}</button> : null}
        </div>
      );
    }
    if (scene.empty === 'noFocus') {
      return (
        <div className="terminais-docgraph__note" role="status">
          <strong>{STRINGS.neighborsNoFocus}</strong>
          <span>{STRINGS.neighborsNoFocusHint}</span>
        </div>
      );
    }
    if (scene.empty === 'alone') {
      return (
        <div className="terminais-docgraph__note" role="status">
          <strong>{STRINGS.neighborsAlone}</strong>
          <span>{STRINGS.neighborsAloneHint}</span>
        </div>
      );
    }
    if (scene.capped) return <div className="terminais-docgraph__note is-quiet" role="status"><span>{neighborsCapped(scene.nodes.length)}</span></div>;
  }
  return null;
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
          placeholder={controller.scope === 'project' ? STRINGS.searchProject : STRINGS.search}
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
          {!query ? <div className="terminais-docgraph__results-title">{controller.scope === 'project' ? STRINGS.searchAllFiles : STRINGS.searchAll}</div> : null}
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
      {node.kind === 'doc' ? null : <em>{itemsCount(node.docCount, controller.scope)}</em>}
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
  const scope = controller.scope;
  // Nos Vizinhos a lista e plana: o foco e quem esta ligado a ele.
  if (controller.scene.mode === 'neighbors') {
    const order = (controller.scene.order || []).filter((id) => tree.nodes.has(id));
    return (
      <div className="sr-only">
        {order.map((id, at) => (
          <div key={id} id={idFor(id)} role="treeitem" aria-level={1} aria-setsize={order.length} aria-posinset={at + 1} aria-selected={id === controller.selected}>
            {nodeAnnouncement(tree.nodes.get(id), { rootName, scope })}
          </div>
        ))}
      </div>
    );
  }
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
            {nodeAnnouncement(item, { expanded: controller.expanded.has(id), rootName, scope })}
          </div>
        );
      })}
    </div>
  );
}

export function countsLabel(controller) {
  const tree = controller.tree;
  if (!tree) return '';
  const base = `${itemsCount(tree.docCount, controller.scope)} · ${foldersCount(tree.dirCount)}`;
  // Com os links ligados, a contagem deles vem junto.
  return controller.refs && tree.links?.count ? `${base} · ${linksCount(tree.links.count)}` : base;
}
