// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workflow = readFileSync(`${root}/.github/workflows/ci.yml`, 'utf8');

for (const runner of ['ubuntu-22.04', 'windows-2022', 'macos-14']) {
  assert.match(workflow, new RegExp(`\\b${runner.replaceAll('.', '\\.')}\\b`), `runner ausente: ${runner}`);
}

for (const dependency of [
  'libwebkit2gtk-4.1-dev',
  'libgtk-3-dev',
  'libayatana-appindicator3-dev',
  'librsvg2-dev',
  'patchelf',
  'libxdo-dev',
  'libssl-dev',
  'zsh',
]) {
  assert.ok(workflow.includes(dependency), `dependência Linux ausente: ${dependency}`);
}

for (const required of [
  'actions/setup-node@v4',
  'dtolnay/rust-toolchain@master',
  'toolchain: 1.98.1',
  'actions/setup-go@v5',
  'CARGO_BUILD_JOBS: 2',
  'npm ci',
  'npm run sidecar --workspace @cialai/desktop',
  'npm test',
  'npm run check:text',
  'npm ci --prefix tools/browser',
  'playwright/cli.js install --with-deps chromium',
  'npm run test:browser',
  'npm run build --workspace @cialai/desktop -- --config src-tauri/tauri.ci.conf.json',
  'actions/upload-artifact@v4',
  'if-no-files-found: error',
  'bundle/dmg/*.dmg',
  'bundle/appimage/*.AppImage',
  'bundle/deb/*.deb',
  'bundle/rpm/*.rpm',
  'bundle/nsis/*.exe',
  'bundle/msi/*.msi',
]) {
  assert.ok(workflow.includes(required), `passo da matriz ausente: ${required}`);
}

assert.ok(
  workflow.indexOf('npm run sidecar --workspace @cialai/desktop') < workflow.indexOf('npm test'),
  'o sidecar deve ser compilado antes da suíte',
);
assert.ok(
  workflow.indexOf('npm test') < workflow.indexOf('npm run build --workspace @cialai/desktop'),
  'o bundle só pode ser criado depois da suíte',
);
assert.ok(!workflow.includes('secrets.'), 'a CI de push e PR não pode consumir segredos');
assert.match(workflow, /^on:\n {2}push:\n(?: {4}#.*\n)? {4}branches: \["\*\*"\]\n/m, 'tags de release não disparam a CI de novo');
const integration = readFileSync(`${root}/.github/workflows/headscale-integration.yml`, 'utf8');
assert.match(integration, /if: github\.event_name != 'schedule' \|\| github\.repository == 'Cialai\/cialai'/, 'a agenda da integração roda só no repositório público');
assert.ok(
  workflow.indexOf('npm test') < workflow.indexOf('npm run test:browser'),
  'os checks de navegador rodam depois da suíte',
);
const browserPackage = JSON.parse(readFileSync(`${root}/tools/browser/package.json`, 'utf8'));
assert.match(browserPackage.dependencies.playwright, /^\d+\.\d+\.\d+$/, 'o Playwright precisa de versão exata');
const { SCENARIOS, verdict, viteFsPath } = await import(new URL('../browser/run-browser-checks.mjs', import.meta.url));
assert.deepEqual(SCENARIOS.map(({ name }) => name), ['desktop studio', 'desktop network', 'phone terminal']);
assert.equal(verdict('PASS: ok'), 'pass');
assert.equal(verdict('FAIL: erro'), 'fail');
assert.equal(verdict('CHECK: Cialai'), 'pending');
assert.equal(viteFsPath('/repo/', 'packages/ui/scripts/check-studio-browser.js'), '/@fs/repo/packages/ui/scripts/check-studio-browser.js');
assert.equal(viteFsPath('D:\\a\\cialai\\', 'packages/ui/x.js'), '/@fs/D:/a/cialai/packages/ui/x.js');

const ciConfig = JSON.parse(readFileSync(`${root}/apps/desktop/src-tauri/tauri.ci.conf.json`, 'utf8'));
assert.equal(ciConfig.bundle.createUpdaterArtifacts, false, 'o bundle da CI não pode exigir a chave privada do updater');

console.log('PASS ci matrix: Linux, Windows, macOS, bundle unsigned and artifacts');
