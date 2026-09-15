// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const path = `${root}/tools/selftest/selftest-app.js`;
assert.ok(existsSync(path), 'Missing in-app selftest');
const selftest = readFileSync(path, 'utf8');
const read = (file) => readFileSync(`${root}/${file}`, 'utf8');
const main = read('packages/ui/src/desktop/main.jsx');
const commands = read('apps/desktop/src-tauri/src/commands.rs');
const lib = read('apps/desktop/src-tauri/src/lib.rs');
const supervisor = read('apps/desktop/src-tauri/src/tunnel/supervisor.rs');
const config = JSON.parse(read('apps/desktop/src-tauri/tauri.selftest.conf.json'));

for (const contract of [
  'app_selftest_paths',
  'PTY real',
  'arquivos pelo Rust',
  'arraste entre pastas',
  'caminho no terminal',
  'editor de CSV',
  'Dev Browser',
  'preferências e shell',
  'rede automática',
  'QR de pareamento',
  'painel de dispositivos',
  'app_request_quit',
]) assert.match(selftest, new RegExp(contract), `Missing selftest contract: ${contract}`);

assert.doesNotMatch(selftest, /\/Users\/[^/]+\/Github Projects|\.ordinum|\/tmp\/oc-selftest/);
assert.match(main, /tools\/selftest\/selftest-app\.js/);
assert.match(commands, /pub fn app_selftest_paths/);
assert.match(lib, /commands::app_selftest_paths/);
assert.match(config.build.devUrl, /cialai_selftest=1/);
assert.match(config.build.devUrl, /onboarding=skip/);

// Rede automática: o roteiro só observa. A rede sobe pelo TunnelContext, sem
// preferência gravada, sem net.start ou pair.begin próprios e sem campo.
for (const forbidden of [/set_preferences/, /'net\.start'/, /'pair\.begin'/, /tunnel_delete_api_key/, /\.value = /, /dispatchEvent\(new (InputEvent|KeyboardEvent)/]) {
  assert.doesNotMatch(selftest, forbidden, `O cenário de rede não pode configurar nada: ${forbidden}`);
}
for (const contract of [
  "invoke('get_preferences')",
  'NETWORK_FIELDS.join()',
  "document.querySelector('.mac-tunnel-status')",
  "tunnelObserver.observe(status, { subtree: true, childList: true, characterData: true })",
  "command: 'net.status'",
  'status.click()',
  "document.querySelector('.mac-pair__qr canvas')",
  "canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)",
  'qr.text.startsWith(PAIR_QR_PREFIX)',
  "translate('desktop.access.reserve')",
  "dialog.querySelector('.mac-pair__notice')",
  "'.mac-pair__qr canvas { filter: blur(14px); }'",
  "translate('shared.action.close')",
  "navItem(translate('desktop.view.devices.label'))",
  "document.querySelector('#view-dispositivos')",
  "view.querySelector('.mac-access__link')",
  "checks.length !== DIAGNOSTIC_CHECKS",
  "navItem(translate('view.terminais.label'))",
]) assert.ok(selftest.includes(contract), `Contrato do cenário de rede ausente: ${contract}`);
// O observador fica no botão do ponto; no documento inteiro reprovava o Dev Browser.
assert.doesNotMatch(selftest, /observe\(document\.(documentElement|body)/);
// Payload, onion e endereços não vão para o relatório nem para o andamento.
assert.doesNotMatch(selftest, /\$\{qr\.text\}|\$\{[^}]*\.payload|\$\{[^}]*onion|\$\{[^}]*candidates|\$\{fingerprint\}/);

// Seletores e comandos que o cenário usa continuam onde a interface e o Rust os declaram.
const ui = (file) => read(`packages/ui/src/desktop/${file}`);
assert.match(ui('Toolbar.jsx'), /className=\{`mac-tunnel-status is-\$\{[^`]+`\} onClick=\{onOpenPair\}/);
assert.match(ui('Sidebar.jsx'), /className=\{`mac-nav-item/);
const pairing = ui('PairingDialog.jsx');
for (const contract of [/className=\{`mac-pair__qr/, /<canvas ref=\{canvasRef\}/, /className="mac-pair__reserve"/, /className="mac-pair__notice"/, /<AppModal open=\{open\} title=\{translate\('desktop\.action\.pairPhone'\)\}/]) {
  assert.match(pairing, contract, `PairingDialog.jsx sem ${contract}`);
}
assert.match(read('packages/ui/src/components/ui.jsx'), /aria-label=\{translate\('shared\.action\.close'\)\}/);
const devices = ui('Devices.jsx');
for (const contract of [/id="view-dispositivos"/, /className="mac-devices__list-section"/, /aria-labelledby="advanced-identity"/, /mac-advanced__check-list/, /className="mac-devices__error" role="alert"/]) {
  assert.match(devices, contract, `Devices.jsx sem ${contract}`);
}
assert.match(ui('AccessPanel.jsx'), /mac-access__link" onClick=\{onDiagnostics\}/);
assert.match(ui('TunnelContext.jsx'), /Promise\.all\(\[invoke\('get_preferences'\), listenersRef\.current\]\)[\s\S]*startNetwork\(next\)/, 'a rede sobe sozinha ao abrir');
for (const command of ['tunnel_call', 'get_preferences']) assert.match(lib, new RegExp(`commands::${command},`), `lib.rs sem ${command}`);
for (const removed of ['tunnel_control_configure', 'tunnel_control_configure_saved', 'tunnel_control_rotate_api_key', 'tunnel_api_key_status']) {
  assert.ok(!lib.includes(removed) && !commands.includes(removed), `O comando do Headscale voltou: ${removed}`);
}
assert.match(supervisor, /const EDGE_COMMANDS: &\[&str\] = &\["net\.start"\];/, 'o Rust injeta os campos da borda em net.start');

// Constantes portáteis do cenário.
const portable = await import(pathToFileURL(`${root}tools/selftest/portable.js`).href);
assert.deepEqual(portable.NETWORK_READY_STATES, ['pairable', 'accessible']);
assert.deepEqual(portable.NETWORK_FIELDS, ['desktopName', 'keepAwakeWhilePaired', 'requireApproval']);
assert.equal(portable.PAIR_QR_PREFIX, 'CIALAI2.');
assert.equal(portable.DIAGNOSTIC_CHECKS, 11);
assert.ok(portable.NETWORK_READY_MS >= 60000, 'a primeira execução do Tor precisa de folga');
const preparing = portable.progressPattern((progress) => `preparando ${progress}%`);
assert.ok(preparing.test('preparando 0%') && preparing.test('preparando 100%'));
assert.ok(!preparing.test('preparando %') && !preparing.test('xpreparando 5%') && !preparing.test('preparando 5%.'));
assert.ok(portable.progressPattern((progress) => `Reserva (${progress}%) pronta?`).test('Reserva (42%) pronta?'), 'o texto traduzido é escapado');
const { dictionaries } = await import('@cialai/i18n');
for (const [locale, dictionary] of Object.entries(dictionaries)) {
  for (const key of ['desktop.tunnel.reservePreparing', 'desktop.access.reservePreparing']) {
    assert.ok(portable.progressPattern((progress) => dictionary[key].replace('{progress}', progress)).test(dictionary[key].replace('{progress}', '37')), `${locale} ${key}`);
  }
}

// Leitor de QR do roteiro contra a mesma biblioteca que desenha o diálogo.
const qr = await import(pathToFileURL(`${root}tools/selftest/qr.js`).href);
const require = createRequire(`${root}packages/ui/package.json`);
const QRCode = require('qrcode');
const renderer = require('qrcode/lib/renderer/utils.js');
let symbols = 0;
for (let version = 1; version <= 40; version += 1) {
  for (const level of qr.LEVELS) {
    for (const text of ['A', '31415926535', 'CIALAI2 FIXTURE 42', 'CIALAI2.eyJ2IjoyLCJmaXh0dXJlIjp0cnVlfQ', 'ação ✓ 日本']) {
      let symbol;
      try { symbol = QRCode.create(text, { version, errorCorrectionLevel: level }); } catch (_error) { continue; }
      const decoded = qr.decodeModules((row, col) => Boolean(symbol.modules.get(row, col)), symbol.modules.size);
      assert.deepEqual(decoded, { text, version, level }, `QR ${version}${level} de ${JSON.stringify(text)}`);
      symbols += 1;
    }
  }
}
assert.ok(symbols > 700, `poucos símbolos conferidos: ${symbols}`);
const render = pairing.match(/QRCode\.toCanvas\(canvasRef\.current, pair\.payload, \{\s*width: (\d+),\s*margin: (\d+),\s*errorCorrectionLevel: '([LMQH])',\s*color: \{ dark: '(#[0-9a-f]{6})', light: '(#[0-9a-f]{6})' \},\s*\}\)/);
assert.ok(render, 'opções do QR do diálogo mudaram; confira o leitor do autoteste');
const [, width, margin, errorCorrectionLevel, dark, light] = render;
// Payload fictício no formato v2, do tamanho medido no app e um pouco maior.
for (const size of [120, 732, 980]) {
  const payload = `CIALAI2.${Buffer.from(JSON.stringify({ v: 2, fixture: 'x'.repeat(size) })).toString('base64url')}`.slice(0, size);
  const symbol = QRCode.create(payload, { errorCorrectionLevel });
  const options = renderer.getOptions({ width: Number(width), margin: Number(margin), color: { dark, light } });
  const side = renderer.getImageWidth(symbol.modules.size, options);
  const data = new Uint8ClampedArray(side * side * 4);
  renderer.qrToImageData(data, symbol, options);
  const decoded = qr.decodeImage({ data, width: side, height: side });
  assert.equal(decoded.text, payload, `o leitor não leu o canvas de ${size} caracteres na versão ${symbol.version}`);
}
assert.throws(() => qr.decodeImage({ data: new Uint8ClampedArray(16 * 16 * 4).fill(255), width: 16, height: 16 }), /módulos escuros/);

console.log(`PASS selftest contract: isolated app paths, native PTY, files, drag, editor, browser and automatic network with the v2 QR read back from the canvas; QR reader matched ${symbols} symbols`);
