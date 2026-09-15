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
// O modo Headscale saiu do RPC do sidecar v2: a integração antiga fica só manual até CON-070.
assert.match(integration, /^on:\n {2}workflow_dispatch:\n/m, 'a integração do Headscale só roda por disparo manual');
assert.doesNotMatch(integration, /^ {2}(push|pull_request|schedule):/m, 'a integração do Headscale não roda mais em push, PR ou agenda');
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

// Laboratório de NAT e reserva: PR que toque o núcleo ou o laboratório e disparo manual; agenda só em CON-072.
const netLabSource = readFileSync(`${root}/.github/workflows/net-lab.yml`, 'utf8');
const netLab = yaml.load(netLabSource);
assert.deepEqual(Object.keys(netLab.on).sort(), ['pull_request', 'workflow_dispatch'], 'o laboratório roda só em PR e por disparo manual');
assert.deepEqual(netLab.on.pull_request.paths, ['packages/tunnel-core/**', 'tools/net-lab/**', '.github/workflows/net-lab.yml']);
assert.equal(netLab.permissions.contents, 'read');
assert.ok(!netLabSource.includes('secrets.'), 'o laboratório não pode consumir segredos');
const labJob = netLab.jobs['nat-and-fallback'];
assert.equal(labJob['runs-on'], 'ubuntu-latest');
assert.equal(labJob.if, "github.event_name == 'workflow_dispatch' || github.repository == 'Cialai/cialai'", 'o PR do laboratório roda só no repositório público');
assert.ok(labJob.steps.some((step) => step.uses === 'actions/setup-go@v5' && step.with?.['go-version-file'] === 'packages/tunnel-core/go.mod'));
const labRun = labJob.steps.find((step) => step.run === 'npm run test:netlab');
assert.ok(labRun, 'o workflow roda npm run test:netlab');
assert.equal(labRun.env?.NETLAB_ARTIFACTS, '${{ runner.temp }}/net-lab', 'o relatório do laboratório vai para o artefato');
assert.ok(labJob.steps.some((step) => step.uses === 'actions/upload-artifact@v4' && step.if === 'always()'), 'relatório e logs sobem mesmo com falha');
const rootPackage = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
assert.equal(rootPackage.scripts['test:netlab'], 'node tools/run.mjs netlab');
const runJobs = readFileSync(`${root}/tools/run.mjs`, 'utf8');
assert.match(runJobs, /netlab: \{\n\s+cwd: 'packages\/tunnel-core',/);
assert.match(runJobs, /'go', 'test', '-mod=readonly', '-tags=netlab', '-count=1', '-timeout=25m', '-v', '-run', 'TestNetLab', '\.\/integration'/);
const labCompose = yaml.load(readFileSync(`${root}/tools/net-lab/compose.yaml`, 'utf8'));
assert.deepEqual(Object.keys(labCompose.services).sort(), ['desktop', 'phone', 'phone-lan', 'relay', 'router-desktop', 'router-phone', 'stun']);
assert.match(labCompose.services.stun.image, /^coturn\/coturn:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/, 'o coturn do laboratório tem versão e digest fixos');
assert.match(readFileSync(`${root}/tools/net-lab/Dockerfile`, 'utf8'), /^FROM alpine:\d+\.\d+@sha256:[0-9a-f]{64}$/m, 'a imagem base do laboratório tem digest fixo');
for (const [name, network] of Object.entries(labCompose.networks)) {
  assert.match(network.ipam?.config?.[0]?.subnet ?? '', /^\d+\.\d+\.\d+\.\d+\/24$/, `rede do laboratório sem sub-rede fixa: ${name}`);
}
const labRouter = readFileSync(`${root}/tools/net-lab/node/netlab-router`, 'utf8');
assert.match(labRouter, /--random-fully/, 'o NAT simétrico sorteia a porta pública por destino');
assert.match(labRouter, /-j DNAT --to-destination "\$LAN_HOST"/, 'o NAT cone encaminha o UDP de entrada ao host interno');
assert.match(readFileSync(`${root}/packages/tunnel-core/integration/netlab_test.go`, 'utf8'), /^\/\/go:build netlab$/m, 'o laboratório fica fora do go test comum');

console.log('PASS ci matrix: Linux, Windows, macOS, bundle unsigned, artifacts, mobile bindings and net lab');
