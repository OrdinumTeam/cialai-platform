// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const jobs = {
  'desktop-check': {
    cwd: '.',
    commands: [
      ['node', 'tools/check/desktop-scaffold.mjs'],
      ['node', 'tools/check/desktop-icon.mjs'],
      ['node', 'tools/check/desktop-extraction.mjs'],
      ['node', 'tools/check/onboarding.mjs'],
      ['npm', 'run', 'build:ui', '--workspace', '@cialai/desktop'],
      ['cargo', 'fmt', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--check'],
      ['cargo', 'clippy', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--locked', '--all-targets', '--', '-D', 'warnings'],
      ['cargo', 'test', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--locked'],
    ],
  },
  'tunnel-check': {
    cwd: 'packages/tunnel-core',
    commands: [['go', 'vet', './...'], ['go', 'test', '-mod=readonly', './...']],
  },
  'spike-headscale': {
    cwd: 'packages/tunnel-core',
    commands: [['go', 'test', '-mod=readonly', '-tags=integration', '-count=1', '-timeout=6m', '-v', './spikes/headscale']],
  },
};

const job = jobs[process.argv[2]];
if (!job) throw new Error(`Unknown job: ${process.argv[2]}`);
for (const [command, ...args] of job.commands) {
  const result = spawnSync(command, args, { cwd: `${root}/${job.cwd}`, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
