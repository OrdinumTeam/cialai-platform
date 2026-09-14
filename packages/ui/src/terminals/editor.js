// SPDX-License-Identifier: Apache-2.0
// Editor do estudio sobre o CodeMirror 6. Cada aba e um objeto do runtime da
// sessao, com a EditorView viva fora do React: a area central so adota o DOM
// da aba ativa. Assim trocar de sessao ou de aba preserva historico de
// desfazer, cursor e rolagem.
//
// Seguranca de conteudo: o arquivo so e gravado quando a data de modificacao
// no disco e a mesma que foi lida. Se mudou por fora, o Rust recusa e a
// interface pergunta. Um arquivo aberto sem alteracoes locais e recarregado
// em silencio quando muda no disco; com alteracoes, a aba mostra o conflito
// e nada e sobrescrito sem o usuario escolher.

import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, keymap, drawSelection,
  highlightSpecialChars, rectangularSelection, crosshairCursor, dropCursor,
} from '@codemirror/view';
import { defaultKeymap, deleteLine, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import {
  bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle, foldGutter, foldKeymap, indentUnit,
  LanguageDescription,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';
import { Marked } from 'marked';
import { baseName, dirName, fileKind, fs, git, isViewerKind, joinPath, office, FsError } from './files.js';
import { addTab, allTabs, findTab, getSession, removeTab, setTabPath, subscribeChanges, touchTab } from './runtime.js';
import { chooseSavePath, previewUrl } from '../lib/native.js';
import { translate } from '../shared/i18n.js';

// Limites das previas de planilha: linhas lidas do arquivo e colunas
// mostradas, para uma planilha grande nao montar centenas de milhares de
// celulas.
const SHEET_ROWS = 2000;
const SHEET_COLS = 200;
import { isDarkTheme, watchTheme } from './theme.js';

let nextTabId = 0;
function tabId() {
  nextTabId += 1;
  return `tab${nextTabId}`;
}

/* ── tema ─────────────────────────────────────────────────────────── */

// Cores por variaveis CSS do Terminais.css, entao o mesmo tema serve ao
// claro e ao escuro; so a bandeira `dark` muda, para o CodeMirror escolher
// os padroes internos certos.
function buildEditorTheme(dark) {
  return EditorView.theme({
    '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--mac-surface)', color: 'var(--mac-label)' },
    '.cm-scroller': { fontFamily: 'var(--mac-font-mono)', lineHeight: '1.55', overflow: 'auto' },
    '.cm-content': { padding: '8px 0 40vh', caretColor: 'var(--mac-label)' },
    '.cm-line': { padding: '0 12px 0 6px' },
    '.cm-gutters': { backgroundColor: 'var(--mac-surface)', color: 'var(--mac-label-4)', border: 'none', paddingLeft: '6px' },
    '.cm-lineNumbers .cm-gutterElement': { minWidth: '3.2em', fontVariantNumeric: 'tabular-nums' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--mac-label-2)' },
    '.cm-activeLine': { backgroundColor: 'var(--terminais-editor-line)' },
    '.cm-foldGutter .cm-gutterElement': { color: 'var(--mac-label-3)' },
    '&.cm-focused': { outline: 'none' },
    '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--mac-label)' },
    '.cm-cursor': { borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--mac-accent-soft-hover) !important' },
    '.cm-selectionMatch': { backgroundColor: 'var(--terminais-editor-match)' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--terminais-editor-match)', outline: 'none' },
    '.cm-searchMatch': { backgroundColor: 'var(--terminais-editor-search)', outline: '1px solid var(--mac-warn)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--mac-warn-bg)' },
    '.cm-panels': { backgroundColor: 'var(--mac-surface-2)', color: 'var(--mac-label)', borderColor: 'var(--mac-separator)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--mac-separator)' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--mac-separator)' },
    '.cm-panel.cm-search': { padding: '6px 10px', fontFamily: 'var(--mac-font)', fontSize: '12px' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: 'var(--mac-font)', fontSize: '12px' },
    '.cm-panel.cm-search input': { border: '1px solid var(--mac-separator-strong)', borderRadius: '6px', padding: '2px 6px', background: 'var(--mac-field)', color: 'var(--mac-label)' },
    '.cm-panel.cm-search button': { border: '1px solid var(--mac-separator-strong)', borderRadius: '6px', padding: '2px 8px', background: 'var(--mac-surface)', color: 'var(--mac-label)', backgroundImage: 'none', textTransform: 'none' },
    '.cm-panel.cm-search label': { fontSize: '11px', color: 'var(--mac-label-2)' },
    '.cm-panel.cm-search [name=close]': { color: 'var(--mac-label-2)', fontSize: '16px' },
    '.cm-tooltip': { border: '1px solid var(--mac-separator)', backgroundColor: 'var(--mac-glass)', borderRadius: '8px' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--mac-surface-3)', border: 'none', color: 'var(--mac-label-2)' },
  }, { dark });
}

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: 'var(--terminais-syn-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.character], color: 'var(--terminais-syn-string)' },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom], color: 'var(--terminais-syn-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--terminais-syn-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: 'var(--terminais-syn-function)' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)], color: 'var(--terminais-syn-type)' },
  { tag: [tags.propertyName, tags.attributeName, tags.definition(tags.propertyName)], color: 'var(--terminais-syn-property)' },
  { tag: [tags.variableName, tags.definition(tags.variableName), tags.local(tags.variableName)], color: 'var(--mac-label)' },
  { tag: [tags.tagName, tags.angleBracket], color: 'var(--terminais-syn-tag)' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket, tags.derefOperator], color: 'var(--mac-label-2)' },
  { tag: [tags.regexp, tags.escape, tags.url, tags.link], color: 'var(--terminais-syn-regexp)' },
  { tag: tags.heading, fontWeight: '600', color: 'var(--mac-label)' },
  { tag: tags.heading1, fontSize: '1.2em' },
  { tag: tags.heading2, fontSize: '1.1em' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.meta, tags.processingInstruction, tags.labelName], color: 'var(--mac-label-3)' },
  { tag: tags.invalid, color: 'var(--mac-bad)' },
  { tag: [tags.inserted], color: 'var(--mac-ok)' },
  { tag: [tags.deleted], color: 'var(--mac-bad)' },
]);

const themeCompartment = new Compartment();
const languageCompartment = new Compartment();
const readOnlyCompartment = new Compartment();

let themeWatchInstalled = false;
const openViews = new Set();
function ensureThemeWatch() {
  if (themeWatchInstalled) return;
  themeWatchInstalled = true;
  watchTheme(() => {
    const theme = buildEditorTheme(isDarkTheme());
    openViews.forEach((view) => view.dispatch({ effects: themeCompartment.reconfigure(theme) }));
  });
}

async function languageFor(name) {
  const description = LanguageDescription.matchFilename(languages, name);
  if (!description) return null;
  try {
    const support = await description.load();
    return support;
  } catch (_error) {
    return null;
  }
}

/* ── abas ─────────────────────────────────────────────────────────── */

function makeTab(path, kind) {
  return {
    id: tabId(),
    kind,
    path,
    name: baseName(path),
    session: null,
    view: null,
    savedDoc: '',
    modifiedMs: null,
    lineEnding: 'lf',
    dirty: false,
    conflict: null,
    loading: true,
    error: null,
    mode: 'edit',
    image: null,
    // Resultado de um visualizador sem editor: pdf, planilha, Word ou a
    // conversao de um documento do Office.
    viewer: null,
    viewerKind: null,
    size: null,
    diff: null,
    reloadedAt: 0,
    watchPath: kind === 'diff' ? null : path,
    language: null,
  };
}

function isDirty(tab) {
  if (!tab.view) return false;
  const doc = tab.view.state.doc;
  if (doc.length !== tab.savedDoc.length) return true;
  return doc.toString() !== tab.savedDoc;
}

function buildView(tab, content, language) {
  ensureThemeWatch();
  const keys = keymap.of([
    { key: 'Mod-s', run: () => { saveTab(tab).catch(() => {}); return true; } },
    { key: 'Mod-f', run: openSearchPanel },
    // ⌘⌫ e ⌘⌦ apagam a linha inteira. Vem antes do keymap padrao, onde ⌘⌫
    // apagaria so do cursor ate o comeco da linha.
    { key: 'Mod-Backspace', run: deleteLine },
    { key: 'Mod-Shift-Backspace', run: deleteLine },
    { key: 'Mod-Delete', run: deleteLine },
    ...defaultKeymap,
    ...historyKeymap,
    ...searchKeymap,
    ...foldKeymap,
    indentWithTab,
  ]);
  const view = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        indentUnit.of('  '),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        syntaxHighlighting(highlight),
        themeCompartment.of(buildEditorTheme(isDarkTheme())),
        languageCompartment.of(language ? [language] : []),
        readOnlyCompartment.of(EditorState.readOnly.of(false)),
        EditorView.lineWrapping,
        keys,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const dirty = isDirty(tab);
          if (dirty !== tab.dirty) {
            tab.dirty = dirty;
            touchTab(tab);
          }
        }),
      ],
    }),
  });
  openViews.add(view);
  tab.onDispose = () => openViews.delete(view);
  return view;
}

let untitledCount = 0;

// ⌘N: aba nova sem arquivo no disco, como o `Sem título` do VS Code. Ela
// nasce suja, nao e observada e so ganha caminho no primeiro ⌘S, pelo
// painel de salvar do sistema.
export function newUntitled(sessionId) {
  const session = getSession(sessionId);
  if (!session) return null;
  untitledCount += 1;
  const tab = makeTab(null, 'text');
  tab.name = translate('terminal.editor.untitled', { count: untitledCount });
  tab.untitled = true;
  tab.watchPath = null;
  tab.loading = false;
  tab.savedDoc = '';
  tab.view = buildView(tab, '', null);
  addTab(sessionId, tab);
  return tab;
}

// Abre o arquivo numa aba da sessao, ou ativa a aba que ja existe.
export async function openFile(sessionId, path, { activate = true } = {}) {
  const session = getSession(sessionId);
  if (!session) return null;
  const existing = findTab(sessionId, path);
  if (existing) {
    if (activate) session.editor.activeId = existing.id;
    touchTab(existing);
    return existing;
  }
  const kind = fileKind(path);
  const tab = makeTab(path, kind);
  addTab(sessionId, tab, { activate });
  await loadTab(tab);
  return tab;
}

async function loadTab(tab, { force = false } = {}) {
  tab.loading = true;
  tab.error = null;
  touchTab(tab);
  try {
    if (tab.kind === 'image') {
      const image = await fs.readImage(tab.path);
      tab.image = { dataUrl: image.dataUrl, size: image.size };
      tab.modifiedMs = image.modifiedMs ?? null;
    } else if (tab.kind === 'binary') {
      const stat = await fs.stat(tab.path);
      tab.modifiedMs = stat.modifiedMs ?? null;
      tab.size = stat.size;
    } else if (isViewerKind(tab.kind)) {
      tab.viewerKind = tab.kind;
      await loadViewer(tab, force);
    } else {
      const file = await fs.readText(tab.path);
      tab.savedDoc = file.content;
      tab.modifiedMs = file.modifiedMs ?? null;
      tab.lineEnding = file.lineEnding;
      tab.size = file.size;
      const language = await languageFor(tab.name);
      tab.language = language ? tab.name : null;
      tab.view = buildView(tab, file.content, language);
      tab.dirty = false;
    }
  } catch (error) {
    if (error instanceof FsError && error.code === 'binary') {
      tab.kind = 'binary';
      tab.error = null;
    } else if (error instanceof FsError && error.code === 'too_large') {
      tab.kind = 'binary';
      tab.error = error.message;
    } else if (tab.viewerKind && error instanceof FsError && ['unsupported', 'missing_tool', 'timeout', 'unavailable'].includes(error.code)) {
      // Sem conversor, sem tempo ou fora do app: a aba oferece abrir fora
      // e tentar de novo.
      tab.kind = 'binary';
      tab.error = error.message;
    } else {
      tab.kind = 'error';
      tab.error = error?.message || String(error);
    }
  } finally {
    tab.loading = false;
    touchTab(tab);
  }
}

/* ── visualizadores sem editor ────────────────────────────────────── */

async function statTab(tab) {
  const stat = await fs.stat(tab.path);
  tab.modifiedMs = stat.modifiedMs ?? null;
  tab.size = stat.size;
  return stat;
}

// PDF: o visualizador do WebKit num iframe, pelo protocolo preview:// da
// pasta que contem o arquivo. A data entra na URL para o iframe recarregar
// quando o arquivo muda.
async function loadPdf(tab) {
  const stat = await statTab(tab);
  const url = await previewUrl(dirName(tab.path), tab.name);
  if (!url) throw new FsError('unavailable', translate('terminal.common.desktopOnly'));
  tab.viewer = { kind: 'pdf', url: `${url}?v=${stat.modifiedMs || 0}` };
}

function colLetter(index) {
  let value = index;
  let text = '';
  do {
    text = String.fromCharCode(65 + (value % 26)) + text;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return text;
}

function sheetTable(XLSX, sheet, name) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
  const truncatedRows = rows.length > SHEET_ROWS;
  const kept = rows.slice(0, SHEET_ROWS);
  let cols = 0;
  kept.forEach((row) => { cols = Math.max(cols, row.length); });
  const truncatedCols = cols > SHEET_COLS;
  const width = Math.min(cols, SHEET_COLS);
  return {
    name,
    columns: Array.from({ length: width }, (_, index) => colLetter(index)),
    rows: kept.map((row) => Array.from({ length: width }, (_, index) => (row[index] == null ? '' : String(row[index])))),
    truncatedRows,
    truncatedCols,
  };
}

// Planilha: SheetJS le os bytes e cada aba vira uma tabela com limites.
async function loadSheet(tab) {
  await statTab(tab);
  const buffer = await fs.readBytes(tab.path);
  const XLSX = await import('xlsx');
  const book = XLSX.read(new Uint8Array(buffer), { type: 'array', dense: true, sheetRows: SHEET_ROWS + 1 });
  const sheets = book.SheetNames.map((name) => sheetTable(XLSX, book.Sheets[name], name));
  tab.viewer = { kind: 'sheet', sheets };
}

// CSV e TSV abertos no editor ganham a mesma tabela a partir do texto atual.
export async function buildCsvPreview(tab) {
  const XLSX = await import('xlsx');
  const text = contentOf(tab);
  const book = XLSX.read(text, { type: 'string', dense: true, sheetRows: SHEET_ROWS + 1, FS: tab.name.toLowerCase().endsWith('.tsv') ? '\t' : undefined });
  const sheets = book.SheetNames.map((name) => sheetTable(XLSX, book.Sheets[name], tab.name));
  tab.viewer = { kind: 'sheet', sheets, nonce: tab.previewNonce || 0 };
  touchTab(tab);
}

// O HTML do mammoth vem do proprio documento: nada de script, estilo,
// quadro ou atributo de evento chega ao DOM, e links so abrem http e https.
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, link, meta, form, input, button').forEach((node) => node.remove());
  doc.querySelectorAll('*').forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = String(attribute.value || '').trim().toLowerCase();
      if (name.startsWith('on')) node.removeAttribute(attribute.name);
      else if ((name === 'href' || name === 'src') && !/^(https?:|data:image\/|#)/.test(value)) node.removeAttribute(attribute.name);
    });
  });
  return doc.body.innerHTML;
}

// Word: mammoth transforma o docx em HTML semantico, com as imagens
// embutidas, que a folha de Markdown veste com o tema do app.
async function loadDocx(tab) {
  await statTab(tab);
  const buffer = await fs.readBytes(tab.path);
  const module = await import('mammoth');
  const mammoth = module.default || module;
  const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
  tab.viewer = { kind: 'docx', html: sanitizeHtml(result.value || ''), messages: (result.messages || []).length };
}

// Office, iWork e RTF: o Rust converte para PDF pelo LibreOffice e o iframe
// mostra o resultado, como um PDF qualquer.
async function loadOffice(tab, force) {
  const stat = await statTab(tab);
  const result = await office.convert(tab.path, force);
  tab.viewer = { kind: 'pdf', url: `${result.url}?v=${stat.modifiedMs || 0}`, converted: true, cached: Boolean(result.cached), pdfPath: result.pdfPath };
}

async function loadViewer(tab, force) {
  tab.viewer = null;
  if (tab.kind === 'pdf') await loadPdf(tab);
  else if (tab.kind === 'sheet') await loadSheet(tab);
  else if (tab.kind === 'docx') await loadDocx(tab);
  else if (tab.kind === 'office') await loadOffice(tab, force);
}

// Botao "Reconverter" ou "Tentar de novo": volta ao visualizador de origem e
// refaz a leitura ignorando o cache.
export async function reconvertTab(tab) {
  if (!tab.viewerKind) return;
  tab.kind = tab.viewerKind;
  await loadTab(tab, { force: true });
}

// "Ver como PDF" num Word ou numa planilha: troca a rota para a conversao.
export async function viewAsPdf(tab) {
  if (!tab.path) return;
  tab.kind = 'office';
  await loadTab(tab);
}

export function contentOf(tab) {
  if (!tab.view) return tab.savedDoc;
  const text = tab.view.state.doc.toString();
  return tab.lineEnding === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text;
}

// Escolhe o lugar de uma aba temporaria e grava. Devolve false quando o
// usuario fecha o painel de salvar sem escolher.
async function saveUntitled(tab) {
  const root = tab.session?.explorer?.root || tab.session?.cwd || null;
  const path = await chooseSavePath({ title: translate('terminal.editor.saveFile'), defaultPath: root ? joinPath(root, tab.name) : tab.name });
  if (!path) return false;
  const content = contentOf(tab);
  const result = await fs.writeText(path, content, null);
  const name = baseName(path);
  const kind = fileKind(name);
  // O conteudo continua sendo o texto do editor mesmo que a extensao
  // escolhida seja de imagem, binario ou de um visualizador.
  tab.kind = kind === 'image' || kind === 'binary' || isViewerKind(kind) ? 'text' : kind;
  tab.untitled = false;
  setTabPath(tab, path, name);
  tab.savedDoc = tab.view.state.doc.toString();
  tab.modifiedMs = result.modifiedMs ?? null;
  tab.dirty = false;
  tab.conflict = null;
  const language = await languageFor(name);
  tab.language = language ? name : null;
  tab.view.dispatch({ effects: languageCompartment.reconfigure(language ? [language] : []) });
  touchTab(tab);
  return true;
}

// Um arquivo aberto mudou de lugar no explorador: a aba segue o caminho
// novo, sem recarregar o conteudo nem perder o historico de desfazer.
export function retargetTabs(from, to) {
  allTabs().forEach((tab) => {
    if (!tab.path || tab.kind === 'diff') return;
    if (tab.path !== from && !tab.path.startsWith(`${from}/`)) return;
    const next = tab.path === from ? to : `${to}${tab.path.slice(from.length)}`;
    setTabPath(tab, next, baseName(next));
  });
}

// Grava a aba. Com `force`, ignora a data lida e sobrescreve o disco.
export async function saveTab(tab, { force = false } = {}) {
  if (!tab.view || tab.kind === 'diff' || tab.loading) return false;
  if (!tab.path) return saveUntitled(tab);
  const content = contentOf(tab);
  try {
    const result = await fs.writeText(tab.path, content, force ? null : tab.modifiedMs);
    tab.savedDoc = tab.view.state.doc.toString();
    tab.modifiedMs = result.modifiedMs ?? null;
    tab.dirty = false;
    tab.conflict = null;
    tab.previewNonce = (tab.previewNonce || 0) + 1;
    touchTab(tab);
    return true;
  } catch (error) {
    if (error instanceof FsError && error.code === 'conflict') {
      tab.conflict = 'disk-changed';
      touchTab(tab);
    }
    throw error;
  }
}

// Recarrega do disco, descartando o que estava no editor.
export async function reloadTab(tab) {
  if (tab.kind === 'image' || tab.kind === 'binary' || isViewerKind(tab.kind)) {
    await loadTab(tab);
    return;
  }
  if (!tab.view) return;
  const file = await fs.readText(tab.path);
  const view = tab.view;
  const selection = view.state.selection.main;
  const anchor = Math.min(selection.anchor, file.content.length);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: file.content },
    selection: { anchor },
  });
  tab.savedDoc = file.content;
  tab.modifiedMs = file.modifiedMs ?? null;
  tab.lineEnding = file.lineEnding;
  tab.dirty = false;
  tab.conflict = null;
  tab.reloadedAt = Date.now();
  touchTab(tab);
}

export function closeTab(sessionId, tab) {
  removeTab(sessionId, tab.id);
}

export function setTabMode(tab, mode) {
  tab.mode = mode;
  tab.previewNonce = (tab.previewNonce || 0) + 1;
  touchTab(tab);
  if (mode === 'preview' && tab.kind === 'csv') buildCsvPreview(tab).catch((error) => { tab.viewer = { kind: 'error', message: error?.message || String(error) }; touchTab(tab); });
}

// Recarrega a visualizacao de HTML sem mexer no editor.
export function refreshPreview(tab) {
  tab.previewNonce = (tab.previewNonce || 0) + 1;
  touchTab(tab);
  if (tab.mode === 'preview' && tab.kind === 'csv') buildCsvPreview(tab).catch(() => {});
}

// O arquivo mudou no disco: recarrega em silencio se nao ha alteracoes
// locais, senao marca o conflito para a interface perguntar.
async function onDiskChange(tab, kind) {
  if (tab.loading || tab.kind === 'diff') return;
  if (kind === 'removed') {
    const stat = await fs.stat(tab.path).catch(() => null);
    if (!stat || !stat.exists) {
      tab.conflict = 'deleted';
      touchTab(tab);
      return;
    }
  }
  const stat = await fs.stat(tab.path).catch(() => null);
  if (!stat || !stat.exists) {
    tab.conflict = 'deleted';
    touchTab(tab);
    return;
  }
  if (stat.modifiedMs === tab.modifiedMs) return;
  if (tab.kind === 'image' || tab.kind === 'binary' || isViewerKind(tab.kind)) {
    await loadTab(tab);
    return;
  }
  if (!tab.dirty) {
    await reloadTab(tab).catch(() => {});
    return;
  }
  tab.conflict = 'disk-changed';
  touchTab(tab);
}

let changesInstalled = false;
export function installEditorWatch() {
  if (changesInstalled) return;
  changesInstalled = true;
  subscribeChanges((event) => {
    if (event.dir) return;
    // Varias sessoes podem ter o mesmo arquivo aberto: cada aba decide.
    allTabs().forEach((tab) => {
      if (tab.path === event.path) onDiskChange(tab, event.kind).catch(() => {});
    });
  });
}

// Restaura as abas lembradas de uma sessao, sem ativar a primeira que nao
// era a ativa. Arquivos que sumiram sao ignorados.
export async function restoreTabs(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;
  const paths = session.editor.restoreTabs || [];
  session.editor.restoreTabs = [];
  if (!paths.length) return;
  for (const path of paths) {
    const stat = await fs.stat(path).catch(() => null);
    if (!stat || !stat.exists || stat.kind === 'dir') continue;
    await openFile(sessionId, path, { activate: false });
  }
  if (!session.editor.tabs.some((tab) => tab.id === session.editor.activeId)) {
    session.editor.activeId = session.editor.tabs[0]?.id || null;
  }
  touchTab(session.editor.tabs[0] || null);
}

/* ── diff ─────────────────────────────────────────────────────────── */

export async function openDiff(sessionId, root, path) {
  const session = getSession(sessionId);
  if (!session) return null;
  const existing = session.editor.tabs.find((tab) => tab.kind === 'diff' && tab.path === path);
  if (existing) {
    session.editor.activeId = existing.id;
    touchTab(existing);
    return existing;
  }
  const tab = makeTab(path, 'diff');
  tab.name = translate('terminal.editor.diffTab', { name: baseName(path) });
  addTab(sessionId, tab);
  try {
    const result = await git.diff(root, path);
    tab.diff = { text: result.diff, untracked: result.untracked, truncated: result.truncated };
  } catch (error) {
    tab.error = error?.message || String(error);
  } finally {
    tab.loading = false;
    touchTab(tab);
  }
  return tab;
}

/* ── markdown ─────────────────────────────────────────────────────── */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// HTML embutido no Markdown vira texto: a previa nunca executa nem injeta
// marcacao do arquivo.
const markdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html(token) { return `<span class="terminais-md__raw">${escapeHtml(token.text ?? token.raw ?? '')}</span>`; },
  },
});

export function renderMarkdown(text) {
  try {
    return markdown.parse(String(text || ''), { async: false });
  } catch (_error) {
    return `<pre>${escapeHtml(text)}</pre>`;
  }
}

export function tabIsDirty(tab) {
  return Boolean(tab && tab.dirty);
}
