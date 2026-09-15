// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const json = (path) => JSON.parse(readFileSync(`${root}/${path}`, 'utf8'));
const pkg = json('package.json');
assert.equal(process.versions.node.split('.')[0], '22', 'Use Node 22 as declared in .nvmrc');
const packages = ['apps/desktop', 'apps/mobile', 'packages/ui', 'packages/protocol', 'packages/tunnel-core'];
const lock = json('package-lock.json');
for (const path of packages) {
  const workspace = json(`${path}/package.json`);
  assert.equal(workspace.private, true, path);
  assert.equal(workspace.license, 'Apache-2.0', path);
  assert.equal(workspace.version, pkg.version, path);
  assert.ok(lock.packages[path], `Lockfile is missing ${path}`);
}
// The store builds read the version from the Expo config, not from package.json.
const mobileConfig = readFileSync(`${root}/apps/mobile/app.config.ts`, 'utf8');
assert.equal(mobileConfig.match(/^ {4}version: '([^']+)',$/m)?.[1], pkg.version, 'apps/mobile/app.config.ts version');

const protectedPaths = [
  '.env', '.env.production', 'secrets/credential.json', 'secret.p8', 'secret.pem',
  'secret.key', 'upload.jks', 'upload.keystore', 'play-service-account.json',
  'apps/mobile/android/key.properties', 'apps/mobile/ios/Podfile',
  'apps/mobile/android/build.gradle', 'apps/desktop/src-tauri/binaries/cialai-tunnel',
  'packages/tunnel-core/build/tunnelcore.aar', '.local/spikes/state.json',
];
for (const path of protectedPaths) {
  const result = spawnSync('git', ['check-ignore', '--no-index', '-q', path], { cwd: root });
  assert.equal(result.status, 0, `${path} must be ignored`);
}
const example = spawnSync('git', ['check-ignore', '--no-index', '-q', '.env.example'], { cwd: root });
assert.equal(example.status, 1, '.env.example must remain trackable');
console.log(`PASS foundation: ${packages.length} workspaces, lockfile, Node 22, ${protectedPaths.length} protected paths`);
console.log('External CI, native device, signing, store and soak evidence remains pending.');
