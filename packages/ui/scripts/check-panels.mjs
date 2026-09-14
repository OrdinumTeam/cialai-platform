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
