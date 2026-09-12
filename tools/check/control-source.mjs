// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = resolve(process.argv[2] ?? `${root}/../ordinum-control`);
const manifest = JSON.parse(readFileSync(`${root}/docs/evidence/control-source.json`, 'utf8'));
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' });
if (revision.status !== 0) throw new Error('Cannot read the Control repository');
let changed = false;
if (revision.stdout.trim() !== manifest.baseCommit) {
  console.error('Control HEAD changed. Review provenance before extraction.');
  changed = true;
}
for (const file of manifest.files) {
  const digest = createHash('sha256').update(readFileSync(resolve(source, file.path))).digest('hex');
  if (digest !== file.sha256) {
    console.error(`Changed since inventory: ${file.path}`);
    changed = true;
  }
}
if (changed) process.exitCode = 1;
else console.log(`PASS source inventory: ${manifest.files.length} modified files match the recorded working tree`);
