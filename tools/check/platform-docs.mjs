// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, 'utf8');
const readme = read('README.md');
const guide = read('docs/14-diferencas-por-plataforma.md');
const index = read('docs/README.md');
const normalizedReadme = readme.replaceAll(/\s+/g, ' ');

for (const heading of ['### macOS', '### Linux', '### Windows']) {
  assert.ok(readme.includes(heading), `README sem preparo específico: ${heading}`);
}

for (const required of [
  'npm run sidecar --workspace @cialai/desktop',
  'npm test',
  'Windows runs the native Rust suite',
  'docs/14-diferencas-por-plataforma.md',
]) {
  assert.ok(
    normalizedReadme.includes(required),
    `README sem informação obrigatória: ${required}`,
  );
}

for (const required of [
  '## Estado da verificação',
  '## Janela, menu e aparência',
  '## Terminal e processos',
  '## Atalhos',
  '## Caminhos e integrações',
  '## Empacotamento',
  'Ctrl Shift Backspace',
  'SetWindowPos',
  'Wayland',
  'ConPTY',
  'cargo-xwin',
]) {
  assert.ok(guide.includes(required), `guia por plataforma incompleto: ${required}`);
}

assert.ok(
  index.includes('14-diferencas-por-plataforma.md'),
  'índice não aponta para o guia por plataforma',
);

console.log('PASS platform docs: README setup and cross-platform guide');
