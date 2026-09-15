// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  RESOURCE_CHECKSUMS,
  RESOURCE_MANIFEST,
  RUST_TRIPLE_TARGETS,
  TOR_BUNDLE_VERSION,
  TOR_TARGETS,
  TorBundleUnavailableError,
  UNAVAILABLE_MARKER,
  bundleDirectory,
  findTorExecutable,
  hostTarget,
  isMachO,
  listResourceFiles,
  parseArguments,
  parseResourceChecksums,
  resolveTorTarget,
  sha256File,
  signTorResource,
  stageLocalTorResource,
  stageTorResource,
  tarCommand,
  targetSpec,
  verifyTorResource,
} from './fetch-tor.mjs';

const MACH_O = Buffer.from('cffaedfe0c000001', 'hex');

async function temporaryRoot(context) {
  const root = await mkdtemp(join(tmpdir(), 'cialai-fetch-tor-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

function write(root, path, contents, mode) {
  const file = join(root, ...path.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  if (mode !== undefined) chmodSync(file, mode);
  return file;
}

// The layout of the extracted Expert Bundle, with the archive's own modes.
function macBundle(root) {
  write(root, 'tor/tor', Buffer.concat([MACH_O, Buffer.from('tor')]), 0o700);
  write(root, 'tor/libevent-2.1.7.dylib', Buffer.concat([MACH_O, Buffer.from('libevent')]), 0o700);
  write(root, 'tor/pluggable_transports/lyrebird', Buffer.concat([MACH_O, Buffer.from('lyrebird')]), 0o700);
  write(root, 'tor/pluggable_transports/pt_config.json', '{}', 0o600);
  write(root, 'data/geoip', 'geoip', 0o600);
  write(root, 'data/geoip6', 'geoip6', 0o600);
  write(root, 'data/torrc-defaults', 'ClientTransportPlugin', 0o600);
  for (const name of ['tor', 'libevent', 'openssl', 'lyrebird', 'conjure']) write(root, `docs/${name}.txt`, `${name} license`, 0o600);
  return root;
}

const STAGED_MAC_FILES = [
  RESOURCE_CHECKSUMS,
  'data/geoip',
  'data/geoip6',
  'docs/libevent.txt',
  'docs/openssl.txt',
  'docs/tor.txt',
  'tor/libevent-2.1.7.dylib',
  'tor/tor',
  RESOURCE_MANIFEST,
].sort();

test('manifest pins every published desktop target used by the spike', () => {
  assert.equal(TOR_BUNDLE_VERSION, '15.0.22');
  assert.deepEqual(Object.keys(TOR_TARGETS), [
    'macos-aarch64',
    'macos-x86_64',
    'linux-x86_64',
    'windows-x86_64',
  ]);
  for (const spec of Object.values(TOR_TARGETS)) {
    assert.match(spec.archive, /15\.0\.22\.tar\.gz$/);
    assert.match(spec.sha256, /^[0-9a-f]{64}$/);
  }
});

test('host target mapping rejects the unpublished Linux ARM64 bundle', () => {
  assert.equal(hostTarget('darwin', 'arm64'), 'macos-aarch64');
  assert.equal(hostTarget('darwin', 'x64'), 'macos-x86_64');
  assert.equal(hostTarget('linux', 'x64'), 'linux-x86_64');
  assert.equal(hostTarget('win32', 'x64'), 'windows-x86_64');
  assert.throws(() => hostTarget('linux', 'arm64'), /no official Linux ARM64 archive/);
  assert.throws(() => hostTarget('linux', 'arm64'), TorBundleUnavailableError);
  assert.throws(() => targetSpec('plan9-mips'), /Unsupported Tor target/);
});

test('every desktop sidecar triple maps to a bundle or to the pending Linux ARM64 decision', async () => {
  const { TARGETS } = await import('./build-tunnel.mjs');
  assert.deepEqual(Object.keys(RUST_TRIPLE_TARGETS), Object.keys(TARGETS));
  assert.equal(resolveTorTarget('aarch64-apple-darwin'), 'macos-aarch64');
  assert.equal(resolveTorTarget('x86_64-apple-darwin'), 'macos-x86_64');
  assert.equal(resolveTorTarget('x86_64-unknown-linux-gnu'), 'linux-x86_64');
  assert.equal(resolveTorTarget('x86_64-pc-windows-msvc'), 'windows-x86_64');
  assert.equal(resolveTorTarget('windows-x86_64'), 'windows-x86_64');
  for (const name of ['aarch64-unknown-linux-gnu', 'linux-aarch64']) {
    assert.throws(() => resolveTorTarget(name), (error) => error instanceof TorBundleUnavailableError
      && /awaits a product decision/.test(error.message));
  }
  assert.throws(() => resolveTorTarget('riscv64gc-unknown-linux-gnu'), /Unsupported Tor target/);
});

test('command line modes resolve triples and refuse ambiguous or unavailable requests', () => {
  const staged = parseArguments(['--stage', '--target', 'x86_64-pc-windows-msvc']);
  assert.equal(staged.mode, 'stage');
  assert.equal(staged.target, 'windows-x86_64');
  assert.equal(parseArguments(['--target', 'macos-x86_64']).mode, 'fetch');
  const signing = parseArguments(['--sign', '--keychain', 'build.keychain', '--target', 'aarch64-apple-darwin']);
  assert.equal(signing.mode, 'sign');
  assert.match(signing.keychain, /build\.keychain$/);
  assert.throws(() => parseArguments(['--stage', '--sign', '--target', 'macos-aarch64']), /Choose only one/);
  assert.throws(() => parseArguments(['--stage', '--keychain', 'x', '--target', 'macos-aarch64']), /--keychain only applies/);
  assert.throws(() => parseArguments(['--stage', '--target']), /needs a value/);
  assert.throws(() => parseArguments(['--stage', '--target', 'aarch64-unknown-linux-gnu']), TorBundleUnavailableError);
  assert.throws(() => parseArguments(['--unknown']), /Unknown argument/);
});

test('hashing and executable discovery inspect extracted contents', async (context) => {
  const root = await temporaryRoot(context);
  const bin = join(root, 'tor', 'bin');
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, 'tor');
  writeFileSync(executable, 'tor fixture');
  assert.equal(findTorExecutable(root, 'darwin'), executable);
  assert.equal(await sha256File(executable), '52f9c98c566ce851c207b2fbce28743a71b87bacbe4b2f61d07b4dddf0c8690c');
});

test('staging keeps tor, its libraries, GeoIP and licenses without pluggable transports', async (context) => {
  const root = await temporaryRoot(context);
  const bundle = macBundle(join(root, 'bundle'));
  const resource = join(root, 'resources', 'tor');
  write(resource, 'stale/file', 'from a previous target');

  const staged = stageTorResource({ bundleRoot: bundle, target: 'macos-aarch64', resourceRoot: resource });
  assert.equal(staged.executable, join(resource, 'tor', 'tor'));
  assert.deepEqual(listResourceFiles(resource), STAGED_MAC_FILES);
  assert.equal(staged.files, STAGED_MAC_FILES.length - 1);

  const manifest = JSON.parse(readFileSync(join(resource, RESOURCE_MANIFEST), 'utf8'));
  assert.deepEqual(manifest, {
    archive: TOR_TARGETS['macos-aarch64'].archive,
    executable: 'tor/tor',
    sha256: TOR_TARGETS['macos-aarch64'].sha256,
    source: `https://archive.torproject.org/tor-package-archive/torbrowser/15.0.22/${TOR_TARGETS['macos-aarch64'].archive}`,
    target: 'macos-aarch64',
    version: '15.0.22',
  });
  const sums = parseResourceChecksums(readFileSync(join(resource, RESOURCE_CHECKSUMS), 'utf8'));
  assert.deepEqual([...sums.keys()], STAGED_MAC_FILES.filter((path) => path !== RESOURCE_CHECKSUMS));
  assert.deepEqual(verifyTorResource({ resourceRoot: resource, target: 'macos-aarch64' }), { files: 8, target: 'macos-aarch64' });

  if (process.platform !== 'win32') {
    const mode = (path) => statSync(join(resource, ...path.split('/'))).mode & 0o777;
    assert.equal(mode('tor/tor'), 0o755);
    assert.equal(mode('tor/libevent-2.1.7.dylib'), 0o755);
    assert.equal(mode('data/geoip'), 0o644);
    assert.equal(mode('docs/tor.txt'), 0o644);
    assert.equal(mode('tor'), 0o755);
    assert.equal(mode(RESOURCE_CHECKSUMS), 0o644);
  }
});

test('verification rejects tampered, missing, extra and foreign resources', async (context) => {
  const root = await temporaryRoot(context);
  const bundle = macBundle(join(root, 'bundle'));
  const resource = join(root, 'resource');
  const fresh = () => stageTorResource({ bundleRoot: bundle, target: 'macos-aarch64', resourceRoot: resource });
  const verify = (target = 'macos-aarch64') => verifyTorResource({ resourceRoot: resource, target });

  fresh();
  appendFileSync(join(resource, 'data', 'geoip'), 'changed');
  assert.throws(() => verify(), /Checksum mismatch for tor resource data\/geoip/);

  fresh();
  rmSync(join(resource, 'tor', 'libevent-2.1.7.dylib'));
  assert.throws(() => verify(), /missing tor\/libevent-2\.1\.7\.dylib/);

  fresh();
  write(resource, 'tor/pluggable_transports/lyrebird', 'late copy');
  assert.throws(() => verify(), /outside SHA256SUMS: tor\/pluggable_transports\/lyrebird/);

  fresh();
  assert.throws(() => verify('macos-x86_64'), /staged for macos-aarch64, not macos-x86_64/);

  assert.throws(() => parseResourceChecksums(`${'a'.repeat(64)}  ../escape\n`), /Invalid SHA256SUMS line/);
  assert.throws(() => parseResourceChecksums(`${'a'.repeat(64)}  tor/tor\n${'b'.repeat(64)}  tor/tor\n`), /Duplicate/);
});

test('the Windows bundle stages tor.exe and refuses a bundle without the executable', async (context) => {
  const root = await temporaryRoot(context);
  const bundle = join(root, 'bundle');
  write(bundle, 'tor/tor.exe', 'MZ tor');
  write(bundle, 'tor/libcrypto-3-x64.dll', 'MZ crypto');
  write(bundle, 'data/geoip', 'geoip');
  const resource = join(root, 'resource');
  const staged = stageTorResource({ bundleRoot: bundle, target: 'windows-x86_64', resourceRoot: resource, platform: 'win32' });
  assert.equal(staged.executable, join(resource, 'tor', 'tor.exe'));
  assert.equal(verifyTorResource({ resourceRoot: resource, target: 'windows-x86_64' }).files, 4);

  assert.throws(
    () => stageTorResource({ bundleRoot: bundle, target: 'linux-x86_64', resourceRoot: resource }),
    /does not contain tor\/tor/,
  );
  assert.equal(tarCommand('win32', { SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\tar.exe');
  assert.equal(tarCommand('linux', {}), 'tar');
});

test('local builds stage the host bundle and warn explicitly on Linux ARM64', async (context) => {
  const root = await temporaryRoot(context);
  const outputRoot = join(root, 'build');
  const resourceRoot = join(root, 'resource');
  const fetched = [];
  macBundle(bundleDirectory('macos-x86_64', outputRoot));
  const staged = await stageLocalTorResource('x86_64-apple-darwin', {
    outputRoot,
    resourceRoot,
    fetch: async (options) => fetched.push(options),
    warn: () => assert.fail('an available target must not warn'),
  });
  assert.deepEqual(fetched, [{ outputRoot, target: 'macos-x86_64' }]);
  assert.equal(staged.target, 'macos-x86_64');
  assert.ok(existsSync(join(resourceRoot, 'tor', 'tor')));

  const warnings = [];
  const unavailable = await stageLocalTorResource('aarch64-unknown-linux-gnu', {
    outputRoot,
    resourceRoot,
    fetch: () => assert.fail('no bundle may be downloaded for Linux ARM64'),
    warn: (message) => warnings.push(message),
  });
  assert.equal(unavailable.unavailable, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^WARNING: .*awaits a product decision.*has no Tor\.$/);
  assert.deepEqual(listResourceFiles(resourceRoot), [UNAVAILABLE_MARKER]);
  assert.throws(() => verifyTorResource({ resourceRoot, target: 'linux-x86_64' }), /staged without Tor/);
});

test('Developer ID signing covers every nested Mach-O file and refreshes SHA256SUMS', async (context) => {
  const root = await temporaryRoot(context);
  const bundle = macBundle(join(root, 'bundle'));
  const resourceRoot = join(root, 'resource');
  stageTorResource({ bundleRoot: bundle, target: 'macos-aarch64', resourceRoot });
  assert.equal(isMachO(join(resourceRoot, 'tor', 'tor')), true);
  assert.equal(isMachO(join(resourceRoot, 'data', 'geoip')), false);

  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === '--force') appendFileSync(args.at(-1), 'signature');
    return { status: 0, stdout: '', stderr: '' };
  };
  const identity = 'Developer ID Application: Fixture';
  const result = signTorResource({ resourceRoot, target: 'macos-aarch64', identity, keychain: '/tmp/fixture.keychain', run });
  assert.deepEqual(result.signed, ['tor/libevent-2.1.7.dylib', 'tor/tor']);
  const signing = calls.filter((call) => call[1] === '--force');
  assert.equal(signing.length, 2);
  for (const call of signing) {
    assert.deepEqual(call.slice(0, 10), [
      'codesign', '--force', '--options', 'runtime', '--timestamp', '--sign', identity, '--keychain', '/tmp/fixture.keychain', call[9],
    ]);
  }
  assert.equal(calls.filter((call) => call[1] === '--verify').length, 2);
  assert.doesNotThrow(() => verifyTorResource({ resourceRoot, target: 'macos-aarch64' }));

  assert.throws(() => signTorResource({ resourceRoot, target: 'macos-aarch64', identity: '', run }), /APPLE_SIGNING_IDENTITY/);
  assert.throws(() => signTorResource({ resourceRoot, target: 'windows-x86_64', identity, run }), /only applies to macOS/);
  assert.throws(
    () => signTorResource({ resourceRoot, target: 'macos-aarch64', identity, run: () => ({ status: 1, stderr: 'no identity found' }) }),
    /codesign --force failed .*no identity found/,
  );
});
