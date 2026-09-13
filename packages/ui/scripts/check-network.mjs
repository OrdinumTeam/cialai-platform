// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, 'utf8');
const context = read('src/desktop/TunnelContext.jsx');
const setup = read('src/desktop/NetworkSetup.jsx');
const pair = read('src/desktop/PairingDialog.jsx');
const devices = read('src/desktop/Devices.jsx');
const sidebar = read('src/desktop/Sidebar.jsx');
const toolbar = read('src/desktop/Toolbar.jsx');
const onboarding = read('src/desktop/Onboarding.jsx');
const workbench = read('src/terminals/ui/Workbench.jsx');

for (const command of [
  'tunnel_call', 'tunnel_control_configure', 'tunnel_control_configure_saved', 'tunnel_api_key_status', 'tunnel_doctor',
  'control.users.list', 'control.users.create', 'node.up', 'node.status', 'edge.serve',
  'pair.begin', 'pair.cancel', 'pair.approve', 'pair.deny', 'devices.list', 'devices.rename', 'devices.revoke',
]) assert.match(context, new RegExp(command.replaceAll('.', '\\.')), `Missing tunnel command: ${command}`);

for (const channel of ['tunnel://state', 'tunnel://pair', 'tunnel://devices']) assert.match(context, new RegExp(channel.replaceAll('/', '\\/')), `Missing tunnel event: ${channel}`);
assert.match(setup, /NetworkSetup/);
assert.match(onboarding, /'Rede'/);
assert.match(onboarding, /Configurar agora/);
assert.match(pair, /QRCode\.toCanvas/);
assert.match(pair, /width:\s*280/);
assert.match(pair, /PAIR_ROTATION_SECONDS/);
assert.match(devices, /renameDevice/);
assert.match(devices, /revokeDevice/);
assert.match(devices, /networkToo/);
assert.match(sidebar, /mac-sidebar__pair/);
assert.match(toolbar, /mac-tunnel-status/);
assert.match(workbench, /cialai:pair-device/);

const manifest = JSON.parse(read('package.json'));
assert.equal(manifest.dependencies.qrcode, '1.5.4');
console.log('PASS desktop network: Headscale setup, tunnel events, rotating QR and device actions are wired');
