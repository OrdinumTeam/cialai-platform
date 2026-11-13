// Leitura de notebooks Jupyter do visualizador: node scripts/check-notebook.mjs
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotebookError, OUTPUT_LIMIT, cleanOutput, parseNotebook } from '../src/terminals/notebook.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const notebook = (cells, metadata = { language_info: { name: 'python' } }) => JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata, cells });

test('celulas, linguagem e contagem', () => {
  const result = parseNotebook(notebook([
    { cell_type: 'markdown', source: ['# Titulo\n', 'texto'] },
    { cell_type: 'code', execution_count: 7, source: 'x = 1', outputs: [] },
    { cell_type: 'code', execution_count: null, source: ['y', ' = 2'], outputs: [] },
    { cell_type: 'raw', source: 'cru' },
    'lixo',
    null,
  ]));
  assert.equal(result.language, 'python');
  assert.equal(result.format, 4);
  assert.deepEqual(result.cells.map((cell) => [cell.type, cell.source, cell.count]), [
    ['markdown', '# Titulo\ntexto', null],
    ['code', 'x = 1', 7],
    ['code', 'y = 2', null],
    ['raw', 'cru', null],
  ]);
  assert.equal(parseNotebook(notebook([], { kernelspec: { language: 'julia' } })).language, 'julia');
  assert.equal(parseNotebook('﻿' + notebook([])).cells.length, 0, 'BOM no inicio');
});

test('saidas: texto, imagem, markdown, erro e preferencia de tipo', () => {
  const [cell] = parseNotebook(notebook([{
    cell_type: 'code',
    execution_count: 1,
    source: 'df',
    outputs: [
      { output_type: 'execute_result', data: { 'text/html': '<table onload=x>', 'text/plain': 'tabela' } },
      { output_type: 'display_data', data: { 'image/png': `${PNG.slice(0, 20)}\n${PNG.slice(20)}\n`, 'text/plain': '<Figure>' } },
      { output_type: 'display_data', data: { 'text/markdown': '**negrito**' } },
      { output_type: 'display_data', data: { 'text/html': '<b>so html</b>' } },
      { output_type: 'display_data', data: { 'image/svg+xml': ['<svg xmlns="http://www.w3.org/2000/svg"/>'] } },
      { output_type: 'display_data', data: { 'application/json': { a: 1 } } },
      { output_type: 'error', ename: 'ValueError', evalue: 'ruim', traceback: ['\u001b[0;31mValueError\u001b[0m: ruim'] },
      { output_type: 'error', ename: 'KeyError', evalue: 'k', traceback: [] },
      { output_type: 'display_data', data: { 'application/vnd.jupyter.widget-view+json': {} } },
    ],
  }])).cells;
  assert.deepEqual(cell.outputs, [
    { type: 'text', text: 'tabela', truncated: false },
    { type: 'image', src: `data:image/png;base64,${PNG}` },
    { type: 'markdown', source: '**negrito**' },
    { type: 'text', text: '<b>so html</b>', truncated: false },
    { type: 'image', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>')}` },
    { type: 'text', text: '{\n  "a": 1\n}', truncated: false },
    { type: 'error', text: 'ValueError: ruim', truncated: false },
    { type: 'error', text: 'KeyError: k', truncated: false },
  ]);
});

test('imagem que nao e base64 nunca vira data URL', () => {
  const [cell] = parseNotebook(notebook([{
    cell_type: 'code',
    source: '',
    outputs: [
      { output_type: 'display_data', data: { 'image/png': 'x" onerror="alert(1)', 'text/plain': 'reserva' } },
      { output_type: 'display_data', data: { 'image/jpeg': 'javascript:alert(1)' } },
    ],
  }])).cells;
  assert.deepEqual(cell.outputs, [{ type: 'text', text: 'reserva', truncated: false }]);
});

test('fluxos juntos, barra de progresso e corte', () => {
  const [cell] = parseNotebook(notebook([{
    cell_type: 'code',
    source: '',
    outputs: [
      { output_type: 'stream', name: 'stdout', text: ['10%\r', '50%\r'] },
      { output_type: 'stream', name: 'stdout', text: '100%\nfim\r\n' },
      { output_type: 'stream', name: 'stderr', text: 'aviso\n' },
      { output_type: 'stream', name: 'stdout', text: 'x'.repeat(OUTPUT_LIMIT + 10) },
    ],
  }])).cells;
  assert.equal(cell.outputs.length, 3);
  assert.deepEqual(cell.outputs[0], { type: 'stream', name: 'stdout', text: '100%\nfim\n', truncated: false });
  assert.deepEqual(cell.outputs[1], { type: 'stream', name: 'stderr', text: 'aviso\n', truncated: false });
  assert.equal(cell.outputs[2].text.length, OUTPUT_LIMIT);
  assert.equal(cell.outputs[2].truncated, true);
  assert.equal(cleanOutput('\u001b[1;32mok\u001b[0m\u001b]0;titulo\u0007'), 'ok');
});

test('anexos de Markdown viram data URL de imagem', () => {
  const [cell] = parseNotebook(notebook([{
    cell_type: 'markdown',
    source: '![grafico](attachment:grafico%201.png) ![sem](attachment:outro.png)',
    attachments: { 'grafico 1.png': { 'image/png': PNG }, 'outro.png': { 'text/plain': 'x' } },
  }])).cells;
  assert.equal(cell.source, `![grafico](data:image/png;base64,${PNG}) ![sem](attachment:outro.png)`);
});

test('nbformat 3 e erros de leitura', () => {
  const legacy = parseNotebook(JSON.stringify({
    nbformat: 3,
    metadata: { language: 'python' },
    worksheets: [{ cells: [
      { cell_type: 'heading', level: 2, source: 'Parte' },
      { cell_type: 'code', prompt_number: 4, input: 'print(1)', outputs: [
        { output_type: 'stream', stream: 'stdout', text: '1\n' },
        { output_type: 'pyout', text: ['2'], png: PNG },
        { output_type: 'pyerr', ename: 'E', evalue: 'v', traceback: ['tb'] },
      ] },
    ] }],
  }));
  assert.equal(legacy.language, 'python');
  assert.deepEqual(legacy.cells.map((cell) => [cell.type, cell.source, cell.count]), [['markdown', '## Parte', null], ['code', 'print(1)', 4]]);
  assert.deepEqual(legacy.cells[1].outputs.map((output) => output.type), ['stream', 'image', 'error']);
  assert.throws(() => parseNotebook('{nao e json'), NotebookError);
  assert.throws(() => parseNotebook('[]'), NotebookError);
  assert.throws(() => parseNotebook('{"metadata":{}}'), NotebookError);
});
