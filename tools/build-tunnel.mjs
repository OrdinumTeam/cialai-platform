// SPDX-License-Identifier: Apache-2.0
// Builds the Go tunnel sidecar with the target-triple names expected by
// Tauri's bundle.externalBin entry `binaries/cialai-tunnel`.
//
//   node tools/build-tunnel.mjs                 all five release targets
//   node tools/build-tunnel.mjs --local         only the Rust host target, plus the host
//                                               Tor Expert Bundle staged as resources/tor
//   node tools/build-tunnel.mjs --target <t>    selected targets, repeatable
//   node tools/build-tunnel.mjs --verify --target <t>
//                                               check a downloaded binary against SHA256SUMS
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageLocalTorResource } from './fetch-tor.mjs';

export const TARGETS = Object.freeze({
  'aarch64-apple-darwin': { goos: 'darwin', goarch: 'arm64' },
  'x86_64-apple-darwin': { goos: 'darwin', goarch: 'amd64' },
  'x86_64-unknown-linux-gnu': { goos: 'linux', goarch: 'amd64' },
  'aarch64-unknown-linux-gnu': { goos: 'linux', goarch: 'arm64' },
  'x86_64-pc-windows-msvc': { goos: 'windows', goarch: 'amd64' },
});

const root = fileURLToPath(new URL('../', import.meta.url));
export const OUTPUT_DIR = `${root}apps/desktop/src-tauri/binaries`;
const CHECKSUMS = `${OUTPUT_DIR}/SHA256SUMS`;

export function binaryName(triple) {
  const target = TARGETS[triple];
  if (!target) throw new Error(`Unsupported sidecar target: ${triple}`);
  return `cialai-tunnel-${triple}${target.goos === 'windows' ? '.exe' : ''}`;
}

export function hostTriple() {
  const rustc = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  const host = rustc.status === 0 ? rustc.stdout.match(/^host: (\S+)$/m)?.[1] : undefined;
  if (host) {
    if (!TARGETS[host]) throw new Error(`The Rust host ${host} has no sidecar target`);
    return host;
  }
  const fallback = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'win32-x64': 'x86_64-pc-windows-msvc',
  }[`${process.platform}-${process.arch}`];
  if (!fallback) throw new Error(`No sidecar target for ${process.platform} ${process.arch}`);
  return fallback;
}

function parseTargets(argv) {
  if (argv.includes('--local')) return [hostTriple()];
  const selected = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--target') selected.push(argv[index + 1]);
  }
  for (const triple of selected) binaryName(triple);
  return selected.length ? selected : Object.keys(TARGETS);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function buildSidecar(triple) {
  const { goos, goarch } = TARGETS[triple];
  const output = `${OUTPUT_DIR}/${binaryName(triple)}`;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const result = spawnSync('go', ['build', '-trimpath', '-mod=readonly', '-ldflags=-s -w', '-o', output, './cmd/cialai-tunnel'], {
    cwd: `${root}packages/tunnel-core`,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`go build failed for ${triple}`);
  return { triple, output, bytes: statSync(output).size };
}

export function writeChecksums() {
  const lines = Object.keys(TARGETS)
    .map(binaryName)
    .filter((name) => existsSync(`${OUTPUT_DIR}/${name}`))
    .map((name) => `${sha256(`${OUTPUT_DIR}/${name}`)}  ${name}`);
  writeFileSync(CHECKSUMS, `${lines.join('\n')}\n`);
  return lines.length;
}

export function verifySidecar(triple) {
  const name = binaryName(triple);
  const expected = readFileSync(CHECKSUMS, 'utf8').split('\n')
    .map((line) => line.match(/^([0-9a-f]{64}) {2}(\S+)$/))
    .find((match) => match?.[2] === name)?.[1];
  if (!expected) throw new Error(`SHA256SUMS has no entry for ${name}`);
  if (sha256(`${OUTPUT_DIR}/${name}`) !== expected) throw new Error(`Checksum mismatch for ${name}`);
  return expected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const targets = parseTargets(argv);
  if (argv.includes('--verify')) {
    for (const triple of targets) console.log(`verified ${binaryName(triple)} ${verifySidecar(triple)}`);
  } else {
    for (const triple of targets) {
      const built = buildSidecar(triple);
      console.log(`built ${binaryName(triple)} ${(built.bytes / 1048576).toFixed(1)} MiB`);
    }
    console.log(`wrote SHA256SUMS with ${writeChecksums()} entries`);
    // Release jobs stage Tor per target with tools/fetch-tor.mjs --stage.
    if (argv.includes('--local')) {
      const tor = await stageLocalTorResource(targets[0]);
      console.log(tor.unavailable ? `staged no Tor for ${tor.triple}` : `staged Tor ${tor.target} with ${tor.files} files`);
    }
  }
}
