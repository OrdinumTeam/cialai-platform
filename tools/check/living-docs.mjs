// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const documents = [
  '01-visao-e-escopo.md',
  '02-analise-do-prototipo.md',
  '03-arquitetura.md',
  '04-desktop.md',
  '05-mobile.md',
  '06-rede-headscale-e-pareamento.md',
  '07-protocolo-da-ponte.md',
  '08-design-e-marca.md',
  '09-monorepo-e-ferramentas.md',
  '10-ci-cd-e-distribuicao.md',
  '11-roadmap-de-execucao.md',
  '12-decisoes.md',
];

for (const document of documents) {
  const source = read(`docs/${document}`);
  assert.equal((source.match(/^## Estado em 13\/09\/2026$/gm) || []).length, 1, `${document} needs one dated status section`);
  assert.match(source, /\| (Implementado|Preparado|Pendente) \|/, `${document} needs explicit item states`);
}

const vision = read('docs/01-visao-e-escopo.md');
for (let criterion = 1; criterion <= 5; criterion += 1) {
  assert.match(vision, new RegExp(`^\\| ${criterion}\\. .+ \\| (Implementado|Preparado|Pendente) \\|`, 'm'));
}

const roadmap = read('docs/11-roadmap-de-execucao.md');
const roadmapState = roadmap.match(/## Estado em 13\/09\/2026([\s\S]*?)## Fase 0: fundação e spikes/);
assert.ok(roadmapState, 'Roadmap status block is missing');
const phaseEnds = [12, 11, 12, 10, 8, 19, 8, 6];
const expectedTasks = phaseEnds.flatMap((end, phase) =>
  Array.from({ length: end }, (_, index) => `${phase}.${index + 1}`));
for (const task of expectedTasks) {
  assert.match(roadmapState[1], new RegExp(`^\\| ${task.replace('.', '\\.') } \\| (Implementado|Preparado|Pendente) \\|`, 'm'), `Task ${task} needs a state`);
}

const decisions = read('docs/12-decisoes.md');
const decisionState = decisions.match(/## Estado em 13\/09\/2026([\s\S]*?)## 001 Nome Cialai/);
assert.ok(decisionState, 'Decision status block is missing');
for (let number = 1; number <= 31; number += 1) {
  const id = String(number).padStart(3, '0');
  assert.match(decisionState[1], new RegExp(`^\\| ${id} \\| (Implementado|Preparado|Pendente) \\|`, 'm'), `Decision ${id} needs a state`);
}

const ci = read('docs/10-ci-cd-e-distribuicao.md');
for (const item of ['ci.yml', 'release.yml', 'headscale-integration.yml', 'nightly-e2e.yml', 'mobile-artifacts.yml', 'v1.0.0']) {
  assert.ok(ci.includes(`| \`${item}\` |`) || ci.includes(`| Release \`${item}\` |`), `CI status is missing ${item}`);
}

const index = read('docs/README.md');
assert.match(index, /Estado em 13\/09\/2026/);
assert.match(index, /Implementado`, `Preparado` e `Pendente`/);
assert.doesNotMatch(index, /próxima tarefa é integrar/);

console.log(`PASS living docs: ${documents.length} dated documents, ${expectedTasks.length} tasks and 31 decisions classified`);
