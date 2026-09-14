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
      ['node', 'tools/check/mobile-files-windows.mjs'],
      ['node', 'tools/check/onboarding.mjs'],
      ['node', 'tools/check/selftest.mjs'],
      ['node', 'tools/check/release-sidecar.mjs'],
      ['node', 'tools/release/check-updater.mjs'],
      ['node', 'tools/build-tunnel.mjs', '--local'],
      ['npm', 'run', 'build:ui', '--workspace', '@cialai/desktop'],
      ['cargo', 'fmt', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--check'],
      ['cargo', 'clippy', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--locked', '--all-targets', '--', '-D', 'warnings'],
      ['cargo', 'test', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--locked'],
    ],
  },
  'tunnel-check': {
    cwd: 'packages/tunnel-core',
    commands: [['node', '../../tools/check/headscale-infra.mjs'], ['go', 'vet', './...'], ['go', 'test', '-mod=readonly', './...']],
  },
  'integration-headscale': {
    cwd: 'packages/tunnel-core',
    commands: [
      ['go', 'vet', '-tags=integration', './integration', './testutil'],
      ['go', 'test', '-mod=readonly', '-tags=integration', '-count=1', '-timeout=12m', '-v', './integration'],
    ],
  },
  'spike-headscale': {
    cwd: 'packages/tunnel-core',
    commands: [['go', 'test', '-mod=readonly', '-tags=integration', '-count=1', '-timeout=6m', '-v', './spikes/headscale']],
  },
};

const job = jobs[process.argv[2]];
if (!job) throw new Error(`Unknown job: ${process.argv[2]}`);
for (const [command, ...args] of job.commands) {
  // No Windows o npm é um .cmd, que o Node só executa por um shell; os argumentos são fixos deste arquivo.
  const shell = process.platform === 'win32' && command === 'npm';
  const result = spawnSync(command, args, { cwd: `${root}/${job.cwd}`, stdio: 'inherit', shell });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
