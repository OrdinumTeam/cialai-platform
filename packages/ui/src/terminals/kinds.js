// SPDX-License-Identifier: Apache-2.0
// Classificacao de arquivos por extensao, sem dependencias: o editor escolhe
// a rota antes de ler, e os testes rodam em Node sem puxar a ponte nativa.
// O Rust ainda confere o conteudo ao abrir; isto so decide o caminho.
//
// Rotas: text, markdown, html e csv abrem no CodeMirror, os tres ultimos com
// uma visualizacao a mais; image tem previa; pdf, sheet, docx e office sao
// visualizadores sem editor; binary so oferece abrir fora.

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic', 'tif', 'tiff']);
const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx']);
const HTML_EXT = new Set(['html', 'htm', 'xhtml']);
const PDF_EXT = new Set(['pdf']);
const SHEET_EXT = new Set(['xlsx', 'xlsm', 'xls', 'ods']);
const CSV_EXT = new Set(['csv', 'tsv']);
const DOCX_EXT = new Set(['docx']);
// Convertidos para PDF pelo LibreOffice no Rust.
const OFFICE_EXT = new Set(['pptx', 'ppt', 'odp', 'key', 'pages', 'numbers', 'doc', 'rtf', 'odt']);
const BINARY_EXT = new Set([
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'dmg', 'pkg', 'app', 'exe', 'dll', 'so', 'dylib', 'a', 'o',
  'class', 'jar', 'war', 'wasm', 'bin', 'dat', 'db', 'sqlite', 'sqlite3', 'mp3', 'mp4', 'm4a', 'mov', 'wav',
  'ogg', 'opus', 'flac', 'aac', 'avi', 'mkv', 'webm', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'icns', 'psd',
  'ai', 'sketch', 'fig', 'pyc', 'lock', 'DS_Store',
]);

const VIEWER_KINDS = new Set(['pdf', 'sheet', 'docx', 'office']);

function nameOf(path) {
  const trimmed = String(path || '').replace(/\/+$/, '');
  return trimmed.split('/').pop() || trimmed || '';
}

export function extensionOf(name) {
  const base = nameOf(name);
  const index = base.lastIndexOf('.');
  if (index <= 0) return '';
  return base.slice(index + 1).toLowerCase();
}

export function fileKind(name) {
  const ext = extensionOf(name);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (HTML_EXT.has(ext)) return 'html';
  if (PDF_EXT.has(ext)) return 'pdf';
  if (SHEET_EXT.has(ext)) return 'sheet';
  if (CSV_EXT.has(ext)) return 'csv';
  if (DOCX_EXT.has(ext)) return 'docx';
  if (OFFICE_EXT.has(ext)) return 'office';
  if (BINARY_EXT.has(ext)) return 'binary';
  if (nameOf(name) === '.DS_Store') return 'binary';
  return 'text';
}

// Texto que alterna entre edicao e visualizacao.
export function isPreviewable(kind) {
  return kind === 'markdown' || kind === 'html' || kind === 'csv';
}

// Visualizador sem editor: nao ha EditorView nem salvar.
export function isViewerKind(kind) {
  return VIEWER_KINDS.has(kind);
}

// Formatos que o LibreOffice converte, para o botao "Ver como PDF".
export function canConvertToPdf(name) {
  const ext = extensionOf(name);
  return OFFICE_EXT.has(ext) || DOCX_EXT.has(ext) || SHEET_EXT.has(ext);
}
