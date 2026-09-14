// SPDX-License-Identifier: Apache-2.0
// Fetches the pinned Tor Expert Bundle used by connectivity spikes.
// The SHA-256 values below come from Tor Browser's signed checksum manifest:
// https://archive.torproject.org/tor-package-archive/torbrowser/15.0.22/sha256sums-signed-build.txt
//
//   node tools/fetch-tor.mjs
//   node tools/fetch-tor.mjs --target macos-aarch64
//   node tools/fetch-tor.mjs --list

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_OUTPUT_ROOT = join(repositoryRoot, 'packages', 'tunnel-core', 'build', 'tor');

export function hostTarget(platform = process.platform, arch = process.arch) {
  const target = {
    'darwin-arm64': 'macos-aarch64',
    'darwin-x64': 'macos-x86_64',
    'linux-x64': 'linux-x86_64',
    'win32-x64': 'windows-x86_64',
  }[`${platform}-${arch}`];
  if (target) return target;
  if (platform === 'linux' && arch === 'arm64') {
    throw new Error(`Tor Expert Bundle ${TOR_BUNDLE_VERSION} has no official Linux ARM64 archive`);
  }
  throw new Error(`No Tor Expert Bundle ${TOR_BUNDLE_VERSION} for ${platform} ${arch}`);
}

export function targetSpec(target) {
  const spec = TOR_TARGETS[target];
  if (!spec) throw new Error(`Unsupported Tor target: ${target}`);
  return spec;
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

function parseArguments(argv) {
  if (argv.includes('--list')) return { list: true };
  let target;
  let outputRoot = DEFAULT_OUTPUT_ROOT;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--target') target = argv[++index];
    else if (argv[index] === '--output') outputRoot = resolve(argv[++index]);
    else if (argv[index] === '--force') force = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return { force, outputRoot, target: target ?? hostTarget() };
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

function extractTarGzip(archivePath, destination) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', destination], { stdio: 'inherit' });
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
    if (options.list) {
      console.log(JSON.stringify({ targets: TOR_TARGETS, version: TOR_BUNDLE_VERSION }, null, 2));
    } else {
      const result = await fetchTor(options);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
