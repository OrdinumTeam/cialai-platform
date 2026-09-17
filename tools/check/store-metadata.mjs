// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');

function markedBlock(source, name) {
  const fence = '```';
  const match = source.match(new RegExp(`<!-- ${name}_START -->\\s*${fence}text\\n([\\s\\S]*?)\\n${fence}\\s*<!-- ${name}_END -->`));
  assert.ok(match, `Missing ${name} block`);
  return match[1].trim();
}

for (const path of ['docs/stores/listing-pt-BR.md', 'docs/stores/listing-en.md']) {
  const source = read(path);
  const short = markedBlock(source, 'PLAY_SHORT');
  const long = markedBlock(source, 'STORE_LONG');
  const release = markedBlock(source, 'PLAY_RELEASE');
  assert.ok(short.length <= 80, `${path} Play short description has ${short.length} characters`);
  assert.ok(long.length <= 4000, `${path} long description has ${long.length} characters`);
  assert.ok(release.length <= 500, `${path} Play release notes have ${release.length} characters`);
  assert.doesNotMatch(source, /\bVPN\b/i, `${path} must use product language`);
}

const apple = read('docs/stores/app-store-privacy.md');
assert.match(apple, /No, we do not collect data from this app/);
assert.match(apple, /against the archived binary/i);

const play = read('docs/stores/google-play-data-safety.md');
assert.match(play, /Does the app collect or share any required user data types\? \| No/);
assert.match(play, /against the signed AAB/i);

for (const [policy, contactMarker] of [
  ['docs/legal/privacy-policy-en.md', /TO BE CONFIRMED BEFORE PUBLICATION/],
  ['docs/legal/privacy-policy-pt-BR.md', /A CONFIRMAR ANTES DA PUBLICAÇÃO/],
]) {
  const source = read(policy);
  assert.match(source, /ORDINUM INOVACAO E TECNOLOGIA LTDA/);
  assert.match(source, contactMarker);
}

const screenshots = read('docs/stores/screenshots.md');
for (const required of ['1320 by 2868', '1080 by 1920', '1920 by 1080', '2560 by 1440', '1024 by 500']) {
  assert.match(screenshots, new RegExp(required));
}
assert.match(screenshots, /English set pending/);
assert.match(screenshots, /real device build/);

console.log('PASS store metadata: bilingual policy and copy, privacy answers, character limits and screenshot plan');
