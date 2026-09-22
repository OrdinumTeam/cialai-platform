// SPDX-License-Identifier: Apache-2.0
// O anúncio da release no Discord tem que ser possível na hora da release, e o
// endereço do webhook nunca pode estar no repositório.
//
// A página de `docs/releases` é a fonte do texto, então o portão exige que a
// versão atual já tenha a sua, com as seções que o notificador lê. Assim o
// esquecimento aparece aqui e não depois da tag, com a release publicada e o
// canal em silêncio.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { announces, buildPayload, section, versionOf } from '../release/discord-notify.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const version = JSON.parse(read('package.json')).version;

const pages = readdirSync(`${root}docs/releases`).filter((name) => name.endsWith('.md') && name !== 'README.md');
assert.ok(pages.length >= 1, 'docs/releases precisa de ao menos uma página');
assert.ok(
  pages.includes(`${version}.md`),
  `a versão ${version} não tem docs/releases/${version}.md, e a release não teria o que anunciar`,
);

// Toda página precisa servir ao anúncio, porque qualquer uma pode ser reenviada.
for (const name of pages) {
  const page = read(`docs/releases/${name}`);
  const tag = `v${name.replace(/\.md$/, '')}`;
  assert.doesNotThrow(() => versionOf(tag), `${name} não tem nome de versão`);
  for (const title of ['Resumo', 'Destaques']) {
    assert.ok(section(page, title), `docs/releases/${name} não tem a seção ${title}`);
  }
  const payload = buildPayload(versionOf(tag), page, { release: `https://exemplo/${tag}` });
  const [embed] = payload.embeds;
  assert.equal(payload.username, 'Cialai');
  assert.ok(payload.avatar_url.startsWith('https://'), 'o avatar precisa de endereço público');
  assert.ok(embed.description.length <= 4096, `${name} passa do limite de descrição do Discord`);
  assert.ok(embed.title.startsWith('Cialai '), 'o título nomeia o produto e a versão');
}

// Uma entrega pode sair sem anúncio, e a ficha da página é onde isso se diz.
// O portão guarda o mecanismo, porque quem decide é a página e não o comando:
// o envio automático vem da tag, sem ninguém para passar argumento.
const semAnuncio = pages.filter((name) => !announces(read(`docs/releases/${name}`)));
console.log(semAnuncio.length
  ? `  ${semAnuncio.length} página ou páginas pedem para não anunciar: ${semAnuncio.join(', ')}`
  : '  todas as páginas anunciam');
assert.ok(announces('| Canal | Prévia |'), 'uma ficha comum precisa anunciar');
assert.ok(!announces('| Anúncio | Não |'), 'a ficha precisa conseguir recusar o anúncio');
assert.match(read('tools/release/discord-notify.mjs'), /if \(!announces\(page\)\)/, 'o envio precisa honrar a recusa');

// O índice lista cada página, para ninguém publicar uma que não se acha.
const index = read('docs/releases/README.md');
for (const name of pages) {
  assert.ok(index.includes(`(${name})`), `docs/releases/README.md não lista ${name}`);
}

// O envio automático mora no fim da publicação, porque uma release publicada
// com o GITHUB_TOKEN não dispara outro workflow.
const release = read('.github/workflows/release.yml');
assert.match(release, /node tools\/release\/discord-notify\.mjs "\$RELEASE_TAG"/);
assert.match(release, /DISCORD_WEBHOOK: \$\{\{ secrets\.DISCORD_WEBHOOK \}\}/);
assert.ok(
  release.indexOf('release-assets.mjs publish') < release.indexOf('discord-notify.mjs'),
  'o anúncio vem depois da publicação',
);

const manual = read('.github/workflows/discord-release.yml');
assert.match(manual, /workflow_dispatch/);
assert.match(manual, /DISCORD_WEBHOOK: \$\{\{ secrets\.DISCORD_WEBHOOK \}\}/);

// Nenhum endereço de webhook versionado, em arquivo nenhum.
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const webhook = /discord(app)?\.com\/api\/webhooks\//i;
for (const path of tracked) {
  if (path.endsWith('discord-release.mjs')) continue;
  let body;
  try {
    body = readFileSync(`${root}${path}`, 'utf8');
  } catch {
    continue;
  }
  assert.ok(!webhook.test(body), `${path} carrega um endereço de webhook do Discord`);
}

console.log(`PASS discord release: ${pages.length} páginas prontas para anúncio, versão ${version} incluída`);
