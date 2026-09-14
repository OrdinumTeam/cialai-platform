// SPDX-License-Identifier: Apache-2.0
// Confere a tag contra a versão do app e decide se a release é prévia ou estável.
// Uso no workflow: node tools/release/release-channel.mjs v0.1.0 >> "$GITHUB_OUTPUT"
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/;

export function releaseChannel(tag, versions) {
  const match = TAG.exec(tag);
  if (!match) throw new Error(`Invalid release tag ${tag}, expected v<major>.<minor>.<patch>`);
  const tagVersion = tag.slice(1);
  for (const [source, version] of Object.entries(versions)) {
    if (version !== tagVersion) throw new Error(`Tag ${tag} does not match ${source} version ${version}`);
  }
  const major = Number(match[1]);
  return major >= 1 && match[4] === undefined ? 'stable' : 'preview';
}

export function appVersions(root) {
  const read = (path) => readFileSync(new URL(path, root), 'utf8');
  const cargo = read('apps/desktop/src-tauri/Cargo.toml').match(/^version = "([^"]+)"$/m);
  return {
    'tauri.conf.json': JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json')).version,
    'Cargo.toml': cargo?.[1],
    'apps/desktop/package.json': JSON.parse(read('apps/desktop/package.json')).version,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2] ?? '';
  const channel = releaseChannel(tag, appVersions(new URL('../../', import.meta.url)));
  console.log(`channel=${channel}`);
}
