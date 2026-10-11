// SPDX-License-Identifier: Apache-2.0
// Coluna de sessões e cabeçalho da área de trabalho em janela estreita. A
// folha de estilo precisa das consultas de contêiner que dobram a linha do
// card quando a coluna encolhe e escondem, por etapas, o que o cabeçalho não
// tem onde mostrar. Lê o CSS como texto, sem navegador, como os demais gates.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const css = source('../src/views/Terminais.css');

// Corpo da primeira regra de primeiro nível com esse seletor exato.
const rule = (selector) => {
  const match = css.match(new RegExp(`(?:^|\\n|\\})${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`));
  assert.ok(match, `${selector} ausente`);
  return match[1];
};

// Regras dentro de um bloco @container, com o prelúdio exato.
const container = (prelude) => {
  const match = css.match(new RegExp(`${prelude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{((?:[^{}]+\\{[^{}]*\\})+)\\s*\\}`));
  assert.ok(match, `${prelude} ausente`);
  return match[1];
};

test('a coluna de sessões e a área de trabalho são contêineres de consulta', () => {
  assert.match(rule('.terminais-sessions'), /container-type:inline-size;container-name:sessions/);
  assert.match(rule('.terminais-work'), /container-type:inline-size;container-name:work/);
  // Os cards do telefone vivem fora da coluna e não entram na consulta.
  assert.doesNotMatch(container('@container sessions (max-width:230px)'), /phone/);
});

test('os chips do card encolhem com reticências em vez de cortar a linha', () => {
  for (const selector of ['.terminais-card__chip', '.terminais-card__profile']) {
    const body = rule(selector);
    assert.match(body, /flex:0 1 auto/, `${selector} precisa poder encolher`);
    assert.match(body, /min-width:0/, `${selector} sem min-width:0 não encolhe`);
    assert.match(body, /white-space:nowrap/, `${selector} continua numa linha`);
    assert.match(body, /overflow:hidden;text-overflow:ellipsis/, `${selector} corta com reticências`);
  }
});

test('com a coluna estreita, a linha do agente dobra e o tempo decorrido desce', () => {
  const block = container('@container sessions (max-width:230px)');
  assert.match(block, /\.terminais-card__running-row\{flex-wrap:wrap;row-gap:2px\}/);
  assert.match(block, /\.terminais-card__running\{flex:1 1 auto\}/);
  assert.match(block, /\.terminais-card__elapsed\{flex:1 1 100%;margin-left:0\}/);
  assert.match(block, /\.terminais-card__agent-row\{gap:3px\}/);
});

test('o nome da sessão no cabeçalho encolhe com reticências, e o caminho cede antes dele', () => {
  const name = rule('.terminais-work__name');
  assert.match(name, /flex:0 1 auto/);
  assert.match(name, /min-width:4ch/);
  assert.match(name, /overflow:hidden;text-overflow:ellipsis/);
  assert.match(rule('.terminais-work__path'), /flex:0 2 auto/);
});

test('o cabeçalho esconde por etapas o que não cabe na área de trabalho', () => {
  assert.match(container('@container work (max-width:680px)'), /\.terminais-work__running\{display:none\}/);
  assert.match(container('@container work (max-width:560px)'), /\.terminais-work__subtitle\{display:none\}/);
  const narrow = container('@container work (max-width:480px)');
  assert.match(narrow, /\.terminais-work__path\{display:none\}/);
  assert.match(narrow, /\.terminais-work__font\{display:none\}/);
  // As etapas vão do menos essencial ao mais: o limiar de cada uma é menor que o da anterior.
  const thresholds = [...css.matchAll(/@container work \(max-width:(\d+)px\)/g)].map((match) => Number(match[1]));
  assert.deepEqual(thresholds, [680, 560, 480]);
});
