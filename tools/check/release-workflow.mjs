// SPDX-License-Identifier: Apache-2.0
// Contrato do release.yml e dos auxiliares de canal, assinatura e arquivos da release.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appVersions, releaseChannel } from '../release/release-channel.mjs';
import { signingPlan } from '../release/signing-mode.mjs';
import { CHECKSUM_FILE, formatChecksums, missingAssets, releaseNotes, updaterManifest } from '../release/release-assets.mjs';

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
const apple = {
  ...Object.fromEntries(['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_API_PRIVATE_KEY'].map((name) => [name, 'fixture'])),
  APPLE_API_KEY: 'ABCDE12345', APPLE_API_ISSUER: '69a6de70-0000-47e3-e053-5b8c7c11a4d1',
};
assert.deepEqual(signingPlan('aarch64-apple-darwin', apple), { macos: 'developer-id', windows: 'none', config: {} });
assert.equal(signingPlan('aarch64-apple-darwin', { ...apple, APPLE_API_PRIVATE_KEY: '' }).macos, 'adhoc');
assert.equal(signingPlan('aarch64-apple-darwin', { ...apple, APPLE_ID: 'fixture', APPLE_PASSWORD: 'fixture', APPLE_API_KEY: '' }).macos, 'adhoc');
assert.throws(() => signingPlan('aarch64-apple-darwin', { ...apple, APPLE_API_KEY: '../../x' }), /APPLE_API_KEY/);
assert.throws(() => signingPlan('aarch64-apple-darwin', { ...apple, APPLE_API_ISSUER: 'issuer' }), /issuer ID/);
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

// latest.json montado depois da matriz com URLs da tag, chaves por sistema e por instalador.
const signatures = Object.fromEntries(stable.filter((name) => /\.(app\.tar\.gz|AppImage|exe|msi)$/.test(name)).map((name) => [`${name}.sig`, `sig-${name}\n`]));
const manifest = updaterManifest({
  tag: 'v0.1.0', repo: 'Cialai/cialai', names: stable, signatures, notes: 'Cialai v0.1.0', date: new Date('2026-09-14T04:05:06.789Z'),
});
assert.equal(manifest.version, '0.1.0');
assert.equal(manifest.pub_date, '2026-09-14T04:05:06Z');
assert.deepEqual(Object.keys(manifest.platforms).sort(), [
  'darwin-aarch64', 'darwin-aarch64-app', 'darwin-x86_64', 'darwin-x86_64-app', 'linux-x86_64', 'linux-x86_64-appimage',
  'windows-x86_64', 'windows-x86_64-msi', 'windows-x86_64-nsis',
]);
assert.deepEqual(manifest.platforms['darwin-aarch64'], {
  signature: 'sig-Cialai_aarch64.app.tar.gz', url: 'https://github.com/Cialai/cialai/releases/download/v0.1.0/Cialai_aarch64.app.tar.gz',
});
assert.equal(manifest.platforms['windows-x86_64'].url, 'https://github.com/Cialai/cialai/releases/download/v0.1.0/Cialai_x64-setup.exe');
assert.equal(manifest.platforms['linux-x86_64'].url, 'https://github.com/Cialai/cialai/releases/download/v0.1.0/Cialai_amd64.AppImage');
const withoutMacSignature = { ...signatures };
delete withoutMacSignature['Cialai_x64.app.tar.gz.sig'];
assert.throws(() => updaterManifest({ tag: 'v0.1.0', repo: 'Cialai/cialai', names: stable, signatures: withoutMacSignature, notes: '', date: new Date() }), /darwin-x86_64/);

// Notas da prévia: macOS notarizado sem liberação manual e passos do Windows ainda sem assinatura.
const preview = releaseNotes(read('tools/release/notes/preview.md'), 'v0.1.0');
for (const required of ['signed with the Ordinum Developer ID and notarized by Apple', 'Windows installers are not signed', 'More info', 'Run anyway', 'SHA256SUMS', 'TestFlight']) {
  assert.ok(preview.includes(required), `preview notes are missing: ${required}`);
}
for (const stale of ['Open Anyway', 'Privacy & Security', 'com.apple.quarantine']) {
  assert.ok(!preview.includes(stale), `preview notes still teach the unsigned macOS bypass: ${stale}`);
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
assert.equal((workflow.match(/uploadUpdaterJson: false/g) ?? []).length, 2, 'parallel jobs must not race on latest.json');
assert.match(workflow, /node tools\/release\/signing-mode\.mjs\n\s+--target \$\{\{ matrix\.target \}\}\n\s+--config-out apps\/desktop\/src-tauri\/tauri\.release\.conf\.json/);
assert.match(workflow, /- os: macos-14\n\s+target: aarch64-apple-darwin\n\s+- os: macos-14\n\s+target: x86_64-apple-darwin/);
assert.doesNotMatch(workflow, /macos-13/, 'macos-13 runners are retired');
const developerStep = workflow.slice(workflow.indexOf('- name: Build and upload with Developer ID'), workflow.indexOf('- name: Build and upload\n'));
const defaultStep = workflow.slice(workflow.indexOf('- name: Build and upload\n'), workflow.indexOf('\n  publish:'));
assert.match(developerStep, /if: steps\.signing\.outputs\.macos == 'developer-id'/);
assert.match(developerStep, /APPLE_CERTIFICATE: \$\{\{ secrets\.APPLE_CERTIFICATE \}\}/);
assert.match(developerStep, /APPLE_API_KEY: \$\{\{ secrets\.APPLE_API_KEY \}\}/);
assert.doesNotMatch(developerStep, /APPLE_ID|APPLE_PASSWORD|APPLE_API_PRIVATE_KEY/, 'Tauri must notarize with the API key file only');
const keyStep = workflow.slice(workflow.indexOf('- name: Write the notarization key'), workflow.indexOf('- name: Build and upload with Developer ID'));
assert.match(keyStep, /if: steps\.signing\.outputs\.macos == 'developer-id'/);
assert.match(keyStep, /"\$RUNNER_TEMP\/private_keys\/AuthKey_\$\{APPLE_API_KEY\}\.p8"/);
assert.match(keyStep, /echo "APPLE_API_KEY_PATH=\$key_path" >> "\$GITHUB_ENV"/);
assert.match(defaultStep, /if: steps\.signing\.outputs\.macos != 'developer-id'/);
assert.doesNotMatch(defaultStep, /APPLE_/, 'the ad hoc build must not receive Apple credentials');
// O DMG criado depois da notarização do .app também é notarizado, grampeado e substitui o enviado pelo tauri-action.
const dmgStep = workflow.slice(workflow.indexOf('- name: Notarize, staple and replace the DMG'), workflow.indexOf('- name: Build and upload\n'));
assert.ok(workflow.indexOf('- name: Build and upload with Developer ID') < workflow.indexOf('- name: Notarize, staple and replace the DMG'), 'the DMG is notarized after the Developer ID build');
assert.match(dmgStep, /if: steps\.signing\.outputs\.macos == 'developer-id'/);
assert.match(dmgStep, /bash tools\/release\/notarize-dmg\.sh "\$dmg"/);
assert.match(dmgStep, /aarch64-apple-darwin\) asset=Cialai_aarch64\.dmg/);
assert.match(dmgStep, /x86_64-apple-darwin\) asset=Cialai_x64\.dmg/);
assert.match(dmgStep, /gh release upload "\$RELEASE_TAG" "\$RUNNER_TEMP\/\$asset" --repo "\$GITHUB_REPOSITORY" --clobber/);
assert.doesNotMatch(dmgStep, /APPLE_API_PRIVATE_KEY|APPLE_CERTIFICATE/, 'the DMG step only reads the key file written before the build');
const notarizer = readFileSync(new URL('../release/notarize-dmg.sh', import.meta.url), 'utf8');
assert.match(notarizer, /xcrun notarytool submit "\$dmg"/);
assert.match(notarizer, /--key "\$APPLE_API_KEY_PATH" --key-id "\$APPLE_API_KEY" --issuer "\$APPLE_API_ISSUER"/);
assert.match(notarizer, /\[\[ "\$status" == "Accepted" \]\]/);
assert.match(notarizer, /xcrun stapler staple "\$dmg"/);
const torSignStart = workflow.indexOf('- name: Sign the nested Tor binaries with Developer ID');
assert.ok(torSignStart > workflow.indexOf('node tools/fetch-tor.mjs --stage'), 'Tor is staged before its Developer ID signature');
assert.ok(torSignStart < workflow.indexOf('- name: Write the notarization key'), 'nested Tor binaries are signed before the Tauri build');
const torSignStep = workflow.slice(torSignStart, workflow.indexOf('- name: Write the notarization key'));
assert.match(torSignStep, /if: steps\.signing\.outputs\.macos == 'developer-id'/);
assert.deepEqual([...torSignStep.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]), ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY']);
assert.match(torSignStep, /trap cleanup EXIT/);
assert.match(torSignStep, /security delete-keychain "\$keychain"/);
assert.match(torSignStep, /node tools\/fetch-tor\.mjs --sign --keychain "\$keychain" --target \$\{\{ matrix\.target \}\}/);
assert.match(torSignStep, /node tools\/fetch-tor\.mjs --verify-resource --target \$\{\{ matrix\.target \}\}/);
const publish = workflow.slice(workflow.indexOf('\n  publish:'));
assert.match(publish, /needs: \[guard, desktop\]/);
const order = ['release-assets.mjs updater-json', 'release-assets.mjs verify', 'release-assets.mjs checksums', 'release-assets.mjs publish'];
for (let index = 1; index < order.length; index += 1) {
  assert.ok(publish.indexOf(order[index - 1]) < publish.indexOf(order[index]), `${order[index - 1]} must run before ${order[index]}`);
}
assert.match(read('.gitignore'), /^apps\/desktop\/src-tauri\/tauri\.release\.conf\.json$/m);

console.log('PASS release workflow: preview channel, optional platform signing, stable asset names, checksums and publication');
