// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ios = readFileSync(`${root}docs/testes/roteiro-3.9-ios.md`, 'utf8');

for (const scenario of [
  'Modo avião', 'Celular atrasado', 'Revogação', 'Reinício do desktop',
  'Reinício do aplicativo móvel', 'Troca de rede', 'Segundo plano',
  'Somente relé', 'Headscale fora do ar', 'Relógio adiantado',
  'Segundo celular e segundo desktop', 'Foto do QR', 'Permissões',
]) {
  assert.match(ios, new RegExp(scenario), `Missing iOS scenario: ${scenario}`);
}

for (const threshold of ['60 segundos', '40 segundos', '10 segundos', '256 KiB', '5 segundos', '15 segundos', '10 minutos', '2 minutos', '30 minutos']) {
  assert.match(ios, new RegExp(threshold), `Missing iOS threshold: ${threshold}`);
}

assert.equal((ios.match(/☐ Aprovado ☐ Reprovado ☐ Bloqueado/g) || []).length, 13);
assert.match(ios, /Estado: roteiro preparado, execução em aparelho real pendente/);
assert.match(ios, /Somente marque Aprovada quando os treze cenários/);

console.log('PASS mobile manual runbooks: printable iOS sheet with 13 pending scenarios');
