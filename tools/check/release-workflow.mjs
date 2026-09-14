// SPDX-License-Identifier: Apache-2.0
// Contrato do release.yml e dos auxiliares de canal, assinatura e arquivos da release.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appVersions, releaseChannel } from '../release/release-channel.mjs';
import { signingPlan } from '../release/signing-mode.mjs';
import { CHECKSUM_FILE, formatChecksums, missingAssets, releaseNotes } from '../release/release-assets.mjs';

const rootUrl = new URL('../../', import.meta.url);
const root = fileURLToPath(rootUrl);
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const workflow = read('.github/workflows/release.yml');

// Canal: prévias abaixo de 1.0.0 ou com sufixo, estável a partir de 1.0.0, sempre igual à versão do app.
const same = (version) => ({ 'tauri.conf.json': version, 'Cargo.toml': version, 'apps/desktop/package.json': version });
assert.equal(releaseChannel('v0.1.0', same('0.1.0')), 'preview');
assert.equal(releaseChannel('v1.0.0-rc.1', same('1.0.0-rc.1')), 'preview');
assert.equal(releaseChannel('v1.0.0', same('1.0.0')), 'stable');
assert.throws(() => releaseChannel('v0.2.0', same('0.1.0')), /does not match/);
assert.throws(() => releaseChannel('0.1.0', same('0.1.0')), /Invalid release tag/);
assert.throws(() => releaseChannel('v0.1.0', { ...same('0.1.0'), 'Cargo.toml': '0.0.9' }), /Cargo\.toml/);
const versions = appVersions(rootUrl);
assert.equal(new Set(Object.values(versions)).size, 1, `desktop versions diverge: ${JSON.stringify(versions)}`);

// Assinatura: ad hoc no macOS sem Developer ID, Windows sem Authenticode sem conta, nada vaza para a configuração.
const empty = {};
assert.deepEqual(signingPlan('aarch64-apple-darwin', empty), {
  macos: 'adhoc', windows: 'none', config: { bundle: { macOS: { signingIdentity: '-' } } },
});
assert.equal(signingPlan('x86_64-apple-darwin', { APPLE_CERTIFICATE: 'x' }).macos, 'adhoc');
const apple = Object.fromEntries(['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'].map((name) => [name, 'fixture']));
assert.deepEqual(signingPlan('aarch64-apple-darwin', apple), { macos: 'developer-id', windows: 'none', config: {} });
assert.deepEqual(signingPlan('x86_64-pc-windows-msvc', empty), { macos: 'none', windows: 'unsigned', config: {} });
const azure = {
  AZURE_CLIENT_ID: 'fixture', AZURE_CLIENT_SECRET: 'fixture', AZURE_TENANT_ID: 'fixture',
  WINDOWS_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net', WINDOWS_SIGNING_ACCOUNT: 'ordinum', WINDOWS_SIGNING_PROFILE: 'cialai',
};
const trusted = signingPlan('x86_64-pc-windows-msvc', azure);
assert.equal(trusted.windows, 'trusted-signing');
assert.equal(trusted.config.bundle.windows.signCommand, 'trusted-signing-cli -e https://eus.codesigning.azure.net -a ordinum -c cialai -d Cialai %1');
assert.ok(!JSON.stringify(trusted.config).includes('AZURE_CLIENT_SECRET'));
assert.throws(() => signingPlan('x86_64-pc-windows-msvc', { ...azure, WINDOWS_SIGNING_ACCOUNT: 'a; rm' }), /unexpected characters/);
assert.throws(() => signingPlan('x86_64-pc-windows-msvc', { ...azure, WINDOWS_SIGNING_ENDPOINT: 'https://example.com' }), /Azure/);
assert.deepEqual(signingPlan('x86_64-unknown-linux-gnu', empty).config, {});
assert.throws(() => signingPlan('riscv64gc-unknown-none', empty), /Unknown release target/);

// Arquivos: nomes estáveis sem versão para /releases/latest/download e somas no formato do sha256sum.
const stable = [
  'Cialai_aarch64.dmg', 'Cialai_x64.dmg', 'Cialai_aarch64.app.tar.gz', 'Cialai_aarch64.app.tar.gz.sig',
  'Cialai_x64.app.tar.gz', 'Cialai_x64.app.tar.gz.sig', 'Cialai_x64-setup.exe', 'Cialai_x64-setup.exe.sig',
  'Cialai_x64.msi', 'Cialai_x64.msi.sig', 'Cialai_amd64.AppImage', 'Cialai_amd64.AppImage.sig', 'Cialai_amd64.deb',
  'Cialai_x86_64.rpm', 'latest.json',
];
assert.deepEqual(missingAssets(stable), []);
assert.deepEqual(missingAssets(stable.filter((name) => !name.endsWith('.rpm'))), ['Linux RPM']);
assert.deepEqual(missingAssets(stable.filter((name) => name !== 'Cialai_x64.dmg')), ['macOS Intel DMG']);
const digest = 'a'.repeat(64);
assert.equal(
  formatChecksums([{ name: 'b.deb', sha256: digest }, { name: CHECKSUM_FILE, sha256: digest }, { name: 'a.dmg', sha256: digest }]),
  `${digest}  a.dmg\n${digest}  b.deb\n`,
);
assert.throws(() => formatChecksums([{ name: 'a', sha256: 'zz' }]), /Invalid SHA 256/);

// Notas da prévia: aviso de binários sem assinatura de plataforma e passos do macOS e do Windows.
const preview = releaseNotes(read('tools/release/notes/preview.md'), 'v0.1.0');
for (const required of ['not signed with an Apple Developer ID', 'Privacy & Security', 'Open Anyway', 'More info', 'Run anyway', 'SHA256SUMS', 'TestFlight']) {
  assert.ok(preview.includes(required), `preview notes are missing: ${required}`);
}
assert.ok(!preview.includes('{{'), 'preview notes kept a template variable');
for (const name of ['Cialai_aarch64.dmg', 'Cialai_x64.dmg', 'Cialai_x64-setup.exe', 'Cialai_x64.msi', 'Cialai_amd64.AppImage', 'Cialai_amd64.deb', 'Cialai_x86_64.rpm', 'Cialai_android_universal.apk']) {
  assert.ok(preview.includes(name), `preview notes do not name ${name}`);
}
const prose = preview.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/https?:\/\/\S+/g, '');
assert.doesNotMatch(prose, /[()]/, 'preview notes use parentheses in visible text');
assert.doesNotMatch(prose, / - |–|—/, 'preview notes use a dash as separator');

// Workflow: guarda, canal, rascunho único, matriz, assinatura opcional e publicação conferida.
assert.match(workflow, /tags: \["v\*"\]/);
assert.match(workflow, /node tools\/release\/check-updater\.mjs --release/);
assert.match(workflow, /node tools\/release\/release-channel\.mjs "\$RELEASE_TAG" >> "\$GITHUB_OUTPUT"/);
assert.match(workflow, /if: steps\.channel\.outputs\.channel == 'stable'\n\s+run: node tools\/release\/check-release\.mjs --release/);
assert.match(workflow, /node tools\/release\/release-assets\.mjs draft "\$RELEASE_TAG" "\$CHANNEL"/);
assert.equal((workflow.match(/uses: tauri-apps\/tauri-action@v1/g) ?? []).length, 2);
assert.equal((workflow.match(/releaseId: \$\{\{ needs\.draft\.outputs\.release_id \}\}/g) ?? []).length, 2);
assert.equal((workflow.match(/releaseAssetNamePattern: "\[name\]_\[arch\]\[setup\]\[ext\]"/g) ?? []).length, 2);
assert.equal((workflow.match(/--config src-tauri\/tauri\.release\.conf\.json/g) ?? []).length, 2);
assert.match(workflow, /node tools\/release\/signing-mode\.mjs\n\s+--target \$\{\{ matrix\.target \}\}\n\s+--config-out apps\/desktop\/src-tauri\/tauri\.release\.conf\.json/);
assert.match(workflow, /- os: macos-14\n\s+target: aarch64-apple-darwin\n\s+- os: macos-14\n\s+target: x86_64-apple-darwin/);
assert.doesNotMatch(workflow, /macos-13/, 'macos-13 runners are retired');
const developerStep = workflow.slice(workflow.indexOf('- name: Build and upload with Developer ID'), workflow.indexOf('- name: Build and upload\n'));
const defaultStep = workflow.slice(workflow.indexOf('- name: Build and upload\n'), workflow.indexOf('\n  publish:'));
assert.match(developerStep, /if: steps\.signing\.outputs\.macos == 'developer-id'/);
assert.match(developerStep, /APPLE_CERTIFICATE: \$\{\{ secrets\.APPLE_CERTIFICATE \}\}/);
assert.match(defaultStep, /if: steps\.signing\.outputs\.macos != 'developer-id'/);
assert.doesNotMatch(defaultStep, /APPLE_/, 'the ad hoc build must not receive Apple credentials');
const publish = workflow.slice(workflow.indexOf('\n  publish:'));
assert.match(publish, /needs: \[guard, desktop\]/);
const order = ['release-assets.mjs verify', 'release-assets.mjs checksums', 'release-assets.mjs publish'];
for (let index = 1; index < order.length; index += 1) {
  assert.ok(publish.indexOf(order[index - 1]) < publish.indexOf(order[index]), `${order[index - 1]} must run before ${order[index]}`);
}
assert.match(read('.gitignore'), /^apps\/desktop\/src-tauri\/tauri\.release\.conf\.json$/m);

console.log('PASS release workflow: preview channel, optional platform signing, stable asset names, checksums and publication');
