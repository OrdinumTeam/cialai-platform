// SPDX-License-Identifier: Apache-2.0
// Area do editor: abas da sessao e o conteudo da aba ativa. Texto adota o
// DOM da EditorView que vive no runtime; Markdown, HTML e CSV alternam entre
// edicao e visualizacao; imagens tem previa simples; PDF, planilhas, Word e
// os documentos convertidos pelo LibreOffice tem visualizador sem editor; o
// resto abre no app padrao. Um arquivo alterado no disco mostra o aviso
// antes de qualquer sobrescrita.
//
// O painel assina so os eventos de editor da propria sessao e recebe as
// acoes num objeto estavel, entao a saida do terminal e as metricas nunca o
// redesenham.

import React, { memo, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ExternalLink, FileText, FolderOpen, Globe, RefreshCw, X } from 'lucide-react';
import BrowserPane from './BrowserPane.jsx';
import { DataState } from '../../components/ui.jsx';
import { fmtBytes } from '../../lib/helpers.js';
import { openExternal } from '../../lib/downloads.js';
import { previewUrl } from '../../lib/native.js';
import { renderMarkdown, contentOf } from '../editor.js';
import { canConvertToPdf, dirName, isInside, isPreviewable, isViewerKind, relativePath, shortPath } from '../files.js';
import { useRuntimeEvents } from '../hooks.js';
import { getLocale, translate, useI18n } from '../../shared/i18n.js';

const tabName = (tab) => tab.kind === 'browser' ? translate('terminal.browser.tabName') : tab.name;

// Linhas mostradas por vez numa planilha; "Mostrar mais" acrescenta outra
// leva, para uma aba grande nao montar milhares de celulas de uma vez.
const SHEET_PAGE = 250;

function TextHost({ tab, focusKey }) {
  const hostRef = useRef(null);
  useEffect(() => {
    const host = hostRef.current;
    const view = tab.view;
    if (!host || !view) return undefined;
    host.appendChild(view.dom);
    view.requestMeasure();
    return () => {
      if (view.dom.parentElement === host) host.removeChild(view.dom);
    };
  }, [tab, tab.view]);
  useEffect(() => {
    if (tab.view && focusKey) tab.view.focus();
  }, [tab, focusKey]);
  return <div className="terminais-editor__host" ref={hostRef} />;
}

// Links de uma previa: so http e https abrem, no navegador padrao.
function onPreviewClick(event) {
  const anchor = event.target.closest('a');
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute('href') || '';
  if (/^https?:\/\//i.test(href)) openExternal(href).catch(() => {});
}

function MarkdownPreview({ tab }) {
  const html = renderMarkdown(contentOf(tab));
  // O HTML vem do marked com a marcacao crua do arquivo escapada; so o que o
  // proprio marked gera entra aqui.
  return <div className="terminais-md" onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

// Pagina HTML do disco num iframe pelo protocolo preview:// do app, com a
// raiz do projeto como raiz do site: css, imagens e scripts com caminho
// absoluto ou relativo resolvem como num servidor. Fora do app cai no
// conteudo do editor sem os recursos.
function HtmlPreview({ tab, root }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const base = root && isInside(root, tab.path) ? root : dirName(tab.path);
    const relative = relativePath(base, tab.path) || tab.name;
    previewUrl(base, relative).then((value) => { if (!cancelled) setUrl(value); }).catch(() => setUrl(null));
    return () => { cancelled = true; };
  }, [tab.path, root]);
  const nonce = tab.previewNonce || 0;
  return (
    <div className="terminais-html">
      {url ? (
        <iframe key={`${url}#${nonce}`} src={url} title={translate('terminal.editor.previewOf', { name: tab.name })} sandbox="allow-same-origin allow-scripts allow-forms allow-popups" />
      ) : (
        <iframe key={`srcdoc#${nonce}`} srcDoc={contentOf(tab)} title={translate('terminal.editor.previewOf', { name: tab.name })} sandbox="allow-same-origin allow-scripts allow-forms" />
      )}
    </div>
  );
}

/* ── visualizadores sem editor ────────────────────────────────────── */

// O visualizador de PDF do WebKit, num iframe sem sandbox: com sandbox o
// WebKit nao abre o plugin de PDF.
function PdfView({ tab }) {
  return (
    <div className="terminais-pdf">
      <iframe key={tab.viewer.url} src={tab.viewer.url} title={translate('terminal.editor.previewOf', { name: tab.name })} />
    </div>
  );
}

function looksNumeric(text) {
  return /^-?[\d.,]+%?$/.test(String(text || '').trim());
}

// Planilha: uma aba por folha, cabecalho de letras e numero de linha fixos,
// e mais linhas sob demanda.
function SheetView({ tab }) {
  const sheets = tab.viewer.sheets || [];
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(SHEET_PAGE);
  useEffect(() => { setIndex(0); setShown(SHEET_PAGE); }, [tab.viewer]);
  const sheet = sheets[Math.min(index, sheets.length - 1)];
  if (!sheet) return <DataState type="empty" message={translate('terminal.editor.noSheets')} />;
  const rows = sheet.rows.slice(0, shown);
  const more = sheet.rows.length - rows.length;
  return (
    <div className="terminais-sheet">
      {sheets.length > 1 ? (
        <div className="terminais-sheet__tabs">
          <div className="segmented" role="tablist" aria-label={translate('terminal.editor.sheets')}>
            {sheets.map((item, position) => (
              <button
                key={`${item.name}-${position}`}
                type="button"
                role="tab"
                aria-selected={position === index}
                className={`segmented__option${position === index ? ' is-selected' : ''}`}
                onClick={() => { setIndex(position); setShown(SHEET_PAGE); }}
              >
                {item.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="terminais-sheet__scroll">
        <table>
          <thead>
            <tr>
              <th aria-label={translate('terminal.editor.row')} />
              {sheet.columns.map((column) => <th key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <td>{rowIndex + 1}</td>
                {row.map((cell, cellIndex) => <td key={cellIndex} className={looksNumeric(cell) ? 'is-number' : undefined} title={cell.length > 40 ? cell : undefined}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more > 0 || sheet.truncatedRows || sheet.truncatedCols ? (
        <div className="terminais-sheet__note">
          {more > 0 ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShown((value) => value + SHEET_PAGE)}>{translate('terminal.editor.showMoreRows', { count: Math.min(more, SHEET_PAGE).toLocaleString(getLocale()) })}</button> : null}
          <span>
            {translate(
              sheet.truncatedRows
                ? (sheet.truncatedCols ? 'terminal.editor.showingRowsMoreColumns' : 'terminal.editor.showingRowsMore')
                : (sheet.truncatedCols ? 'terminal.editor.showingRowsColumns' : 'terminal.editor.showingRows'),
              {
                shown: rows.length.toLocaleString(getLocale()),
                total: sheet.rows.length.toLocaleString(getLocale()),
                ...(sheet.truncatedCols ? { columns: sheet.columns.length.toLocaleString(getLocale()) } : {}),
              },
            )}
          </span>
        </div>
      ) : null}
    </div>
  );
}

// Word: HTML do mammoth, ja sem script e sem eventos, vestido pela folha do
// Markdown.
function DocxView({ tab }) {
  return <div className="terminais-md terminais-doc" onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: tab.viewer.html }} />;
}

// Barra dos visualizadores: nome e tamanho, origem da conversao e as acoes
// de abrir fora, revelar, reconverter e ver como PDF.
function ViewerBar({ tab, actions }) {
  const viewer = tab.viewer;
  const converted = viewer?.kind === 'pdf' && viewer.converted;
  return (
    <div className="terminais-editor__bar">
      <div className="terminais-viewer__meta">
        <strong title={shortPath(tab.path)}>{tab.name}</strong>
        {tab.size != null ? <em>{fmtBytes(tab.size)}</em> : null}
        {converted ? <em>{translate(viewer.cached ? 'terminal.editor.cachedPdf' : 'terminal.editor.convertedPdf')}</em> : null}
        {viewer?.kind === 'docx' && viewer.messages ? <em title={translate('terminal.editor.converterWarningsTitle')}>{translate(viewer.messages === 1 ? 'terminal.editor.oneWarning' : 'terminal.editor.manyWarnings', { count: viewer.messages })}</em> : null}
      </div>
      <div className="terminais-viewer__actions">
        {converted ? <button type="button" className="terminais-pane__tool" onClick={() => actions.reconvert(tab)} title={translate('terminal.editor.reconvertTitle')} aria-label={translate('terminal.editor.reconvert')}><RefreshCw size={13} strokeWidth={1.75} /></button> : null}
        {!converted && canConvertToPdf(tab.name) ? <button type="button" className="btn btn-quiet btn-sm" onClick={() => actions.viewAsPdf(tab)} title={translate('terminal.editor.convertPdfTitle')}><FileText size={12} />{translate('terminal.editor.viewPdf')}</button> : null}
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => actions.openDefault(tab)}><ExternalLink size={12} />{translate('terminal.common.openDefault')}</button>
        <button type="button" className="terminais-pane__tool" onClick={() => actions.reveal(tab)} title={translate('terminal.common.reveal')} aria-label={translate('terminal.common.reveal')}><FolderOpen size={13} strokeWidth={1.75} /></button>
      </div>
    </div>
  );
}

function ViewerBody({ tab }) {
  const viewer = tab.viewer;
  if (!viewer) return <DataState type="loading" message={translate('terminal.editor.openingFile')} />;
  if (viewer.kind === 'pdf') return <PdfView tab={tab} />;
  if (viewer.kind === 'sheet') return <SheetView tab={tab} />;
  if (viewer.kind === 'docx') return <DocxView tab={tab} />;
  if (viewer.kind === 'error') return <DataState type="error" message={viewer.message} />;
  return null;
}

function DiffView({ tab }) {
  if (tab.error) return <DataState type="error" message={tab.error} />;
  const text = tab.diff?.text || '';
  if (!text.trim()) return <DataState type="empty" message={translate('terminal.editor.noDiff')} />;
  const lines = text.split('\n');
  return (
    <div className="terminais-diff" role="document" aria-label={translate('terminal.editor.changesOf', { name: tab.name })}>
      {tab.diff?.untracked ? <div className="terminais-diff__note">{translate('terminal.editor.untrackedDiff')}</div> : null}
      <pre>
        {lines.map((line, index) => {
          let kind = '';
          if (line.startsWith('+++') || line.startsWith('---')) kind = 'file';
          else if (line.startsWith('@@')) kind = 'hunk';
          else if (line.startsWith('+')) kind = 'add';
          else if (line.startsWith('-')) kind = 'del';
          else if (line.startsWith('diff ') || line.startsWith('index ')) kind = 'meta';
          return <span key={index} className={kind ? `is-${kind}` : undefined}>{line}{'\n'}</span>;
        })}
      </pre>
      {tab.diff?.truncated ? <div className="terminais-diff__note">{translate('terminal.editor.diffTruncated')}</div> : null}
    </div>
  );
}

function ConflictBanner({ tab, actions }) {
  if (!tab.conflict) return null;
  if (tab.conflict === 'deleted') {
    return (
      <div className="terminais-banner terminais-banner--warn" role="alert">
        <AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
        <span>{translate('terminal.editor.removedFromDisk')}</span>
        <span className="terminais-banner__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => actions.saveAgain(tab)}>{translate('terminal.editor.saveAgain')}</button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => actions.close(tab, { force: true })}>{translate('terminal.editor.closeTab')}</button>
        </span>
      </div>
    );
  }
  return (
    <div className="terminais-banner terminais-banner--warn" role="alert">
      <AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
      <span>{translate('terminal.editor.changedOnDisk')}</span>
      <span className="terminais-banner__actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => actions.reload(tab)}>{translate('terminal.editor.reloadDisk')}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => actions.saveAgain(tab)}>{translate('terminal.editor.overwrite')}</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => actions.keepConflict(tab)}>{translate('terminal.editor.keepMine')}</button>
      </span>
    </div>
  );
}

function previewLabel(kind) {
  if (kind === 'html') return translate('terminal.editor.htmlMode');
  if (kind === 'csv') return translate('terminal.editor.csvMode');
  return translate('terminal.editor.markdownMode');
}

function EditorPane({ session, tabs, activeTab, actions, focusKey, dropping = false }) {
  useI18n();
  useRuntimeEvents(['editor'], session.id);
  const stripRef = useRef(null);
  useEffect(() => {
    const node = stripRef.current?.querySelector('.is-active');
    node?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [activeTab?.id]);

  const previewable = activeTab && isPreviewable(activeTab.kind) && !activeTab.loading && activeTab.view;
  const previewing = previewable && activeTab.mode === 'preview';
  const viewer = activeTab && !activeTab.loading && isViewerKind(activeTab.kind);

  return (
    <section className={`terminais-editor${dropping ? ' is-drop' : ''}`} aria-label={translate('terminal.editor.label')}>
      <div className="terminais-tabs" role="tablist" ref={stripRef}>
        {tabs.map((tab) => {
          const active = tab.id === activeTab?.id;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={`terminais-tab${active ? ' is-active' : ''}${tab.dirty ? ' is-dirty' : ''}${tab.kind === 'diff' ? ' is-diff' : ''}${tab.kind === 'browser' ? ' is-browser' : ''}`}
              onClick={() => actions.activate(tab)}
              onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); actions.close(tab); } }}
              onKeyDown={(event) => { if (event.key === 'Enter') actions.activate(tab); }}
              title={shortPath(tab.path)}
            >
              {tab.kind === 'browser' ? <Globe size={12} strokeWidth={1.75} aria-hidden="true" className="terminais-tab__icon" /> : null}
              <span className="terminais-tab__name">{tabName(tab)}</span>
              <button
                type="button"
                className="terminais-tab__close"
                aria-label={translate(tab.dirty ? 'terminal.editor.closeNamedDirty' : 'terminal.editor.closeNamed', { name: tabName(tab) })}
                onClick={(event) => { event.stopPropagation(); actions.close(tab); }}
              >
                <span className="terminais-tab__dot" aria-hidden="true" />
                <X size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      {activeTab ? (
        <div className="terminais-editor__body" key={activeTab.id}>
          {previewable ? (
            <div className="terminais-editor__bar">
              <div className="segmented" role="tablist" aria-label={previewLabel(activeTab.kind)}>
                <button type="button" role="tab" aria-selected={!previewing} className={`segmented__option${!previewing ? ' is-selected' : ''}`} onClick={() => actions.setMode(activeTab, 'edit')}>{translate(activeTab.kind === 'html' ? 'terminal.editor.code' : 'terminal.editor.edit')}</button>
                <button type="button" role="tab" aria-selected={previewing} className={`segmented__option${previewing ? ' is-selected' : ''}`} onClick={() => actions.setMode(activeTab, 'preview')}>{translate(activeTab.kind === 'csv' ? 'terminal.editor.table' : 'terminal.editor.preview')}</button>
              </div>
              {previewing && activeTab.kind === 'html' ? (
                <>
                  <button type="button" className="terminais-pane__tool" onClick={() => actions.refreshPreview(activeTab)} title={translate('terminal.editor.reloadPreview')} aria-label={translate('terminal.editor.reloadPreview')}><RefreshCw size={13} strokeWidth={1.75} /></button>
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => actions.openDefault(activeTab)}><ExternalLink size={12} />{translate('terminal.editor.openBrowser')}</button>
                </>
              ) : null}
            </div>
          ) : null}
          {viewer ? <ViewerBar tab={activeTab} actions={actions} /> : null}
          {activeTab.kind === 'browser' ? <BrowserPane session={session} /> : null}
          <ConflictBanner tab={activeTab} actions={actions} />
          {activeTab.loading ? (
            <DataState type="loading" message={translate(activeTab.kind === 'office' ? 'terminal.editor.convertingOffice' : 'terminal.editor.openingFile')} />
          ) : null}
          {!activeTab.loading && activeTab.kind === 'error' ? (
            <DataState type="error" message={activeTab.error || translate('terminal.editor.openFailed')} action={<button type="button" className="btn btn-ghost btn-sm" onClick={() => actions.openDefault(activeTab)}>{translate('terminal.common.openDefault')}</button>} />
          ) : null}
          {!activeTab.loading && activeTab.view && !previewing ? (
            <TextHost tab={activeTab} focusKey={focusKey} />
          ) : null}
          {previewing && activeTab.kind === 'markdown' ? <MarkdownPreview tab={activeTab} /> : null}
          {previewing && activeTab.kind === 'html' ? <HtmlPreview tab={activeTab} root={session.explorer.root} /> : null}
          {previewing && activeTab.kind === 'csv' ? <ViewerBody tab={activeTab} /> : null}
          {viewer ? <ViewerBody tab={activeTab} /> : null}
          {!activeTab.loading && activeTab.kind === 'image' && activeTab.image ? (
            <div className="terminais-image">
              <img src={activeTab.image.dataUrl} alt={activeTab.name} />
              <div className="terminais-image__meta">{fmtBytes(activeTab.image.size)}</div>
            </div>
          ) : null}
          {!activeTab.loading && activeTab.kind === 'binary' ? (
            <div className="terminais-unsupported">
              <strong>{activeTab.name}</strong>
              <span>{activeTab.error || translate('terminal.editor.unsupported')}{activeTab.size ? ` ${fmtBytes(activeTab.size)}.` : ''}</span>
              <span className="terminais-unsupported__actions">
                {activeTab.viewerKind ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => actions.reconvert(activeTab)}><RefreshCw size={13} />{translate('terminal.common.tryAgain')}</button> : null}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => actions.openDefault(activeTab)}><ExternalLink size={13} />{translate('terminal.common.openDefault')}</button>
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => actions.reveal(activeTab)}><FolderOpen size={13} />{translate('terminal.common.revealAction')}</button>
              </span>
            </div>
          ) : null}
          {!activeTab.loading && activeTab.kind === 'diff' ? <DiffView tab={activeTab} /> : null}
        </div>
      ) : null}
      {session && !activeTab ? <div className="terminais-editor__none">{translate('terminal.editor.noneOpen')}</div> : null}
    </section>
  );
}

export default memo(EditorPane);
