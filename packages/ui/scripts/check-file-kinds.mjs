// Classificacao de arquivos do editor: node scripts/check-file-kinds.mjs
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canConvertToPdf, extensionOf, fileKind, isPreviewable, isViewerKind } from '../src/terminals/kinds.js';

test('extensao e nome', () => {
  assert.equal(extensionOf('/x/Relatório.PDF'), 'pdf');
  assert.equal(extensionOf('.env'), '');
  assert.equal(extensionOf('sem-extensao'), '');
});

test('rotas por tipo', () => {
  assert.equal(fileKind('a.pdf'), 'pdf');
  assert.equal(fileKind('planilha.xlsx'), 'sheet');
  assert.equal(fileKind('antiga.xls'), 'sheet');
  assert.equal(fileKind('calc.ods'), 'sheet');
  assert.equal(fileKind('dados.csv'), 'csv');
  assert.equal(fileKind('dados.tsv'), 'csv');
  assert.equal(fileKind('carta.docx'), 'docx');
  assert.equal(fileKind('apresentação.pptx'), 'office');
  assert.equal(fileKind('apresentação.key'), 'office');
  assert.equal(fileKind('texto.rtf'), 'office');
  assert.equal(fileKind('antigo.doc'), 'office');
  assert.equal(fileKind('numeros.numbers'), 'office');
  assert.equal(fileKind('pacote.zip'), 'binary');
  assert.equal(fileKind('foto.HEIC'), 'image');
  assert.equal(fileKind('README.md'), 'markdown');
  assert.equal(fileKind('index.html'), 'html');
  assert.equal(fileKind('main.rs'), 'text');
  assert.equal(fileKind('.DS_Store'), 'binary');
});

test('visualizacao e visualizadores', () => {
  assert.ok(isPreviewable('markdown'));
  assert.ok(isPreviewable('html'));
  assert.ok(isPreviewable('csv'));
  assert.ok(!isPreviewable('text'));
  assert.ok(isViewerKind('pdf'));
  assert.ok(isViewerKind('sheet'));
  assert.ok(isViewerKind('docx'));
  assert.ok(isViewerKind('office'));
  assert.ok(!isViewerKind('csv'));
  assert.ok(!isViewerKind('image'));
  assert.ok(canConvertToPdf('carta.docx'));
  assert.ok(canConvertToPdf('planilha.xlsx'));
  assert.ok(canConvertToPdf('slides.pptx'));
  assert.ok(!canConvertToPdf('a.pdf'));
  assert.ok(!canConvertToPdf('a.csv'));
});
