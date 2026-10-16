// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('smoke selects and signals only live processes from its own fixture, not an old zombie or unrelated app', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'cialai-smoke-process-'));
  const proc = join(fixture, 'proc');
  const fixtureHome = join(fixture, 'home-current');
  const bundle = join(fixture, 'bundle');
  mkdirSync(bundle);
  const executable = join(bundle, 'cialai-desktop');
  writeFileSync(executable, 'fixture');
  const helper = fileURLToPath(new URL('../release/appimage/processes.sh', import.meta.url));
  try {
    for (const [pid, owner, live, marked] of [
      [101, fixtureHome, false, true], // An old zombie still matches pgrep.
      [202, join(fixture, 'another-user'), true, false],
      [303, fixtureHome, true, true],
      [404, fixtureHome, true, false], // HOME alone is not our ownership marker.
      [505, join(fixture, 'home-previous'), true, true],
    ]) {
      const dir = join(proc, String(pid)); mkdirSync(dir, { recursive: true });
      if (live) {
        symlinkSync(executable, join(dir, 'exe'));
        writeFileSync(join(dir, 'environ'), `HOME=${owner}\0${marked ? `CIALAI_APPIMAGE_SMOKE=${owner}\0` : ''}`);
      }
    }
    const run = (expression) => {
      const result = spawnSync('bash', ['-c', `source "$1"; shift; pgrep() { printf '%s\\n' 101 202 303 404 505; }; ${expression}`, 'fixture', helper, fixtureHome, bundle],
        { encoding: 'utf8', env: { ...process.env, SMOKE_PROC_ROOT: proc } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    assert.equal(run('smoke_find_process cialai-desktop "$2" "$1"'), '303', 'must not confuse a zombie or another fixture with the current main process');
    assert.equal(run('smoke_fixture_pids "$1"'), '303', 'the ownership marker, HOME and live executable are all required');
    assert.equal(run('kill() { printf "%s\\n" "$*"; }; smoke_signal_fixture TERM "$1"'), '-TERM 303', 'never signal unrelated applications by name');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
