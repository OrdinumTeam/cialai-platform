// SPDX-License-Identifier: Apache-2.0
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function stageInstallers(source, destination) {
  const patterns = [
    [/^CialaiBroto_.+_x64-setup\.exe$/, 'CialaiBroto_x64-setup.exe'],
    [/^CialaiBroto_.+_amd64\.deb$/, 'CialaiBroto_amd64.deb'],
    [/^CialaiBroto-.+\.x86_64\.rpm$|^CialaiBroto_.+_x86_64\.rpm$/, 'CialaiBroto_x86_64.rpm'],
  ];
  mkdirSync(destination, { recursive: true });
  const seen = new Set();
  for (const name of readdirSync(source)) {
    const target = patterns.find(([pattern]) => pattern.test(name))?.[1];
    if (!target) continue;
    if (seen.has(target)) throw Error('Duplicate Broto installer format');
    seen.add(target);
    copyFileSync(join(source, name), join(destination, target));
  }
  if (!seen.size) throw Error('No supported Broto installers found');
  return [...seen];
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, destination] = process.argv.slice(2);
  if (!destination) throw Error('Source and destination required');
  stageInstallers(source, destination);
}
