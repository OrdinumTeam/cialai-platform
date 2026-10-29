// SPDX-License-Identifier: Apache-2.0
// Offline installer. The trusted public key must come from a separate channel.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, mkdirSync, cpSync, existsSync, chmodSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
export function run(command,args) {
  const r=spawnSync(command,args,{stdio:'inherit'}); if(r.status !== 0) throw new Error(`${command} verification failed`);
}
export function verify(dir, publicKey, platform=process.platform, execute=run) {
  execute('minisign',['-Vm',join(dir,'SHA256SUMS.txt'),'-P',publicKey,'-x',join(dir,'SHA256SUMS.txt.minisig')]);
  const entries=new Map();
  for(const line of readFileSync(join(dir,'SHA256SUMS.txt'),'utf8').trim().split('\n')) {
    const m=line.match(/^([a-f0-9]{64})  ([A-Za-z0-9_./-]+)$/);
    if(!m || m[2].split('/').includes('..') || m[2].startsWith('/') || entries.has(m[2])) throw new Error('Invalid checksum manifest');
    entries.set(m[2],m[1]);
  }
  function walk(path) { for(const name of readdirSync(path)) {
    const file=join(path,name),stat=lstatSync(file),rel=relative(dir,file).split(sep).join('/');
    if(stat.isSymbolicLink()) throw new Error('Symlinks are forbidden');
    if(stat.isDirectory()) {walk(file);continue;}
    if(['SHA256SUMS.txt','SHA256SUMS.txt.minisig'].includes(rel)) continue;
    if(!stat.isFile() || entries.get(rel)!==createHash('sha256').update(readFileSync(file)).digest('hex')) throw new Error(`Checksum mismatch: ${rel}`);
    entries.delete(rel);
  }} walk(dir);
  if(entries.size) throw new Error('Manifest file missing');
  const binary=join(dir, platform==='win32'?'cialai-broto.exe':'cialai-broto');
  if(!existsSync(binary)) throw new Error('Missing binary');
  if(platform==='darwin') {execute('codesign',['--verify','--deep','--strict','--verbose=2',binary]); execute('spctl',['--assess','--type','execute',binary]);}
}
export function install(source,destination,key) {
  source=resolve(source); destination=resolve(destination);
  if(existsSync(destination)) throw new Error('Destination exists; stop service and use a new version directory');
  verify(source,key); mkdirSync(destination,{recursive:true,mode:0o700}); cpSync(source,destination,{recursive:true});
  if(process.platform!=='win32') chmodSync(join(destination,'cialai-broto'),0o700);
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {const [source,dest,key]=process.argv.slice(2);if(!key)throw new Error('Usage: node tools/broto/install.mjs SOURCE NEW_DEST TRUSTED_PUBLIC_KEY');install(source,dest,key);}
