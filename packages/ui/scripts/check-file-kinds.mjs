// Classificacao de arquivos do editor: node scripts/check-file-kinds.mjs
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canConvertToPdf, extensionOf, fileKind, isPreviewable, isViewerKind, languageAlias } from '../src/terminals/kinds.js';

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

test('midia, fontes e notebooks', () => {
  for (const name of ['a.mp3', 'a.WAV', 'a.ogg', 'a.oga', 'a.opus', 'a.m4a', 'a.aac', 'a.flac']) assert.equal(fileKind(name), 'audio', name);
  for (const name of ['a.mp4', 'a.m4v', 'a.webm', 'a.MOV', 'a.ogv']) assert.equal(fileKind(name), 'video', name);
  for (const name of ['a.ttf', 'a.otf', 'a.woff', 'a.woff2']) assert.equal(fileKind(name), 'font', name);
  assert.equal(fileKind('analise.ipynb'), 'notebook');
  // Sem player ou sem leitor no webview: continuam abrindo fora.
  assert.equal(fileKind('a.mkv'), 'binary');
  assert.equal(fileKind('a.avi'), 'binary');
  assert.equal(fileKind('a.eot'), 'binary');
  assert.equal(fileKind('bun.lockb'), 'binary');
  // Lockfiles sao texto e abrem no editor.
  assert.equal(fileKind('Cargo.lock'), 'text');
  assert.equal(fileKind('yarn.lock'), 'text');
  for (const kind of ['audio', 'video', 'font', 'notebook']) {
    assert.ok(isViewerKind(kind), kind);
    assert.ok(!isPreviewable(kind), kind);
  }
  assert.ok(!canConvertToPdf('a.ipynb'));
  assert.ok(!canConvertToPdf('a.mp4'));
});

test('realce por nome que o language-data nao cobre', () => {
  assert.equal(languageAlias('.env'), 'Properties files');
  assert.equal(languageAlias('/x/.env.local'), 'Properties files');
  assert.equal(languageAlias('.editorconfig'), 'Properties files');
  assert.equal(languageAlias('config.cfg'), 'Properties files');
  assert.equal(languageAlias('.zshrc'), 'Shell');
  assert.equal(languageAlias('.envrc'), 'Shell');
  assert.equal(languageAlias('script.zsh'), 'Shell');
  assert.equal(languageAlias('.gitignore'), 'Shell');
  assert.equal(languageAlias('.dockerignore'), 'Shell');
  assert.equal(languageAlias('Makefile'), 'Shell');
  assert.equal(languageAlias('GNUmakefile'), 'Shell');
  assert.equal(languageAlias('rules.mk'), 'Shell');
  assert.equal(languageAlias('Cargo.lock'), 'TOML');
  assert.equal(languageAlias('uv.lock'), 'TOML');
  assert.equal(languageAlias('flake.lock'), 'JSON');
  assert.equal(languageAlias('tsconfig.jsonc'), 'JSON');
  assert.equal(languageAlias('pubspec.lock'), 'YAML');
  assert.equal(languageAlias('pagina.mdx'), 'Markdown');
  assert.equal(languageAlias('main.rs'), null);
  assert.equal(languageAlias('yarn.lock'), null);
  assert.equal(languageAlias('.environment'), null);
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
