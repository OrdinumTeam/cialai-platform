// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ios = readFileSync(`${root}docs/testes/roteiro-3.9-ios.md`, 'utf8');
const android = readFileSync(`${root}docs/testes/roteiro-4.7-android.md`, 'utf8');

for (const scenario of [
  'Modo avião', 'Celular atrasado', 'Revogação', 'Reinício do desktop',
  'Reinício do aplicativo móvel', 'Troca de rede', 'Segundo plano',
  'Somente relé', 'Headscale fora do ar', 'Relógio adiantado',
  'Segundo celular e segundo desktop', 'Foto do QR', 'Permissões',
]) {
  assert.match(ios, new RegExp(scenario), `Missing iOS scenario: ${scenario}`);
}

for (const scenario of [
  'Modo avião', 'Celular atrasado', 'Revogação', 'Reinício do desktop',
  'Reinício do aplicativo móvel', 'Troca de rede', 'Segundo plano',
  'Somente relé', 'Headscale fora do ar', 'Relógio adiantado',
  'Segundo celular e segundo desktop', 'Foto do QR', 'Permissões',
  'Botão Voltar do Android', 'Parada após dois minutos', 'Biometria',
  'Armazenamento protegido',
]) {
  assert.match(android, new RegExp(scenario), `Missing Android scenario: ${scenario}`);
}

for (const threshold of ['60 segundos', '40 segundos', '10 segundos', '256 KiB', '5 segundos', '15 segundos', '10 minutos', '2 minutos', '30 minutos']) {
  assert.match(ios, new RegExp(threshold), `Missing iOS threshold: ${threshold}`);
}

assert.equal((ios.match(/☐ Aprovado ☐ Reprovado ☐ Bloqueado/g) || []).length, 13);
assert.match(ios, /Estado: roteiro preparado, execução em aparelho real pendente/);
assert.match(ios, /Somente marque Aprovada quando os treze cenários/);

for (const threshold of ['60 segundos', '40 segundos', '10 segundos', '256 KiB', '5 segundos', '15 segundos', '10 minutos', '2 minutos', '30 minutos', '120 segundos', 'cinco minutos']) {
  assert.match(android, new RegExp(threshold), `Missing Android threshold: ${threshold}`);
}
assert.equal((android.match(/☐ Aprovado ☐ Reprovado ☐ Bloqueado/g) || []).length, 17);
assert.match(android, /Estado: roteiro preparado, execução em aparelho real pendente/);
assert.match(android, /Somente marque Aprovada quando os dezessete cenários/);

console.log('PASS mobile manual runbooks: printable iOS and Android sheets with 30 pending scenarios');
