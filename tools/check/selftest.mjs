// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const path = `${root}/tools/selftest/selftest-app.js`;
assert.ok(existsSync(path), 'Missing in-app selftest');
const selftest = readFileSync(path, 'utf8');
const main = readFileSync(`${root}/packages/ui/src/desktop/main.jsx`, 'utf8');
const commands = readFileSync(`${root}/apps/desktop/src-tauri/src/commands.rs`, 'utf8');
const lib = readFileSync(`${root}/apps/desktop/src-tauri/src/lib.rs`, 'utf8');
const config = JSON.parse(readFileSync(`${root}/apps/desktop/src-tauri/tauri.selftest.conf.json`, 'utf8'));

for (const contract of [
  'app_selftest_paths',
  'PTY real',
  'arquivos pelo Rust',
  'arraste entre pastas',
  'caminho no terminal',
  'editor de CSV',
  'Dev Browser',
  'preferências e shell',
  'app_request_quit',
]) assert.match(selftest, new RegExp(contract), `Missing selftest contract: ${contract}`);

assert.doesNotMatch(selftest, /\/Users\/[^/]+\/Github Projects|\.ordinum|\/tmp\/oc-selftest/);
assert.match(main, /tools\/selftest\/selftest-app\.js/);
assert.match(commands, /pub fn app_selftest_paths/);
assert.match(lib, /commands::app_selftest_paths/);
assert.match(config.build.devUrl, /cialai_selftest=1/);
assert.match(config.build.devUrl, /onboarding=skip/);

console.log('PASS selftest contract: isolated app paths, native PTY, files, drag, editor and browser');
