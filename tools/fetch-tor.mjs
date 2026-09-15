// SPDX-License-Identifier: Apache-2.0
// Fetches the pinned Tor Expert Bundle and stages it as the desktop's Tauri
// resource `$RESOURCE/tor`. The SHA-256 values below come from Tor Browser's
// signed checksum manifest:
// https://archive.torproject.org/tor-package-archive/torbrowser/15.0.22/sha256sums-signed-build.txt
//
//   node tools/fetch-tor.mjs                                  host bundle into packages/tunnel-core/build/tor
//   node tools/fetch-tor.mjs --target macos-aarch64
//   node tools/fetch-tor.mjs --stage --target <tor target or Rust triple>
//                                                             fetch and copy into apps/desktop/src-tauri/resources/tor
//   node tools/fetch-tor.mjs --verify-resource --target <t>   check the staged resource against its SHA256SUMS
//   node tools/fetch-tor.mjs --sign --keychain <path> --target <t>
//                                                             Developer ID signature for the nested Mach-O files,
//                                                             identity read from APPLE_SIGNING_IDENTITY
//   node tools/fetch-tor.mjs --list

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TOR_BUNDLE_VERSION = '15.0.22';
export const TOR_ARCHIVE_BASE = `https://archive.torproject.org/tor-package-archive/torbrowser/${TOR_BUNDLE_VERSION}`;

export const TOR_TARGETS = Object.freeze({
  'macos-aarch64': Object.freeze({
    archive: `tor-expert-bundle-macos-aarch64-${TOR_BUNDLE_VERSION}.tar.gz`,
    sha256: 'e8ea3f667c83309abad34280f0f9e1cfae52843da6b8db111ca15d6221051db5',
  }),
  'macos-x86_64': Object.freeze({
    archive: `tor-expert-bundle-macos-x86_64-${TOR_BUNDLE_VERSION}.tar.gz`,
    sha256: 'be1be1cb13cd093713f02a0beade0d2471b61119011bfeb0efc08353eadf2e4e',
  }),
  'linux-x86_64': Object.freeze({
    archive: `tor-expert-bundle-linux-x86_64-${TOR_BUNDLE_VERSION}.tar.gz`,
    sha256: '08d49de27f542b8f73e2014e064d8320562b5d20019c03d4725c5a5249d97985',
  }),
  'windows-x86_64': Object.freeze({
    archive: `tor-expert-bundle-windows-x86_64-${TOR_BUNDLE_VERSION}.tar.gz`,
    sha256: '231dad6b9cb401a54c260db7046965ef04e4f72ff071b140d423fb5da281ab1e',
  }),
});

// Desktop sidecar triples, as in tools/build-tunnel.mjs. A null entry is a
// target the pinned bundle does not cover.
export const RUST_TRIPLE_TARGETS = Object.freeze({
  'aarch64-apple-darwin': 'macos-aarch64',
  'x86_64-apple-darwin': 'macos-x86_64',
  'x86_64-unknown-linux-gnu': 'linux-x86_64',
  'aarch64-unknown-linux-gnu': null,
  'x86_64-pc-windows-msvc': 'windows-x86_64',
});

// Packaging Tor for Linux ARM64 is a pending product decision: build tor from
// source, depend on the system tor or ship that target without the Tor path.
// Until then every entry point refuses or warns instead of choosing one.
export const LINUX_ARM64_UNAVAILABLE = `Tor Expert Bundle ${TOR_BUNDLE_VERSION} has no official Linux ARM64 archive; `
  + 'packaging Tor for aarch64-unknown-linux-gnu awaits a product decision: build tor, use the system tor or ship without Tor';

export class TorBundleUnavailableError extends Error {
  constructor(message = LINUX_ARM64_UNAVAILABLE) {
    super(message);
    this.name = 'TorBundleUnavailableError';
  }
}

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_OUTPUT_ROOT = join(repositoryRoot, 'packages', 'tunnel-core', 'build', 'tor');
export const DEFAULT_RESOURCE_ROOT = join(repositoryRoot, 'apps', 'desktop', 'src-tauri', 'resources', 'tor');
export const RESOURCE_MANIFEST = 'tor-bundle.json';
export const RESOURCE_CHECKSUMS = 'SHA256SUMS';
export const UNAVAILABLE_MARKER = 'UNAVAILABLE.txt';

// The desktop hosts a single-hop onion service and never configures bridges,
// so the pluggable transports, their defaults and their licenses stay out.
export const EXCLUDED_BUNDLE_PATHS = Object.freeze([
  'tor/pluggable_transports',
  'data/torrc-defaults',
  'docs/conjure.txt',
  'docs/lyrebird.txt',
]);
const BUNDLE_ROOTS = ['tor', 'data', 'docs'];

export function hostTarget(platform = process.platform, arch = process.arch) {
  const target = {
    'darwin-arm64': 'macos-aarch64',
    'darwin-x64': 'macos-x86_64',
    'linux-x64': 'linux-x86_64',
    'win32-x64': 'windows-x86_64',
  }[`${platform}-${arch}`];
  if (target) return target;
  if (platform === 'linux' && arch === 'arm64') throw new TorBundleUnavailableError();
  throw new Error(`No Tor Expert Bundle ${TOR_BUNDLE_VERSION} for ${platform} ${arch}`);
}

export function targetSpec(target) {
  const spec = TOR_TARGETS[target];
  if (!spec) throw new Error(`Unsupported Tor target: ${target}`);
  return spec;
}

// Accepts a Tor target name or a Rust target triple.
export function resolveTorTarget(name) {
  if (TOR_TARGETS[name]) return name;
  if (name === 'linux-aarch64') throw new TorBundleUnavailableError();
  if (Object.hasOwn(RUST_TRIPLE_TARGETS, name)) {
    const target = RUST_TRIPLE_TARGETS[name];
    if (!target) throw new TorBundleUnavailableError();
    return target;
  }
  throw new Error(`Unsupported Tor target: ${name}`);
}

export function torExecutableName(target) {
  return target.startsWith('windows-') ? 'tor.exe' : 'tor';
}

// Path of the executable inside a bundle or a staged resource, which keeps the
// Expert Bundle layout that internal/tor expects: tor/tor beside data/geoip.
export function resourceExecutable(target) {
  return `tor/${torExecutableName(target)}`;
}

export function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolveHash(hash.digest('hex')));
  });
}

export function findTorExecutable(root, platform = process.platform) {
  const expected = platform === 'win32' ? 'tor.exe' : 'tor';
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      if (entry.isFile() && entry.name.toLowerCase() === expected) return path;
    }
  }
  throw new Error(`Archive did not contain ${expected}`);
}

export function parseArguments(argv) {
  if (argv.includes('--list')) return { list: true };
  let target;
  let outputRoot = DEFAULT_OUTPUT_ROOT;
  let resourceRoot = DEFAULT_RESOURCE_ROOT;
  let keychain;
  let force = false;
  const modes = [];
  const value = (index) => {
    const next = argv[index];
    if (next === undefined || next.startsWith('--')) throw new Error(`${argv[index - 1]} needs a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--target') target = value(++index);
    else if (argument === '--output') outputRoot = resolve(value(++index));
    else if (argument === '--resource') resourceRoot = resolve(value(++index));
    else if (argument === '--keychain') keychain = resolve(value(++index));
    else if (argument === '--force') force = true;
    else if (['--stage', '--verify-resource', '--sign'].includes(argument)) modes.push(argument.slice(2));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (modes.length > 1) throw new Error(`Choose only one of --${modes.join(', --')}`);
  const mode = modes[0] ?? 'fetch';
  if (keychain && mode !== 'sign') throw new Error('--keychain only applies to --sign');
  return { force, keychain, mode, outputRoot, resourceRoot, target: resolveTorTarget(target ?? hostTarget()) };
}

function toPosix(path) {
  return path.split(sep).join('/');
}

function sha256Sync(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Regular files below root as sorted POSIX paths. Symbolic links are refused
// so the resource can never point outside itself.
export function listResourceFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Tor resource contains a symbolic link: ${path}`);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(toPosix(relative(root, path)));
    }
  }
  return files.sort();
}

function isCodeFile(path) {
  const name = basename(path).toLowerCase();
  return (statSync(path).mode & 0o111) !== 0 || /\.(dll|dylib|exe)$/.test(name) || /\.so(\.\d+)*$/.test(name);
}

// Installers copy the resource with its modes, and the archive ships 0600 and
// 0700 entries, so other users of a system-wide install could not read tor.
function normalizeModes(root) {
  chmodSync(root, 0o755);
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        chmodSync(path, 0o755);
        pending.push(path);
      } else if (entry.isFile()) {
        chmodSync(path, isCodeFile(path) ? 0o755 : 0o644);
      }
    }
  }
}

export function writeResourceChecksums(root) {
  const lines = listResourceFiles(root)
    .filter((path) => path !== RESOURCE_CHECKSUMS)
    .map((path) => `${sha256Sync(join(root, ...path.split('/')))}  ${path}`);
  writeFileSync(join(root, RESOURCE_CHECKSUMS), `${lines.join('\n')}\n`);
  return lines.length;
}

export function parseResourceChecksums(text) {
  const entries = new Map();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const match = line.match(/^([0-9a-f]{64}) {2}([A-Za-z0-9._\-/]+)$/);
    const path = match?.[2];
    if (!match || path.startsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error(`Invalid ${RESOURCE_CHECKSUMS} line: ${line}`);
    }
    if (entries.has(path)) throw new Error(`Duplicate ${RESOURCE_CHECKSUMS} entry: ${path}`);
    entries.set(path, match[1]);
  }
  return entries;
}

export function bundleDirectory(target, outputRoot = DEFAULT_OUTPUT_ROOT) {
  targetSpec(target);
  return join(outputRoot, target);
}

// Copies an extracted Expert Bundle into the Tauri resource directory, keeping
// its layout, and records what was copied in tor-bundle.json and SHA256SUMS.
export function stageTorResource({
  bundleRoot,
  target,
  resourceRoot = DEFAULT_RESOURCE_ROOT,
  platform = process.platform,
}) {
  const spec = targetSpec(target);
  const executable = resourceExecutable(target);
  const bundledExecutable = join(bundleRoot, ...executable.split('/'));
  if (!existsSync(bundledExecutable) || !lstatSync(bundledExecutable).isFile()) {
    throw new Error(`Tor bundle for ${target} does not contain ${executable}`);
  }
  rmSync(resourceRoot, { force: true, recursive: true });
  mkdirSync(resourceRoot, { recursive: true });
  try {
    for (const top of BUNDLE_ROOTS) {
      const source = join(bundleRoot, top);
      if (!existsSync(source)) continue;
      cpSync(source, join(resourceRoot, top), {
        dereference: true,
        recursive: true,
        filter: (path) => !EXCLUDED_BUNDLE_PATHS.includes(toPosix(relative(bundleRoot, path))),
      });
    }
    if (platform !== 'win32') normalizeModes(resourceRoot);
    const manifest = {
      archive: spec.archive,
      executable,
      sha256: spec.sha256,
      source: `${TOR_ARCHIVE_BASE}/${spec.archive}`,
      target,
      version: TOR_BUNDLE_VERSION,
    };
    writeFileSync(join(resourceRoot, RESOURCE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    if (platform !== 'win32') chmodSync(join(resourceRoot, RESOURCE_MANIFEST), 0o644);
    const files = writeResourceChecksums(resourceRoot);
    if (platform !== 'win32') chmodSync(join(resourceRoot, RESOURCE_CHECKSUMS), 0o644);
    return { executable: join(resourceRoot, ...executable.split('/')), files, resourceRoot, target };
  } catch (error) {
    rmSync(resourceRoot, { force: true, recursive: true });
    throw error;
  }
}

// Confirms that the staged resource is the pinned bundle for target and that
// every file still matches SHA256SUMS, with nothing missing or added.
export function verifyTorResource({ resourceRoot = DEFAULT_RESOURCE_ROOT, target }) {
  const spec = targetSpec(target);
  const manifestPath = join(resourceRoot, RESOURCE_MANIFEST);
  if (!existsSync(manifestPath)) {
    const reason = existsSync(join(resourceRoot, UNAVAILABLE_MARKER)) ? ', the resource was staged without Tor' : '';
    throw new Error(`Tor resource at ${resourceRoot} has no ${RESOURCE_MANIFEST}${reason}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.target !== target) throw new Error(`Tor resource was staged for ${manifest.target}, not ${target}`);
  if (manifest.version !== TOR_BUNDLE_VERSION || manifest.sha256 !== spec.sha256 || manifest.archive !== spec.archive) {
    throw new Error(`Tor resource does not come from the pinned ${spec.archive}`);
  }
  if (manifest.executable !== resourceExecutable(target)) {
    throw new Error(`Tor resource names ${manifest.executable} instead of ${resourceExecutable(target)}`);
  }
  const expected = parseResourceChecksums(readFileSync(join(resourceRoot, RESOURCE_CHECKSUMS), 'utf8'));
  const actual = listResourceFiles(resourceRoot).filter((path) => path !== RESOURCE_CHECKSUMS);
  const missing = [...expected.keys()].filter((path) => !actual.includes(path));
  const unexpected = actual.filter((path) => !expected.has(path));
  if (missing.length > 0) throw new Error(`Tor resource is missing ${missing.join(', ')}`);
  if (unexpected.length > 0) throw new Error(`Tor resource has files outside ${RESOURCE_CHECKSUMS}: ${unexpected.join(', ')}`);
  for (const required of [RESOURCE_MANIFEST, manifest.executable]) {
    if (!expected.has(required)) throw new Error(`${RESOURCE_CHECKSUMS} does not cover ${required}`);
  }
  for (const [path, hash] of expected) {
    if (sha256Sync(join(resourceRoot, ...path.split('/'))) !== hash) throw new Error(`Checksum mismatch for tor resource ${path}`);
  }
  return { files: expected.size, target };
}

// A development build for a target without a bundle still needs the resource
// directory that tauri.conf.json names; the marker explains why tor is absent.
export function stageUnavailableResource({ resourceRoot = DEFAULT_RESOURCE_ROOT, triple, reason }) {
  rmSync(resourceRoot, { force: true, recursive: true });
  mkdirSync(resourceRoot, { recursive: true });
  writeFileSync(join(resourceRoot, UNAVAILABLE_MARKER), `No Tor for ${triple}.\n${reason}\n`);
  return { resourceRoot, triple, unavailable: true };
}

// Stages the host bundle for `tools/build-tunnel.mjs --local`. A target
// without a bundle warns and builds without Tor; it never picks a substitute.
export async function stageLocalTorResource(triple, {
  outputRoot = DEFAULT_OUTPUT_ROOT,
  resourceRoot = DEFAULT_RESOURCE_ROOT,
  fetch: fetchBundle = fetchTor,
  warn = console.warn,
} = {}) {
  let target;
  try {
    target = resolveTorTarget(triple);
  } catch (error) {
    if (!(error instanceof TorBundleUnavailableError)) throw error;
    warn(`WARNING: ${error.message}. This local desktop build for ${triple} has no Tor.`);
    return stageUnavailableResource({ resourceRoot, triple, reason: error.message });
  }
  await fetchBundle({ outputRoot, target });
  const staged = stageTorResource({ bundleRoot: bundleDirectory(target, outputRoot), target, resourceRoot });
  verifyTorResource({ resourceRoot, target });
  return staged;
}

const MACH_O_MAGICS = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca']);

export function isMachO(path) {
  const header = Buffer.alloc(4);
  const descriptor = openSync(path, 'r');
  try {
    if (readSync(descriptor, header, 0, 4, 0) < 4) return false;
  } finally {
    closeSync(descriptor);
  }
  return MACH_O_MAGICS.has(header.toString('hex'));
}

// Signs every nested Mach-O file of the staged macOS resource with the
// Developer ID, hardened runtime and a secure timestamp, as notarization
// requires. Tauri signs its external binaries but not resources. SHA256SUMS
// is rewritten because the signatures change the files.
export function signTorResource({
  resourceRoot = DEFAULT_RESOURCE_ROOT,
  target,
  identity,
  keychain,
  run = spawnSync,
}) {
  if (!target.startsWith('macos-')) throw new Error(`Developer ID signing only applies to macOS targets, not ${target}`);
  if (!identity) throw new Error('APPLE_SIGNING_IDENTITY is required to sign the Tor resource');
  verifyTorResource({ resourceRoot, target });
  const codeObjects = listResourceFiles(resourceRoot)
    .map((path) => join(resourceRoot, ...path.split('/')))
    .filter(isMachO)
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  if (codeObjects.length === 0) throw new Error('Tor resource has no Mach-O file to sign');
  const invoke = (args) => {
    const result = run('codesign', args, { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`codesign ${args[0]} failed for ${args.at(-1)}: ${String(result.stderr ?? '').trim()}`);
  };
  for (const path of codeObjects) {
    const args = ['--force', '--options', 'runtime', '--timestamp', '--sign', identity];
    if (keychain) args.push('--keychain', keychain);
    invoke([...args, path]);
  }
  for (const path of codeObjects) invoke(['--verify', '--strict', '--verbose=2', path]);
  writeResourceChecksums(resourceRoot);
  verifyTorResource({ resourceRoot, target });
  return { signed: codeObjects.map((path) => toPosix(relative(resourceRoot, path))) };
}

function readInstalled(markerPath, expectedHash) {
  if (!existsSync(markerPath)) return undefined;
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (marker.sha256 !== expectedHash || !existsSync(marker.torPath)) return undefined;
    return marker;
  } catch {
    return undefined;
  }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { mode: 0o600 }));
}

// On Windows the system bsdtar is used explicitly: a GNU tar from Git for
// Windows earlier in PATH reads `D:\...` as a remote host.
export function tarCommand(platform = process.platform, env = process.env) {
  return platform === 'win32' ? `${env.SystemRoot ?? 'C:\\Windows'}\\System32\\tar.exe` : 'tar';
}

function extractTarGzip(archivePath, destination) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const result = spawnSync(tarCommand(), ['-xzf', archivePath, '-C', destination], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tar failed with status ${result.status}`);
}

function adHocSignMacBundle(root) {
  const codeObjects = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      if (entry.isFile() && (entry.name.endsWith('.dylib') || (statSync(path).mode & 0o111) !== 0)) {
        codeObjects.push(path);
      }
    }
  }
  for (const path of codeObjects.sort((left, right) => right.length - left.length)) {
    const result = spawnSync('codesign', ['--force', '--sign', '-', path], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`ad-hoc codesign failed for ${path}: ${result.stderr.trim()}`);
  }
  return codeObjects.length;
}

export async function fetchTor({ force = false, outputRoot = DEFAULT_OUTPUT_ROOT, target = hostTarget() } = {}) {
  const spec = targetSpec(target);
  const targetDirectory = join(outputRoot, target);
  const markerPath = join(targetDirectory, '.cialai-tor-bundle.json');
  const installed = !force && readInstalled(markerPath, spec.sha256);
  if (installed) return { ...installed, reused: true };

  const downloads = join(outputRoot, 'downloads');
  const archivePath = join(downloads, spec.archive);
  const staging = join(outputRoot, `.staging-${target}-${process.pid}-${Date.now()}`);
  const source = `${TOR_ARCHIVE_BASE}/${spec.archive}`;
  mkdirSync(downloads, { recursive: true, mode: 0o700 });

  try {
    let actual = existsSync(archivePath) ? await sha256File(archivePath) : undefined;
    if (force || actual !== spec.sha256) {
      rmSync(archivePath, { force: true });
      const partial = `${archivePath}.partial-${process.pid}`;
      rmSync(partial, { force: true });
      try {
        await download(source, partial);
        actual = await sha256File(partial);
        if (actual !== spec.sha256) {
          throw new Error(`SHA-256 mismatch for ${spec.archive}: expected ${spec.sha256}, got ${actual}`);
        }
        renameSync(partial, archivePath);
      } finally {
        rmSync(partial, { force: true });
      }
    }
    if (actual !== spec.sha256) {
      throw new Error(`SHA-256 mismatch for ${spec.archive}: expected ${spec.sha256}, got ${actual}`);
    }

    extractTarGzip(archivePath, staging);
    const stagedTor = findTorExecutable(staging, target.startsWith('windows-') ? 'win32' : 'unix');
    if (!target.startsWith('windows-')) chmodSync(stagedTor, 0o755);
    const adHocSignedFiles = process.platform === 'darwin' && target.startsWith('macos-')
      ? adHocSignMacBundle(staging)
      : 0;
    const relativeTorPath = stagedTor.slice(staging.length + 1);
    const marker = {
      archive: spec.archive,
      archivePath,
      adHocSignedFiles,
      installedAt: new Date().toISOString(),
      sha256: spec.sha256,
      source,
      target,
      torPath: join(targetDirectory, relativeTorPath),
      version: TOR_BUNDLE_VERSION,
    };
    writeFileSync(join(staging, basename(markerPath)), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    rmSync(targetDirectory, { force: true, recursive: true });
    mkdirSync(dirname(targetDirectory), { recursive: true });
    renameSync(staging, targetDirectory);
    return { ...marker, bytes: statSync(archivePath).size, reused: false };
  } catch (error) {
    rmSync(staging, { force: true, recursive: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    let result;
    if (options.list) {
      result = { targets: TOR_TARGETS, triples: RUST_TRIPLE_TARGETS, version: TOR_BUNDLE_VERSION };
    } else if (options.mode === 'stage') {
      await fetchTor(options);
      result = stageTorResource({ ...options, bundleRoot: bundleDirectory(options.target, options.outputRoot) });
      verifyTorResource(options);
    } else if (options.mode === 'verify-resource') {
      result = verifyTorResource(options);
    } else if (options.mode === 'sign') {
      result = signTorResource({ ...options, identity: process.env.APPLE_SIGNING_IDENTITY });
    } else {
      result = await fetchTor(options);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
