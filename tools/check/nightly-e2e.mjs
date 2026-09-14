// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const workflow = read('.github/workflows/nightly-e2e.yml');

// Gatilho diário e manual, sem push, PR ou segredos.
assert.match(workflow, /^on:\n {2}schedule:\n {4}- cron: '\d{1,2} \d{1,2} \* \* \*'\n {2}workflow_dispatch:\n/m, 'nightly precisa de cron diário e disparo manual');
assert.doesNotMatch(workflow, /^\s+(push|pull_request|pull_request_target):/m, 'nightly não roda em push ou PR');
assert.match(workflow, /^permissions:\n {2}contents: read$/m);
assert.match(workflow, /if: github\.event_name != 'schedule' \|\| github\.repository == 'Cialai\/cialai'/, 'a agenda do nightly roda só no repositório público');
assert.ok(!workflow.includes('secrets.'), 'o nightly não pode consumir segredos');

// Linux e Windows; o macOS roda o self test por tauri dev.
assert.match(workflow, /os: \[ubuntu-22\.04, windows-2022\]/);
assert.match(workflow, /fail-fast: false/);
assert.doesNotMatch(workflow, /macos-\d/);

for (const dependency of [
  'libwebkit2gtk-4.1-dev',
  'libgtk-3-dev',
  'libayatana-appindicator3-dev',
  'librsvg2-dev',
  'patchelf',
  'libxdo-dev',
  'libssl-dev',
  'zsh',
  'webkit2gtk-driver',
  'xvfb',
]) assert.ok(workflow.includes(dependency), `dependência Linux ausente: ${dependency}`);

const steps = [
  'actions/checkout@v4',
  'actions/setup-node@v4',
  'npm install --global npm@10.9.8',
  'toolchain: 1.98.1',
  'actions/setup-go@v5',
  'npm ci',
  'cargo install tauri-driver --locked --version ${{ env.TAURI_DRIVER_VERSION }}',
  'EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'https://msedgedriver.microsoft.com/',
  'GITHUB_PATH',
  'npm run sidecar --workspace @cialai/desktop',
  'npm run build --workspace @cialai/desktop -- --debug --no-bundle',
  'xvfb-run -a npm run test:selftest:driver -- --artifacts selftest-artifacts',
  'npm run test:selftest:driver -- --artifacts selftest-artifacts',
  'actions/upload-artifact@v4',
];
for (const step of steps) assert.ok(workflow.includes(step), `passo do nightly ausente: ${step}`);
assert.match(workflow, /TAURI_DRIVER_VERSION: 2\.0\.6/);
assert.match(workflow, /CARGO_BUILD_JOBS: 2/);
assert.match(workflow, /- name: Anexar evidências\n {8}if: always\(\)\n {8}uses: actions\/upload-artifact@v4/);
const order = ['npm ci', 'npm run sidecar --workspace @cialai/desktop', 'npm run build --workspace @cialai/desktop -- --debug --no-bundle', 'npm run test:selftest:driver', 'actions/upload-artifact@v4'];
for (let index = 1; index < order.length; index += 1) {
  assert.ok(workflow.indexOf(order[index - 1]) < workflow.indexOf(order[index]), `${order[index - 1]} deve vir antes de ${order[index]}`);
}

const scripts = JSON.parse(read('package.json')).scripts;
assert.equal(scripts['test:selftest:driver'], 'node tools/selftest/driver.mjs');
assert.equal(scripts['test:selftest'], 'node tools/selftest/run.mjs');

// Auxiliares puros do runner por tauri-driver.
const common = await import(pathToFileURL(`${root}tools/selftest/common.mjs`).href);
assert.equal(
  common.reportPath({ platform: 'darwin', env: {}, home: '/Users/ana' }),
  '/Users/ana/Library/Logs/br.com.ordinum.cialai/selftest.json',
);
assert.equal(
  common.reportPath({ platform: 'linux', env: {}, home: '/home/ana' }),
  '/home/ana/.local/share/br.com.ordinum.cialai/logs/selftest.json',
);
assert.equal(
  common.reportPath({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, home: '/home/ana' }),
  '/data/br.com.ordinum.cialai/logs/selftest.json',
);
assert.equal(
  common.reportPath({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local' }, home: 'C:\\Users\\ana' }).replaceAll('\\', '/'),
  'C:/Users/ana/AppData/Local/br.com.ordinum.cialai/logs/selftest.json',
);
assert.deepEqual(common.bridgeEnv({ PATH: '/bin' }, 41234), { PATH: '/bin', CIALAI_BRIDGE_PORT: '41234' });
assert.deepEqual(common.bridgeEnv({ CIALAI_BRIDGE_PORT: '3799' }, 41234), { CIALAI_BRIDGE_PORT: '3799' });
const port = await common.freePort();
assert.ok(Number.isInteger(port) && port > 0 && port < 65536, `porta livre inválida: ${port}`);
for (const runner of ['tools/selftest/run.mjs', 'tools/selftest/driver.mjs']) {
  assert.match(read(runner), /bridgeEnv\(process\.env, await freePort\(\)\)/, `${runner} precisa isolar a porta da ponte`);
}
assert.equal(common.targetDirProblem(undefined), '');
assert.equal(common.targetDirProblem('/Users/ana/.cache/cialai-target/target'), '');
assert.equal(common.targetDirProblem('/target/'), '');
assert.match(common.targetDirProblem('/Users/ana/.cache/cialai-target'), /pasta chamada target/);
assert.match(read('tools/selftest/run.mjs'), /targetDirProblem\(process\.env\.CARGO_TARGET_DIR\)/);
assert.match(read('tools/selftest/driver.mjs'), /targetDirProblem\(dirname\(dirname\(options\.app\)\)\)/);
assert.match(read('tools/selftest/driver.mjs'), /\/screenshot`\)/, 'o runner precisa guardar capturas da janela como evidência');
assert.equal(common.SCREENSHOT_INTERVAL_MS, 3000);
assert.equal(common.MAX_SCREENSHOTS, 8);
assert.equal(common.appBinary('linux', '/target').replaceAll('\\', '/'), '/target/debug/cialai-desktop');
assert.equal(common.appBinary('win32', '/target').replaceAll('\\', '/'), '/target/debug/cialai-desktop.exe');
assert.equal(common.selftestUrl('tauri://localhost/'), 'tauri://localhost/?cialai_selftest=1&onboarding=skip&motion=0#terminais');
assert.equal(common.selftestUrl('http://tauri.localhost/index.html?x=1#dispositivos'), 'http://tauri.localhost/index.html?x=1&cialai_selftest=1&onboarding=skip&motion=0#terminais');
assert.deepEqual(common.driverCapabilities('/app/cialai-desktop'), {
  capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: '/app/cialai-desktop' } } },
});
const parsed = common.parseDriverArgs(['--app', '/a', '--artifacts', 'evidencias', '--timeout', '120', '--native-driver', '/bin/msedgedriver'], { root: '/repo', platform: 'linux', env: {} });
assert.equal(parsed.app, '/a');
// O runner resolve a pasta de evidências no sistema em que roda; no Windows ela ganha a letra do disco.
assert.equal(parsed.artifacts, path.resolve('/repo', 'evidencias'));
assert.equal(parsed.timeoutMs, 120000);
assert.equal(parsed.port, 4444);
assert.equal(parsed.driver, 'tauri-driver');
assert.deepEqual(parsed.driverArgs, ['--port', '4444', '--native-driver', '/bin/msedgedriver']);
const defaults = common.parseDriverArgs([], { root: '/repo', platform: 'win32', env: { CARGO_TARGET_DIR: '/cache/target', TAURI_DRIVER: '/bin/tauri-driver' } });
assert.equal(defaults.app.replaceAll('\\', '/'), '/cache/target/debug/cialai-desktop.exe');
assert.equal(defaults.artifacts, path.resolve('/repo', 'target', 'selftest'));
assert.equal(defaults.timeoutMs, 300000);
assert.equal(defaults.driver, '/bin/tauri-driver');

// Roteiro dentro do app, portátil por sistema e sabor de shell.
const portable = await import(pathToFileURL(`${root}tools/selftest/portable.js`).href);
for (const flavor of ['posix', 'powershell', 'cmd']) {
  const command = portable.ptyMarkerCommand(flavor);
  assert.ok(command.endsWith('\r'), `${flavor} precisa de Enter`);
  assert.ok(!command.includes(portable.PTY_MARKER), `${flavor} não pode ecoar o marcador literal`);
}
assert.equal(portable.TERMINAL_READY_MS, 60000, 'a primeira abertura no CI monta caches antes do terminal');
assert.equal(portable.PTY_OUTPUT_MS, 10000);
assert.equal(portable.PTY_ATTEMPTS, 3, 'o comando do PTY é repetido quando o shell descarta a digitação inicial');
assert.equal(portable.ptyMarkerCommand('posix'), "printf 'CIALAI_%s\\n' SELFTEST_PTY\r");
assert.equal(portable.ptyMarkerCommand('powershell'), "Write-Output ('CIALAI_' + 'SELFTEST_PTY')\r");
assert.equal(portable.ptyMarkerCommand('cmd'), 'echo CIALAI_^SELFTEST_PTY\r');
assert.deepEqual(portable.noiseFixtures('macos'), ['.DS_Store', '._oculto.txt']);
assert.deepEqual(portable.noiseFixtures('linux'), ['.DS_Store', '.directory']);
assert.deepEqual(portable.noiseFixtures('windows'), ['Thumbs.db', 'desktop.ini']);
assert.equal(portable.quotedTail("'/tmp/run/com espaço.txt'"), "/com espaço.txt'");
assert.equal(portable.quotedTail('"C:/Users/ana/run/com espaço.txt"'), '/com espaço.txt"');
for (const message of ['zsh: command not found: com', "The term 'com' is not recognized as a name of a cmdlet", "'com' não é reconhecido como um comando interno"]) {
  assert.match(message, portable.EXECUTED_PATH);
}
const app = read('tools/selftest/selftest-app.js');
for (const contract of ["document.querySelector('.terminais-terminal__host .xterm-screen'), 'o terminal montar', TERMINAL_READY_MS", "includes(PTY_MARKER), 'a saída do PTY', PTY_OUTPUT_MS", "bufferText(session).trim(), 'o prompt do shell', TERMINAL_READY_MS", "attempt <= PTY_ATTEMPTS", 'ptyMarkerCommand(session.shellFlavor)', 'shellQuote(`${paths.root}/com espaço.txt`, session.shellFlavor)', 'noiseFixtures(platform().os)', 'EXECUTED_PATH.test(text)']) {
  assert.ok(app.includes(contract), `roteiro sem contrato portátil: ${contract}`);
}
assert.doesNotMatch(app, /printf 'CIALAI_SELFTEST_PTY/);
// O destaque conferido é o do próprio alvo: pasta com is-drop e terminal com is-dropping.
assert.ok(app.includes("drag(source, target, '.is-drop')"), 'arraste entre pastas precisa conferir o destaque da pasta');
assert.ok(app.includes("const target = () => row('destino');"), 'a pasta de destino é buscada de novo a cada quadro do arraste');
assert.ok(app.includes("drag(source, target, '.is-dropping')"), 'arraste para o terminal precisa conferir is-dropping');
assert.ok(app.includes("session.term.element?.closest('.terminais-terminal')"), 'o alvo é o terminal da sessão do teste');
assert.doesNotMatch(app, /\.terminais-terminal\.is-drop'/);

console.log('PASS nightly e2e: daily Linux and Windows self test by tauri-driver, pinned drivers, evidence upload and portable in-app script');
