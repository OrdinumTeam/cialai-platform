// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARCHIVES = ['CialaiBroto_linux-x64.tar.gz', 'CialaiBroto_windows-x64.tar.gz'];
export const INSTALLERS = ['CialaiBroto_x64-setup.exe', 'CialaiBroto_amd64.deb', 'CialaiBroto_x86_64.rpm'];

export function siteManifest(dir, tag) {
  if (!/^broto-v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(tag || '')) throw Error('Broto tag required');
  const files = readdirSync(dir);
  for (const name of [...ARCHIVES, ...INSTALLERS]) if (!files.includes(name)) throw Error(`Missing Broto release file: ${name}`);
  if (files.some(name => /CialaiBroto_macos|\.dmg$/.test(name))) throw Error('macOS is not part of this Broto preview');
  const asset = name => ({
    name, url: `https://cialai.com.br/downloads/broto/${name}`,
    bytes: statSync(join(dir, name)).size,
    sha256: createHash('sha256').update(readFileSync(join(dir, name))).digest('hex'),
  });
  const result = { tag, assets: ARCHIVES.map(asset), installers: INSTALLERS.map(asset), checksum: 'SHA256SUMS.txt', signature: 'SHA256SUMS.txt.minisig' };
  writeFileSync(join(dir, 'latest.json'), JSON.stringify(result, null, 2) + '\n');
  const signedFiles = files.filter(name => [...ARCHIVES, ...INSTALLERS, 'minisign.pub'].includes(name) || /^CialaiBroto_(linux-x64|windows-x64)\.sbom\.cdx\.json$/.test(name)).sort();
  writeFileSync(join(dir, 'SHA256SUMS.txt'), signedFiles.map(name => `${asset(name).sha256}  ${name}`).join('\n') + '\n');
  return result;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) siteManifest(...process.argv.slice(2));
