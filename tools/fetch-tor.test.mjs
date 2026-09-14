// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  TOR_BUNDLE_VERSION,
  TOR_TARGETS,
  findTorExecutable,
  hostTarget,
  sha256File,
  targetSpec,
} from './fetch-tor.mjs';

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
  assert.throws(() => targetSpec('plan9-mips'), /Unsupported Tor target/);
});

test('hashing and executable discovery inspect extracted contents', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'cialai-fetch-tor-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  const bin = join(root, 'tor', 'bin');
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, 'tor');
  writeFileSync(executable, 'tor fixture');
  assert.equal(findTorExecutable(root, 'darwin'), executable);
  assert.equal(await sha256File(executable), '52f9c98c566ce851c207b2fbce28743a71b87bacbe4b2f61d07b4dddf0c8690c');
});
