// SPDX-License-Identifier: Apache-2.0
// Leitura de notebooks Jupyter para o visualizador, sem dependencias: o
// editor monta a pagina a partir deste modelo e os testes rodam em Node.
//
// Nada daqui vira HTML cru. O Markdown passa pelo mesmo renderizador da
// previa, texto vai escapado pelo React e imagem so entra como data URL de
// imagem. Saida HTML aparece como texto: o notebook vem de qualquer lugar e
// a pagina do app nao executa nem injeta marcacao dele.

// Saida de texto maior que isto e cortada, para um log longo nao montar
// centenas de milhares de linhas.
export const OUTPUT_LIMIT = 100_000;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// O nbformat 3 guardava os tipos com nomes curtos, direto na saida.
const LEGACY_TYPES = [
  ['text', 'text/plain'], ['png', 'image/png'], ['jpeg', 'image/jpeg'], ['svg', 'image/svg+xml'],
  ['html', 'text/html'], ['markdown', 'text/markdown'], ['latex', 'text/latex'], ['json', 'application/json'],
];
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// Cores e movimentos de cursor que tracebacks e barras de progresso trazem.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export class NotebookError extends Error {}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function joined(value) {
  if (Array.isArray(value)) return value.map((part) => (typeof part === 'string' ? part : '')).join('');
  return typeof value === 'string' ? value : '';
}

// Uma barra de progresso reescreve a linha com `\r`: fica so a ultima
// versao, como no Jupyter.
export function cleanOutput(text) {
  return String(text)
    .replace(ANSI, '')
    .split('\n')
    .map((line) => {
      const bare = line.replace(/\r+$/, '');
      return bare.slice(bare.lastIndexOf('\r') + 1);
    })
    .join('\n');
}

function clip(text) {
  const clean = cleanOutput(text);
  if (clean.length <= OUTPUT_LIMIT) return { text: clean, truncated: false };
  return { text: clean.slice(0, OUTPUT_LIMIT), truncated: true };
}

function imageSource(type, value) {
  const data = joined(value).replace(/\s+/g, '');
  return data && BASE64.test(data) ? `data:${type};base64,${data}` : null;
}

function richOutput(data) {
  for (const type of IMAGE_TYPES) {
    const src = data[type] ? imageSource(type, data[type]) : null;
    if (src) return { type: 'image', src };
  }
  const svg = joined(data['image/svg+xml']);
  if (svg) return { type: 'image', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
  const markdown = joined(data['text/markdown']);
  if (markdown) return { type: 'markdown', source: markdown };
  for (const type of ['text/plain', 'text/html', 'text/latex']) {
    if (data[type] != null) return { type: 'text', ...clip(joined(data[type])) };
  }
  if (data['application/json'] != null) {
    return { type: 'text', ...clip(JSON.stringify(data['application/json'], null, 2) || '') };
  }
  return null;
}

function legacyData(output) {
  const data = {};
  LEGACY_TYPES.forEach(([short, type]) => {
    if (output[short] != null) data[type] = output[short];
  });
  return data;
}

function readOutput(output) {
  if (!isObject(output)) return null;
  switch (output.output_type) {
    case 'stream':
      return { type: 'stream', name: (output.name || output.stream) === 'stderr' ? 'stderr' : 'stdout', raw: joined(output.text) };
    case 'execute_result':
    case 'display_data':
    case 'pyout':
      return richOutput(isObject(output.data) ? output.data : legacyData(output));
    case 'error':
    case 'pyerr': {
      const trace = Array.isArray(output.traceback) ? output.traceback.filter((line) => typeof line === 'string').join('\n') : '';
      const head = [output.ename, output.evalue].filter((part) => typeof part === 'string' && part).join(': ');
      return { type: 'error', ...clip(trace || head) };
    }
    default:
      return null;
  }
}

// O kernel manda o texto aos pedacos, e uma barra de progresso pode cruzar
// pedacos: seguidos do mesmo canal se juntam antes da limpeza.
function mergeStreams(outputs) {
  const merged = [];
  outputs.forEach((output) => {
    const last = merged[merged.length - 1];
    if (output.type === 'stream' && last?.type === 'stream' && last.name === output.name) {
      last.raw += output.raw;
      return;
    }
    merged.push({ ...output });
  });
  return merged.map(({ raw, ...output }) => (output.type === 'stream' ? { ...output, ...clip(raw) } : output));
}

// Imagens coladas numa celula de Markdown ficam no proprio notebook, em
// `attachments`, e o texto aponta para `attachment:nome`.
function withAttachments(source, attachments) {
  if (!isObject(attachments)) return source;
  return source.replace(/attachment:([^\s)"'>]+)/g, (match, name) => {
    let key = name;
    try { key = decodeURIComponent(name); } catch (_error) { /* nome cru */ }
    const bundle = attachments[key] || attachments[name];
    if (!isObject(bundle)) return match;
    for (const type of IMAGE_TYPES) {
      const src = bundle[type] ? imageSource(type, bundle[type]) : null;
      if (src) return src;
    }
    return match;
  });
}

function readCell(cell) {
  const kind = cell.cell_type;
  const type = kind === 'code' ? 'code' : kind === 'markdown' || kind === 'heading' ? 'markdown' : 'raw';
  let source = joined(cell.source ?? cell.input);
  if (kind === 'heading') {
    const level = Math.min(6, Math.max(1, Number(cell.level) || 1));
    source = `${'#'.repeat(level)} ${source}`;
  }
  if (type === 'markdown') source = withAttachments(source, cell.attachments);
  const count = [cell.execution_count, cell.prompt_number].find((value) => Number.isInteger(value)) ?? null;
  const outputs = type === 'code' && Array.isArray(cell.outputs) ? mergeStreams(cell.outputs.map(readOutput).filter(Boolean)) : [];
  return { type, source, count: type === 'code' ? count : null, outputs };
}

function languageOf(metadata) {
  if (!isObject(metadata)) return '';
  const name = metadata.language_info?.name || metadata.kernelspec?.language || metadata.language || '';
  return typeof name === 'string' ? name : '';
}

// Modelo do notebook: linguagem do kernel e celulas com as saidas ja
// limpas. Erro de leitura vira NotebookError.
export function parseNotebook(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (_error) {
    throw new NotebookError('invalid');
  }
  if (!isObject(data)) throw new NotebookError('invalid');
  let cells = null;
  if (Array.isArray(data.cells)) cells = data.cells;
  else if (Array.isArray(data.worksheets)) cells = data.worksheets.flatMap((sheet) => (Array.isArray(sheet?.cells) ? sheet.cells : []));
  if (!cells) throw new NotebookError('invalid');
  return {
    language: languageOf(data.metadata),
    format: Number.isInteger(data.nbformat) ? data.nbformat : null,
    cells: cells.filter(isObject).map(readCell),
  };
}
