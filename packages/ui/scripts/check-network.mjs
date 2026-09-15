// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { dictionaries } from '@cialai/i18n';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, 'utf8');
const context = read('src/desktop/TunnelContext.jsx');
const model = read('src/desktop/tunnel-model.js');
const panel = read('src/desktop/AccessPanel.jsx');
const pair = read('src/desktop/PairingDialog.jsx');
const devices = read('src/desktop/Devices.jsx');
const sidebar = read('src/desktop/Sidebar.jsx');
const toolbar = read('src/desktop/Toolbar.jsx');
const onboarding = read('src/desktop/Onboarding.jsx');
const preferences = read('src/desktop/Preferences.jsx');
const workbench = read('src/terminals/ui/Workbench.jsx');
const surfaces = { context, model, panel, pair, devices, onboarding, preferences };

// A interface fala o contrato v2: a rede sobe em `net.start`, sem Headscale.
for (const command of [
  'tunnel_call', 'tunnel_delete_api_key', 'get_preferences',
  'net.start', 'net.status', 'net.refresh', 'diagnostics.run',
  'pair.begin', 'pair.cancel', 'pair.approve', 'pair.deny', 'devices.list', 'devices.rename', 'devices.revoke',
]) assert.ok(context.includes(`'${command}'`), `Missing tunnel command: ${command}`);
for (const event of ['net.state', 'tor.state', 'tunnel.state']) assert.ok(model.includes(`'${event}'`), `Missing tunnel state event: ${event}`);
for (const event of ['session.opened', 'session.closed', 'devices.changed', 'pair.completed', 'pair.requested', 'pair.failed']) assert.ok(context.includes(`'${event}'`), `Missing tunnel event: ${event}`);
for (const channel of ['tunnel://state', 'tunnel://pair', 'tunnel://devices']) assert.ok(context.includes(channel), `Missing tunnel channel: ${channel}`);
assert.match(context, /call\('net\.start', netStartArgs\(/, 'net.start must carry only the interface arguments');
assert.match(model, /return \{\s*desktopName: [^}]+,\s*requireApproval: config\.requireApproval,\s*\};/, 'net.start arguments from the interface are desktopName and requireApproval');
assert.match(context, /net\.desktop|snapshot\.net\?\.desktop/, 'The desktop identity comes from NetStatus.desktop');

for (const [name, source] of Object.entries(surfaces)) {
  for (const removed of [
    'tunnel_control_configure', 'tunnel_api_key_status', 'control.users', 'node.up', 'node.status', 'edge.serve',
    'controlUrl', 'userName', 'apiKey', 'hskey', 'cialai_desktop_id', 'NetworkSetup', 'networkIsConfigured',
  ]) assert.ok(!source.includes(removed), `${name} still carries the Headscale flow: ${removed}`);
}
for (const source of [context, model]) assert.ok(!source.includes('localStorage'), 'The desktop identity no longer lives in localStorage');
assert.equal(existsSync(`${root}/src/desktop/NetworkSetup.jsx`), false, 'NetworkSetup.jsx must be replaced by the access panel');

// Painel sem campos e passo informativo no onboarding.
assert.doesNotMatch(panel, /<(input|select|textarea)\b/, 'The access panel has no fields');
for (const key of ['desktop.access.title', 'desktop.access.reserve', 'desktop.access.connectedPhones', 'desktop.action.pairPhone', 'desktop.access.advanced']) assert.ok(panel.includes(`'${key}'`), `Access panel misses ${key}`);
assert.match(panel, /role="progressbar"/, 'Reserve progress must be visible');
const mobileStep = onboarding.slice(onboarding.indexOf('function MobileStep'), onboarding.indexOf('function Ready'));
assert.ok(mobileStep.length > 0, 'Onboarding needs the informative mobile step');
assert.doesNotMatch(mobileStep, /<(input|select|textarea|button)\b/, 'The mobile onboarding step only informs');
assert.match(preferences, /<AccessPanel /);
for (const field of ['desktopName', 'requireApproval', 'keepAwakeWhilePaired']) assert.match(preferences, new RegExp(`network\\.${field}`), `Preferences keep ${field}`);

// Pareamento: QR assim que pair.begin responde, reserva e rotação em 90 s.
assert.match(pair, /QRCode\.toCanvas/);
assert.match(pair, /width:\s*280/);
assert.match(pair, /PAIR_ROTATION_SECONDS/);
assert.match(pair, /rotateAfterSeconds/);
assert.match(pair, /directReady\(tunnel\.snapshot\)/);
assert.match(pair, /<ReserveValue tor=\{tor\} \/>/);
assert.match(pair, /desktop\.pair\.reserveNotice/);

// Dispositivos: badge por transporte e diagnóstico avançado com as redes públicas.
for (const contract of [/renameDevice/, /revokeDevice/, /deviceTransport/, /desktop\.devices\.transportDirect/, /desktop\.devices\.transportReserve/, /runDiagnostics/, /publicNetworks/, /candidateKindLabel/, /mappingLabel/, /tor\?\.onion/, /desktop\.access\.bootstrap/, /deleteLegacyApiKey/]) {
  assert.match(devices, contract, `Devices misses ${contract}`);
}
for (const network of ['publicTor', 'publicStun', 'publicMdns']) assert.ok(devices.includes(`desktop.access.${network}`), `Public network missing: ${network}`);
assert.doesNotMatch(devices, /networkToo/, 'Revoking no longer touches a network node');
for (const key of ['desktop.tunnel.pairable', 'desktop.tunnel.reservePreparing', 'desktop.tunnel.accessible', 'desktop.tunnel.problem']) assert.ok(model.includes(`'${key}'`), `State dot misses ${key}`);

assert.match(sidebar, /mac-sidebar__pair/);
assert.match(toolbar, /mac-tunnel-status/);
assert.match(workbench, /cialai:pair-device/);

for (const [locale, dictionary] of Object.entries(dictionaries)) {
  const legacy = Object.keys(dictionary).filter((key) => key.startsWith('desktop.network.') || /^desktop\.tunnel\.error\.(control|node)/.test(key));
  assert.deepEqual(legacy, [], `${locale} keeps Headscale keys`);
}
assert.equal(dictionaries['pt-BR']['desktop.tunnel.pairable'], 'Pronto para parear');
assert.equal(dictionaries['pt-BR']['desktop.devices.transportDirect'], 'Direta');
assert.equal(dictionaries['pt-BR']['desktop.devices.transportReserve'], 'Reserva');

const manifest = JSON.parse(read('package.json'));
assert.equal(manifest.dependencies.qrcode, '1.5.4');
console.log('PASS desktop network: net.start on launch, access panel without fields, reserve-aware QR and transport badges are wired');
