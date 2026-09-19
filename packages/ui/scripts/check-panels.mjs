// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AUTO_COLLAPSE, INITIAL_PANELS, choosePanel, panelCollapsed, resizePanels } from '../src/terminals/panels.js';

const free = { preferred: false, focus: false };

test('narrow windows collapse the side columns without touching the preference', () => {
  const wide = resizePanels(INITIAL_PANELS, 1400);
  assert.equal(wide, INITIAL_PANELS, 'a width that changes nothing keeps the same state');
  const narrow = resizePanels(INITIAL_PANELS, AUTO_COLLAPSE.explorer - 1);
  assert.equal(panelCollapsed(narrow, 'explorer', free), true);
  assert.equal(panelCollapsed(narrow, 'sessions', free), false);
  assert.equal(panelCollapsed(resizePanels(narrow, 1400), 'explorer', free), false);
});

test('asking for a collapsed column shows it in a 1024 px window until the width crosses the limit', () => {
  const narrow = resizePanels(INITIAL_PANELS, 760);
  const shown = choosePanel(narrow, 'explorer', true);
  assert.equal(panelCollapsed(shown, 'explorer', free), false);
  assert.equal(resizePanels(shown, 700).shown.explorer, true, 'crossing only the sessions limit keeps the explorer choice');
  assert.equal(panelCollapsed(resizePanels(shown, 700), 'sessions', free), true);
  const grown = resizePanels(shown, 1200);
  assert.equal(panelCollapsed(resizePanels(grown, 760), 'explorer', free), true, 'shrinking again collapses by itself');
  assert.equal(panelCollapsed(choosePanel(shown, 'explorer', false), 'explorer', free), true);
});

test('the preference and focus mode still win over an explicit request', () => {
  const shown = choosePanel(resizePanels(INITIAL_PANELS, 760), 'explorer', true);
  assert.equal(panelCollapsed(shown, 'explorer', { preferred: true, focus: false }), true);
  assert.equal(panelCollapsed(shown, 'explorer', { preferred: false, focus: true }), true);
  assert.equal(choosePanel(shown, 'explorer', true), shown);
});

test('the workbench routes every show and hide through the panel state', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/terminals/ui/Workbench.jsx', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /AUTO_COLLAPSE_(?:EXPLORER|SESSIONS)/);
  assert.doesNotMatch(source, /setLayout\(\{ (?:explorer|sessions)Collapsed/);
  assert.match(source, /resizePanels\(current, width\)/);
  for (const panel of ['explorer', 'sessions']) {
    assert.match(source, new RegExp(`panelCollapsed\\(auto, '${panel}'`));
  }
});

/* ── faixa recolhida legivel, UI-01 ────────────────────────────────── */

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('a faixa do painel recolhido diz o que esconde e leva de volta', () => {
  const source = read('../src/terminals/ui/Workbench.jsx');
  const css = read('../src/views/Terminais.css');

  // A faixa inteira e o botao, com icone de 16 px no topo e resumo embaixo.
  assert.match(source, /className="terminais-edge terminais-edge--left"/);
  assert.match(source, /className="terminais-edge terminais-edge--right"/);
  assert.doesNotMatch(source, /terminais-edge__btn/, 'a faixa inteira e clicavel, sem botao interno');
  assert.match(source, /<PanelLeftOpen size=\{16\}/);
  assert.match(source, /<PanelRightOpen size=\{16\}/);
  assert.match(css, /\.terminais-edge\{[^}]*flex:0 0 28px/, 'largura minima de 28 px');
  assert.doesNotMatch(css, /\.terminais-edge\{[^}]*transition:[^}]*width/, 'largura nao anima');

  // Resumo: sessoes mostram total e selo de avisos; arquivos, alteracoes do Git.
  const left = source.slice(source.indexOf('terminais-edge--left'), source.indexOf('terminais-edge--right'));
  assert.match(left, /sessions\.length/);
  assert.match(left, /attention \? <span className="terminais-edge__badge"/);
  const right = source.slice(source.indexOf('terminais-edge--right'));
  assert.match(right, /gitChanges/);
  assert.match(source, /const gitChanges = selected\?\.explorer\?\.git\?\.changes\?\.length/);

  // Dica com o atalho, `aria-expanded` e `aria-controls` apontando para o painel.
  for (const block of [left, right]) {
    assert.match(block, /aria-expanded=\{false\}/);
    assert.match(block, /aria-controls="terminais-(sessions|explorer)"/);
    assert.match(block, /title=\{translate\('terminal\.work\.show(Sessions|Files)Shortcut'/);
  }
  assert.match(read('../src/terminals/ui/SessionsPane.jsx'), /id="terminais-sessions"/);
  assert.match(read('../src/terminals/ui/ExplorerPane.jsx'), /id="terminais-explorer"/);
});

test('os botoes de recolher usam 16 px e o par coerente de icones', () => {
  assert.match(read('../src/terminals/ui/SessionsPane.jsx'), /<PanelLeftClose size=\{16\}/);
  assert.match(read('../src/terminals/ui/ExplorerPane.jsx'), /<PanelRightClose size=\{16\}/);
  const work = read('../src/terminals/ui/WorkArea.jsx');
  assert.match(work, /PanelLeftOpen size=\{16\} strokeWidth=\{1\.75\} \/> : <PanelLeftClose size=\{16\}/);
  assert.match(work, /PanelRightOpen size=\{16\} strokeWidth=\{1\.75\} \/> : <PanelRightClose size=\{16\}/);
});

test('o cabecalho da area de trabalho tem os dois alternadores, sempre visiveis', () => {
  const work = read('../src/terminals/ui/WorkArea.jsx');
  const header = work.slice(work.indexOf('<header className="terminais-work__head">'), work.indexOf('</header>'));
  assert.match(header, /aria-pressed=\{!panels\.sessionsCollapsed\}/, 'sessoes a esquerda');
  assert.ok(header.indexOf('panels.onToggleSessions') < header.indexOf('terminais-work__name'), 'o de sessoes vem antes do nome');
  assert.match(work, /aria-pressed=\{!panels\.explorerCollapsed\}/, 'arquivos a direita');
  assert.match(work, /aria-controls="terminais-sessions"/);
  assert.match(work, /aria-controls="terminais-explorer"/);
  // O alternador nasce com o estado do painel, nao com um estado proprio.
  const bench = read('../src/terminals/ui/Workbench.jsx');
  assert.match(bench, /onToggleSessions: \(\) => showPanel\('sessions', sessionsCollapsed/);
  assert.match(bench, /onToggleExplorer: \(\) => showPanel\('explorer', explorerCollapsed\)/);
});

test('o primeiro recolhimento de cada coluna avisa onde reabrir, uma vez so', () => {
  const bench = read('../src/terminals/ui/Workbench.jsx');
  const show = bench.slice(bench.indexOf('const showPanel ='), bench.indexOf('const native ='));
  assert.match(show, /const firstTime = !visible && !layout\[noticed\]/);
  assert.match(show, /if \(firstTime\) \{/);
  assert.match(show, /terminal\.work\.sessionsHidden/);
  assert.match(show, /terminal\.work\.filesHidden/);
  // A marca fica no mesmo registro do layout, entao o aviso nao volta.
  const layout = read('../src/terminals/layout.js');
  assert.match(layout, /noticedSessions: false/);
  assert.match(layout, /noticedExplorer: false/);
  assert.match(layout, /next\.noticedSessions = Boolean\(raw\.noticedSessions\)/);
});

test('no modo foco a faixa fica discreta, mas nunca some', () => {
  const css = read('../src/views/Terminais.css');
  const focus = css.slice(css.indexOf('.terminais-page.is-focus .terminais-edge{'));
  assert.match(focus, /\.terminais-page\.is-focus \.terminais-edge\{background:transparent/);
  assert.doesNotMatch(focus.slice(0, focus.indexOf('\n\n')), /display:none|opacity:0\}/);
  // O resumo some, o alvo continua: a faixa e alcancavel por teclado.
  assert.match(focus, /\.terminais-page\.is-focus \.terminais-edge__summary\{opacity:0/);
  assert.match(focus, /:focus-visible \.terminais-edge__summary\{opacity:1\}/);
});
