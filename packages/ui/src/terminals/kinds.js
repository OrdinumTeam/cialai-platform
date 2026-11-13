// SPDX-License-Identifier: Apache-2.0
// Classificacao de arquivos por extensao, sem dependencias: o editor escolhe
// a rota antes de ler, e os testes rodam em Node sem puxar a ponte nativa.
// O Rust ainda confere o conteudo ao abrir; isto so decide o caminho.
//
// Rotas: text, markdown, html e csv abrem no CodeMirror, os tres ultimos com
// uma visualizacao a mais; image tem previa; pdf, sheet, docx, office, audio,
// video, font e notebook sao visualizadores sem editor; binary so oferece
// abrir fora.

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic', 'tif', 'tiff']);
const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx']);
const HTML_EXT = new Set(['html', 'htm', 'xhtml']);
const PDF_EXT = new Set(['pdf']);
const SHEET_EXT = new Set(['xlsx', 'xlsm', 'xls', 'ods']);
const CSV_EXT = new Set(['csv', 'tsv']);
const DOCX_EXT = new Set(['docx']);
// Convertidos para PDF pelo LibreOffice no Rust.
const OFFICE_EXT = new Set(['pptx', 'ppt', 'odp', 'key', 'pages', 'numbers', 'doc', 'rtf', 'odt']);
// Tocados pelo proprio webview. O codec decide: um formato que o sistema nao
// toca cai no aviso com abrir fora.
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv']);
const FONT_EXT = new Set(['ttf', 'otf', 'woff', 'woff2']);
const NOTEBOOK_EXT = new Set(['ipynb']);
const BINARY_EXT = new Set([
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'dmg', 'pkg', 'app', 'exe', 'dll', 'so', 'dylib', 'a', 'o',
  'class', 'jar', 'war', 'wasm', 'bin', 'dat', 'db', 'sqlite', 'sqlite3', 'avi', 'mkv', 'eot', 'icns', 'psd',
  'ai', 'sketch', 'fig', 'pyc', 'lockb', 'DS_Store',
]);

const VIEWER_KINDS = new Set(['pdf', 'sheet', 'docx', 'office', 'audio', 'video', 'font', 'notebook']);

// Realce para nomes que o language-data nao reconhece sozinho. O editor
// tenta antes a busca por nome e extensao do proprio language-data, que ja
// cobre Dockerfile, CMakeLists.txt e parecidos; isto so completa. Arquivos de
// ignorar e Makefile ganham o realce de Shell pelos comentarios e comandos.
const LANGUAGE_BY_NAME = [
  [/^\.env(\..+)?$/i, 'Properties files'],
  [/^\.(editorconfig|npmrc|yarnrc|gitconfig|gitmodules|gitattributes|pypirc)$/i, 'Properties files'],
  [/^\.(bashrc|bash_profile|bash_aliases|bash_logout|zshrc|zprofile|zshenv|zlogin|profile|envrc)$/i, 'Shell'],
  [/^\.[\w.-]*ignore$/i, 'Shell'],
  [/^(gnu)?makefile$/i, 'Shell'],
  [/^(cargo|poetry|uv|pdm|pixi)\.lock$/i, 'TOML'],
  [/^(composer|flake|deno)\.lock$/i, 'JSON'],
  [/^pubspec\.lock$/i, 'YAML'],
];
const LANGUAGE_BY_EXT = {
  zsh: 'Shell', fish: 'Shell', mk: 'Shell', make: 'Shell', env: 'Properties files', cfg: 'Properties files',
  conf: 'Properties files', jsonc: 'JSON', json5: 'JSON', mdx: 'Markdown',
};

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
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (FONT_EXT.has(ext)) return 'font';
  if (NOTEBOOK_EXT.has(ext)) return 'notebook';
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

// Nome da linguagem do language-data para realcar um arquivo que a busca
// dele nao reconhece. Null quando nao ha nada a acrescentar.
export function languageAlias(name) {
  const base = nameOf(name);
  const byName = LANGUAGE_BY_NAME.find(([pattern]) => pattern.test(base));
  if (byName) return byName[1];
  return LANGUAGE_BY_EXT[extensionOf(base)] || null;
}
