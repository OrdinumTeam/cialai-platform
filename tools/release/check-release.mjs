// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const releaseMode = process.argv.includes('--release');
const expectedVersion = '1.0.0';

const guide = read('docs/engenharia/release-v1.md');
const changelog = read('CHANGELOG.md');
const workflow = read('.github/workflows/release.yml');

assert.match(changelog, /^# Changelog$/m);
assert.match(changelog, /^## Unreleased$/m);
assert.match(changelog, /Version 1\.0\.0 has not been published/);

for (const required of [
  'npm test',
  'headscale-integration.yml',
  'DMG, NSIS, MSI, AppImage, DEB e RPM',
  'macOS arm64, macOS x64, Linux x64, Linux arm64 e Windows x64',
  'latest.json',
  'Tunnelcore.xcframework.zip',
  'tunnelcore.aar',
  'TestFlight',
  'faixa interna do Play',
  'docs/produto/12-decisoes.md',
]) {
  assert.ok(guide.includes(required), `Release guide is missing: ${required}`);
}

assert.match(workflow, /tags: \["v\*"\]/);
assert.match(workflow, /releaseDraft: true/);
assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);

const gateBlock = guide.match(/<!-- RELEASE_GATES_START -->([\s\S]*?)<!-- RELEASE_GATES_END -->/);
assert.ok(gateBlock, 'Release evidence table is missing');
const gates = [...gateBlock[1].matchAll(/^\| ([1-6]) \| (PENDENTE|VERIFICADO) \| (.+) \|$/gm)]
  .map((match) => ({ id: Number(match[1]), status: match[2], evidence: match[3].trim() }));
assert.deepEqual(gates.map(({ id }) => id), [1, 2, 3, 4, 5, 6]);
for (const gate of gates) assert.ok(gate.evidence.length >= 12, `Gate ${gate.id} needs evidence`);

if (releaseMode) {
  const pending = gates.filter(({ status }) => status !== 'VERIFICADO');
  assert.equal(pending.length, 0, `Release gates still pending: ${pending.map(({ id }) => id).join(', ')}`);

  const jsonManifests = [
    'package.json',
    'apps/desktop/package.json',
    'apps/mobile/package.json',
    'packages/protocol/package.json',
    'packages/tunnel-core/package.json',
    'packages/ui/package.json',
  ];
  for (const path of jsonManifests) {
    assert.equal(JSON.parse(read(path)).version, expectedVersion, `${path} must use ${expectedVersion}`);
  }
  assert.match(read('apps/mobile/app.config.ts'), /version: '1\.0\.0'/);
  assert.equal(JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json')).version, expectedVersion);
  assert.match(read('apps/desktop/src-tauri/Cargo.toml'), /^version = "1\.0\.0"$/m);

  const updaterKey = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json')).plugins?.updater?.pubkey?.trim();
  assert.ok(updaterKey && updaterKey !== 'REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY', 'Configure the updater public key');

  const tags = execFileSync('git', ['tag', '--points-at', 'HEAD'], { cwd: root, encoding: 'utf8' })
    .trim()
    .split('\n');
  assert.ok(tags.includes(`v${expectedVersion}`), `Tag v${expectedVersion} must point at HEAD`);
}

const pendingCount = gates.filter(({ status }) => status === 'PENDENTE').length;
console.log(releaseMode
  ? `PASS release gate: v${expectedVersion} is locally documented and tagged`
  : `PASS release preparation: ${gates.length} gates documented, ${pendingCount} pending`);
