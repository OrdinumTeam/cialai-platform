// SPDX-License-Identifier: Apache-2.0
// Contrato do release.yml e dos auxiliares de canal, assinatura e arquivos da release.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appVersions, releaseChannel } from '../release/release-channel.mjs';
import { signingPlan } from '../release/signing-mode.mjs';
import {
  CHECKSUM_FILE, formatChecksums, linuxReleaseAssets, missingAssets, releaseNotes, stableLinuxName, updaterManifest,
} from '../release/release-assets.mjs';
import {
  APPIMAGE_RUNTIME, APPIMAGETOOL, APPRUN_PATHS, APPRUN_TEMPLATE, bundleRunpath, hostLibraryReason,
} from '../release/fix-appimage.mjs';
import { verifyUpdaterSignature } from '../release/verify-updater-signature.mjs';

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
assert.equal(signingPlan('x86_64-unknown-linux-gnu', apple).macos, 'none', 'Linux never takes the Developer ID tauri-action path');
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

// Pacotes Linux enviados pelo gh depois da correção do AppImage, com os nomes estáveis do tauri-action.
assert.equal(stableLinuxName('Cialai_0.2.0_amd64.AppImage'), 'Cialai_amd64.AppImage');
assert.equal(stableLinuxName('Cialai_0.2.0_amd64.AppImage.sig'), 'Cialai_amd64.AppImage.sig');
assert.equal(stableLinuxName('Cialai_1.0.0-rc.1_amd64.deb'), 'Cialai_amd64.deb');
assert.equal(stableLinuxName('Cialai-0.2.0-1.x86_64.rpm.sig'), 'Cialai_x86_64.rpm.sig');
assert.equal(stableLinuxName('Cialai.AppDir'), null);
const linuxBundle = [
  'appimage/Cialai.AppDir', 'appimage/Cialai_0.2.0_amd64.AppImage', 'appimage/Cialai_0.2.0_amd64.AppImage.sig',
  'deb/Cialai_0.2.0_amd64.deb', 'deb/Cialai_0.2.0_amd64.deb.sig', 'rpm/Cialai-0.2.0-1.x86_64.rpm', 'rpm/Cialai-0.2.0-1.x86_64.rpm.sig',
];
assert.deepEqual(linuxReleaseAssets(linuxBundle).map(({ name }) => name), [
  'Cialai_amd64.AppImage', 'Cialai_amd64.AppImage.sig', 'Cialai_amd64.deb', 'Cialai_amd64.deb.sig', 'Cialai_x86_64.rpm', 'Cialai_x86_64.rpm.sig',
]);
assert.ok(linuxReleaseAssets(linuxBundle).every(({ source, name }) => linuxBundle.includes(source) && stable.includes(name.replace(/\.(deb|rpm)\.sig$/, '.$1'))));
assert.throws(() => linuxReleaseAssets(linuxBundle.filter((file) => !file.endsWith('.AppImage.sig'))), /Linux AppImage signature/);
assert.throws(() => linuxReleaseAssets([...linuxBundle, 'appimage/Cialai_0.1.0_amd64.AppImage']), /Duplicate/);

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

// Correção do AppImage: bibliotecas que o Mesa do sistema carrega saem do bundle, o que só o bundle tem fica.
const reportConflicts = ['libelf.so.1', 'libffi.so.8', 'libwayland-client.so.0', 'libXau.so.6', 'libxcb-randr.so.0', 'libxcb-shm.so.0', 'libXdmcp.so.6', 'libzstd.so.1'];
for (const name of [
  ...reportConflicts, 'libwayland-server.so.0', 'libwayland-egl.so.1', 'libxcb.so.1', 'libxcb-render.so.0', 'libX11.so.6', 'libX11-xcb.so.1',
  'libXext.so.6', 'libXfixes.so.3', 'libdrm.so.2', 'libdrm_intel.so.1', 'libgbm.so.1', 'libEGL.so.1', 'libEGL_mesa.so.0', 'libGL.so.1',
  'libGLX_mesa.so.0', 'libGLdispatch.so.0', 'libgallium-26.2.2-arch1.1.so', 'libexpat.so.1', 'libz.so.1', 'libstdc++.so.6', 'libgcc_s.so.1',
]) {
  assert.ok(hostLibraryReason(name), `the AppImage must leave ${name} to the system`);
}
for (const name of [
  'libwebkit2gtk-4.1.so.0', 'libjavascriptcoregtk-4.1.so.0', 'libsoup-3.0.so.0', 'libicuuc.so.70', 'libgtk-3.so.0', 'libgdk-3.so.0',
  'libglib-2.0.so.0', 'libgio-2.0.so.0', 'libgstreamer-1.0.so.0', 'libgstgl-1.0.so.0', 'libxml2.so.2', 'libjpeg.so.8', 'libepoxy.so.0',
  'libxkbcommon.so.0', 'libXi.so.6', 'libXrender.so.1', 'libdw.so.1', 'libzip.so.4', 'libssl.so.3', 'libcrypto.so.3', 'libevent-2.1.so.7',
]) {
  assert.equal(hostLibraryReason(name), null, `the AppImage must keep ${name}`);
}
assert.equal(bundleRunpath('usr/bin/cialai-desktop'), '$ORIGIN/../lib');
assert.equal(bundleRunpath('usr/lib/libwebkit2gtk-4.1.so.0'), '$ORIGIN');
assert.equal(bundleRunpath('usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess'), '$ORIGIN/../..');
assert.equal(bundleRunpath('usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess'), '$ORIGIN/../..');
assert.equal(bundleRunpath('usr/lib/x86_64-linux-gnu/gio/modules/libgiognutls.so'), '$ORIGIN/../../..');
assert.equal(bundleRunpath('usr/lib/Cialai/tor/tor/tor'), null, 'Tor keeps its own $ORIGIN runpath');
for (const tool of [APPIMAGETOOL, APPIMAGE_RUNTIME]) {
  assert.match(tool.url, new RegExp(`^https://github\\.com/AppImage/[\\w-]+/releases/download/${tool.version.replaceAll('.', '\\.')}/[\\w.-]+x86_64(\\.AppImage)?$`));
  assert.match(tool.sha256, /^[0-9a-f]{64}$/, `${tool.url} needs a pinned SHA-256`);
}
const appRun = readFileSync(APPRUN_TEMPLATE, 'utf8');
// O bit de execução vem do índice do git: no Windows o NTFS não guarda o modo do arquivo.
const appRunMode = execFileSync('git', ['ls-files', '--stage', '--', 'tools/release/appimage/AppRun'], { cwd: fileURLToPath(rootUrl), encoding: 'utf8' });
assert.ok(appRunMode.startsWith('100755 '), 'the AppRun template must be executable');
assert.match(appRun, /^#!\/bin\/sh\n/);
for (const leaked of ['PATH', 'LD_LIBRARY_PATH', 'PYTHONHOME', 'PYTHONPATH', 'PYTHONDONTWRITEBYTECODE', 'PERLLIB', 'QT_PLUGIN_PATH']) {
  assert.doesNotMatch(appRun, new RegExp(`^\\s*(export\\s+)?${leaked}=`, 'm'), `the AppRun must not set ${leaked}`);
}
assert.match(appRun, /^export GIO_MODULE_DIR="\$gio_dir"$/m, 'the bundled GLib must not load the system GIO modules');
assert.match(appRun, /^unset GIO_EXTRA_MODULES$/m);
assert.match(appRun, /^export GTK_PATH="\$gtk_dir"$/m, 'GTK modules come from the bundle only');
assert.match(appRun, /^export GDK_BACKEND="\$\{CIALAI_GDK_BACKEND:-x11\}"$/m);
assert.ok(appRun.indexOf('cd "$APPDIR/usr"') < appRun.indexOf('exec "$APPDIR/usr/bin/cialai-desktop" "$@"'), 'WebKit finds its helpers relative to $APPDIR/usr');

// O bundler ora grava os módulos sob o diretório da arquitetura, ora direto em
// usr/lib. O AppRun procura nos dois, e cada diretório que ele resolve precisa
// olhar os mesmos dois lugares que o fix-appimage exige.
for (const [, nome, arch, plain] of appRun.matchAll(/^(\w+)_dir="\$\(primeiro_que_existe "\$lib(\/[^"]+)" "\$plain(\/[^"]+)"\)"$/gm)) {
  assert.equal(arch, plain, `${nome}_dir precisa procurar o mesmo caminho nos dois layouts`);
  const alternativas = [`usr/lib/x86_64-linux-gnu${arch}`, `usr/lib${plain}`];
  assert.ok(
    APPRUN_PATHS.some((required) => alternativas.every((item, index) => required[index] === item || String(required[index] || '').startsWith(`${item}/`))),
    `fix-appimage.mjs precisa exigir ${alternativas.join(' ou ')}`,
  );
}
assert.equal([...appRun.matchAll(/primeiro_que_existe "/g)].length, 3, 'GTK, gdk-pixbuf e GIO são os três diretórios que mudam de lugar');

// Caminhos escritos direto, sem alternativa, continuam cobertos um a um.
for (const [, path] of appRun.matchAll(/"\$APPDIR(\/[^"$]+)"/g)) {
  const relative = path.slice(1);
  if (relative === 'usr' || relative.endsWith('/usr')) continue;
  assert.ok(
    APPRUN_PATHS.some((required) => required.some((item) => item === relative || item.startsWith(`${relative}/`))),
    `fix-appimage.mjs must require ${relative}`,
  );
}

// Assinatura minisign do atualizador conferida sobre o arquivo final, com um par descartável.
const updaterKeys = generateKeyPairSync('ed25519');
const rawPublic = Buffer.from(updaterKeys.publicKey.export({ format: 'jwk' }).x, 'base64url');
const keyId = Buffer.from('0123456789abcdef', 'hex');
const minisign = (lines) => Buffer.from(`${lines.join('\n')}\n`).toString('base64');
const updaterPublicKey = minisign(['untrusted comment: minisign public key: EFCDAB8967452301', Buffer.concat([Buffer.from('Ed'), keyId, rawPublic]).toString('base64')]);
const signed = Buffer.from('final AppImage');
const signedDigest = createHash('blake2b512').update(signed).digest();
const fileSignature = sign(null, signedDigest, updaterKeys.privateKey);
const trustedComment = 'timestamp:1789461340\tfile:Cialai_0.2.0_amd64.AppImage';
const updaterSignature = (signature = fileSignature, comment = trustedComment) => minisign([
  'untrusted comment: signature from tauri secret key',
  Buffer.concat([Buffer.from('ED'), keyId, signature]).toString('base64'),
  `trusted comment: ${comment}`,
  sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), updaterKeys.privateKey).toString('base64'),
]);
assert.deepEqual(verifyUpdaterSignature({ digest: signedDigest, signature: updaterSignature(), publicKey: updaterPublicKey }), { trustedComment });
const repacked = createHash('blake2b512').update(Buffer.from('linuxdeploy AppImage')).digest();
assert.throws(() => verifyUpdaterSignature({ digest: repacked, signature: updaterSignature(), publicKey: updaterPublicKey }), /does not match the file/);
assert.throws(() => verifyUpdaterSignature({ digest: signedDigest, signature: updaterSignature(fileSignature, 'file:other'), publicKey: updaterPublicKey }), /Trusted comment/);
const otherKey = minisign(['untrusted comment: minisign public key: 0000000000000000', Buffer.concat([Buffer.from('Ed'), Buffer.alloc(8), rawPublic]).toString('base64')]);
assert.throws(() => verifyUpdaterSignature({ digest: signedDigest, signature: updaterSignature(), publicKey: otherKey }), /another key/);

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
assert.equal((workflow.match(/--config src-tauri\/tauri\.release\.conf\.json/g) ?? []).length, 3, 'both tauri-action steps and the Linux build use the release config');
assert.equal((workflow.match(/uploadUpdaterJson: false/g) ?? []).length, 2, 'parallel jobs must not race on latest.json');
assert.match(workflow, /node tools\/release\/signing-mode\.mjs\n\s+--target \$\{\{ matrix\.target \}\}\n\s+--config-out apps\/desktop\/src-tauri\/tauri\.release\.conf\.json/);
assert.match(workflow, /- os: macos-14\n\s+target: aarch64-apple-darwin\n\s+- os: macos-14\n\s+target: x86_64-apple-darwin/);
assert.doesNotMatch(workflow, /macos-13/, 'macos-13 runners are retired');
const developerStep = workflow.slice(workflow.indexOf('- name: Build and upload with Developer ID'), workflow.indexOf('- name: Build and upload\n'));
const defaultStep = workflow.slice(workflow.indexOf('- name: Build and upload\n'), workflow.indexOf('- name: Build the Linux bundles'));
assert.match(developerStep, /if: steps\.signing\.outputs\.macos == 'developer-id'/);
assert.match(developerStep, /APPLE_CERTIFICATE: \$\{\{ secrets\.APPLE_CERTIFICATE \}\}/);
assert.match(developerStep, /APPLE_API_KEY: \$\{\{ secrets\.APPLE_API_KEY \}\}/);
assert.doesNotMatch(developerStep, /APPLE_ID|APPLE_PASSWORD|APPLE_API_PRIVATE_KEY/, 'Tauri must notarize with the API key file only');
const keyStep = workflow.slice(workflow.indexOf('- name: Write the notarization key'), workflow.indexOf('- name: Build and upload with Developer ID'));
assert.match(keyStep, /if: steps\.signing\.outputs\.macos == 'developer-id'/);
assert.match(keyStep, /"\$RUNNER_TEMP\/private_keys\/AuthKey_\$\{APPLE_API_KEY\}\.p8"/);
assert.match(keyStep, /echo "APPLE_API_KEY_PATH=\$key_path" >> "\$GITHUB_ENV"/);
assert.match(defaultStep, /if: steps\.signing\.outputs\.macos != 'developer-id' && runner\.os != 'Linux'\n/, 'tauri-action must not upload the unfixed AppImage');
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

// Linux: build pelo CLI, correção, nova assinatura conferida e só então o envio ao rascunho.
const linuxNames = ['- name: Build the Linux bundles', '- name: Fix the AppImage and sign it again', '- name: Upload the Linux bundles to the draft', '\n  publish:'];
const linuxStart = linuxNames.map((name) => workflow.indexOf(name));
assert.ok(linuxStart.every((index, position) => index > 0 && (position === 0 || linuxStart[position - 1] < index)), 'Linux steps run build, fix and upload in order');
const [linuxBuild, linuxFix, linuxUpload] = [0, 1, 2].map((position) => workflow.slice(linuxStart[position], linuxStart[position + 1]));
const secretsOf = (step) => [...step.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]);
for (const step of [linuxBuild, linuxFix, linuxUpload]) assert.match(step, /\n\s+if: runner\.os == 'Linux'\n/);
assert.match(linuxBuild, /working-directory: apps\/desktop\n/);
assert.match(linuxBuild, /run: npx tauri build --target \$\{\{ matrix\.target \}\} --config src-tauri\/tauri\.release\.conf\.json\n/);
assert.deepEqual(secretsOf(linuxBuild), ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'], 'the Linux build does not upload');
assert.deepEqual(secretsOf(linuxFix), ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']);
assert.match(linuxFix, /BUNDLE: apps\/desktop\/src-tauri\/target\/\$\{\{ matrix\.target \}\}\/release\/bundle\n/);
const fixOrder = ['node tools/release/fix-appimage.mjs "${appimage[0]}"', 'rm "${appimage[0]}.sig"', 'npx tauri signer sign "${appimage[0]}"', 'node tools/release/verify-updater-signature.mjs "${appimage[0]}"'];
assert.ok(fixOrder.every((command, index) => linuxFix.includes(command) && (index === 0 || linuxFix.indexOf(fixOrder[index - 1]) < linuxFix.indexOf(command))), 'the AppImage is fixed, signed again and verified in this order');
assert.deepEqual(secretsOf(linuxUpload), ['GITHUB_TOKEN']);
assert.match(linuxUpload, /run: node tools\/release\/release-assets\.mjs upload-linux "\$RELEASE_TAG" apps\/desktop\/src-tauri\/target\/\$\{\{ matrix\.target \}\}\/release\/bundle\n/);
assert.ok(workflow.indexOf('Let the AppImage bundler find the Tor libraries') < linuxStart[0], 'the Tor libraries are visible to the Linux bundler');
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
