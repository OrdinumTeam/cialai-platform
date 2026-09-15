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

// Roteiro único de conectividade em aparelhos reais, CON-081 a CON-095.
const connectivity = readFileSync(`${root}docs/testes/roteiro-conectividade.md`, 'utf8');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const connectivityScenarios = [
  ['CON-081', 'Mesma rede'],
  ['CON-082', 'Wi-Fi residencial e 4G/5G'],
  ['CON-083', 'Redes diferentes sem relação'],
  ['CON-084', 'CGNAT e NAT restritivo'],
  ['CON-085', 'IPv6 disponível e indisponível'],
  ['CON-086', 'UDP bloqueado'],
  ['CON-087', 'Falha dos serviços públicos'],
  ['CON-088', 'Troca entre Wi-Fi e rede móvel'],
  ['CON-089', 'Reinício do computador e do aplicativo'],
  ['CON-090', 'Retorno do celular após suspensão'],
  ['CON-091', 'Aparelho não autorizado e revogação'],
  ['CON-092', 'Queda e recuperação do componente Tor'],
  ['CON-093', 'Terminal, arquivos e prévias pelo produto'],
  ['CON-094', 'Desempenho direto contra reserva e recursos'],
  ['CON-095', 'Soak de 24 horas'],
];
for (const [id, title] of connectivityScenarios) {
  assert.match(connectivity, new RegExp(`^## ${id} ${escape(title)}$`, 'm'), `Missing connectivity scenario: ${id} ${title}`);
}

const sections = connectivity.split(/^(?=## )/m).filter((section) => /^## CON-0\d\d /.test(section));
assert.equal(sections.length, connectivityScenarios.length, 'Connectivity runbook must have exactly fifteen scenarios');
for (const section of sections) {
  const id = section.slice(3, 10);
  assert.match(section, /^Validade: só vale execução em aparelho físico\. Simulação não aprova este cenário\.$/m, `${id} must require a physical device`);
  for (const heading of ['**Objetivo:**', '### Passos', '### Meta da seção 9', '**Critério de aprovação:**']) {
    assert.ok(section.includes(heading), `${id} is missing ${heading}`);
  }
  assert.match(section, /^1\. /m, `${id} needs numbered steps`);
  const runTables = section.match(/^\| (Nº|Marca) \|.*$/gm) || [];
  assert.ok(runTables.some((header) => /Transporte/.test(header) && /Resultado/.test(header) && /( em m?s \||\| Marca \|)/.test(header)),
    `${id} needs a run table with time, transport and result columns`);
  assert.equal((section.match(/☐ Aprovado ☐ Reprovado ☐ Bloqueado/g) || []).length, 1, `${id} needs one decision line`);
}
assert.equal((connectivity.match(/☐ Aprovado ☐ Reprovado ☐ Bloqueado/g) || []).length, 15);

const environments = connectivity.match(/## Registro de ambientes([\s\S]*?)\n## /);
assert.ok(environments, 'Connectivity runbook needs the environment register');
for (const field of ['Data', 'Aparelho', 'Sistema', 'Operadora', 'Roteador', 'NAT observado', 'IPv6']) {
  assert.ok(environments[1].includes(`| ${field} |`), `Environment register is missing ${field}`);
}

for (const goal of ['2 s', '3 s', '6 s', '15 s', '20 s', '10 s', '5 s', '60 ms', '150 ms', '400 ms', '150 MB', '120 MB', '4%', '24 h']) {
  assert.match(connectivity, new RegExp(`(?<![\\d,])${escape(goal)}`), `Missing connectivity goal: ${goal}`);
}

const goalsTable = connectivity.match(/## Metas mensuráveis([\s\S]*)$/);
assert.ok(goalsTable, 'Connectivity runbook needs the goals table');
assert.match(goalsTable[1], /^\| Métrica \| Meta \| Cenário \| Medido \|$/m);
const goalRows = goalsTable[1].match(/^\| (?!Métrica|---).+ \| .+ \| CON-0\d\d[^|]* \| *\|$/gm) || [];
assert.equal(goalRows.length, 18, 'Goals table must list the eighteen targets with an empty Medido column');
assert.match(connectivity, /Estado: roteiro preparado, execução em aparelho real pendente\n?$/);

console.log('PASS mobile manual runbooks: printable iOS and Android sheets with 30 pending scenarios and connectivity sheet with 15 pending scenarios');
