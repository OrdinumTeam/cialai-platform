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
  'actions/cache@v4',
  'path: packages/tunnel-core/build/tor/downloads',
  "hashFiles('tools/fetch-tor.mjs')",
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
  workflow.indexOf('path: packages/tunnel-core/build/tor/downloads') < workflow.indexOf('npm run sidecar --workspace @cialai/desktop'),
  'o cache do Tor precisa vir antes do sidecar local, que prepara resources/tor',
);
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

// Bindings móveis: disparo manual, mesmo script e NDK do Codemagic e anexo à release só com tag.
const { createRequire } = await import('node:module');
// O mesmo js-yaml que o teste do codemagic.yaml resolve a partir do app móvel.
const yaml = createRequire(`${root}/apps/mobile/package.json`)('js-yaml');
const mobileSource = readFileSync(`${root}/.github/workflows/mobile-artifacts.yml`, 'utf8');
const mobile = yaml.load(mobileSource);
assert.deepEqual(Object.keys(mobile.on), ['workflow_dispatch'], 'os bindings móveis só rodam por disparo manual');
assert.equal(mobile.permissions.contents, 'read');
const bindings = mobile.jobs.bindings;
assert.equal(bindings['runs-on'], 'macos-14');
const codemagic = yaml.load(readFileSync(`${root}/codemagic.yaml`, 'utf8'));
assert.equal(mobile.env.ANDROID_NDK_VERSION, codemagic.workflows['android-play'].environment.ndk, 'o NDK dos bindings acompanha o Codemagic');
const mobileRuns = bindings.steps.map((step) => step.run || '').join('\n');
assert.match(mobileRuns, /tools\/build-tunnel-mobile\.sh all "\$RUNNER_TEMP\/mobile"/);
assert.match(mobileRuns, /shasum -a 256 -c Tunnelcore\.xcframework\.zip\.sha256/);
assert.match(mobileRuns, /shasum -a 256 -c tunnelcore\.aar\.sha256/);
const attach = bindings.steps.find((step) => /gh release upload/.test(step.run || ''));
assert.equal(attach?.if, "inputs.tag != ''", 'sem tag os bindings não tocam em nenhuma release');
assert.match(attach.run, /release-assets\.mjs checksums "\$RELEASE_TAG"/, 'o SHA256SUMS da release precisa cobrir os bindings');
assert.deepEqual([...mobileSource.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]), ['GITHUB_TOKEN']);
// App iOS para o simulador: opcional, depois dos bindings, sem assinatura e sem secrets.
const iosApp = mobile.jobs['ios-app'];
assert.equal(iosApp.if, 'inputs.ios_app', 'o app iOS só compila quando pedido');
assert.equal(iosApp.needs, 'bindings', 'o app iOS usa o XCFramework recém compilado');
const iosRuns = iosApp.steps.map((step) => step.run || '').join('\n');
assert.match(iosRuns, /CODE_SIGNING_ALLOWED=NO/, 'o app do simulador não assina');
assert.match(iosRuns, /-sdk iphonesimulator/);
const binder = readFileSync(`${root}/tools/build-tunnel-mobile.sh`, 'utf8');
assert.match(binder, /cd "\$output_dir" && shasum -a 256 Tunnelcore\.xcframework\.zip > Tunnelcore\.xcframework\.zip\.sha256/, 'o hash publicado não leva caminho do runner');
assert.match(binder, /cd "\$output_dir" && shasum -a 256 tunnelcore\.aar > tunnelcore\.aar\.sha256/);

console.log('PASS ci matrix: Linux, Windows, macOS, bundle unsigned, artifacts and mobile bindings');
