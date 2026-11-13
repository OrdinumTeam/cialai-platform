// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARCHIVES, INSTALLERS, siteManifest } from './site-manifest.mjs';
import { stageInstallers } from './stage-installers.mjs';

test('preview publishes only Windows and Linux installers, with signed-manifest hashes', t => {
  const dir=mkdtempSync(join(tmpdir(),'broto-release-'));t.after(()=>rmSync(dir,{recursive:true}));
  for(const name of [...ARCHIVES,...INSTALLERS])writeFileSync(join(dir,name),'fixture '+name);
  const data=siteManifest(dir,'broto-v0.1.0');
  assert.equal(data.assets.length,2);assert.equal(data.installers.length,3);
  const sums=readFileSync(join(dir,'SHA256SUMS.txt'),'utf8');
  for(const file of [...data.assets,...data.installers])assert.ok(sums.includes(`${file.sha256}  ${file.name}`));
  writeFileSync(join(dir,'CialaiBroto_macos-arm64.tar.gz'),'unexpected');
  assert.throws(()=>siteManifest(dir,'broto-v0.1.0'),/macOS/);
});
test('native bundle names become stable installer names and duplicates fail',t=>{
  const root=mkdtempSync(join(tmpdir(),'broto-installers-'));t.after(()=>rmSync(root,{recursive:true}));
  const source=join(root,'source'),dest=join(root,'output');mkdirSync(source);
  for(const name of ['CialaiBroto_0.1.0_x64-setup.exe','CialaiBroto_0.1.0_amd64.deb','CialaiBroto-0.1.0-1.x86_64.rpm'])writeFileSync(join(source,name),name);
  assert.deepEqual(stageInstallers(source,dest).sort(),[...INSTALLERS].sort());
  writeFileSync(join(source,'CialaiBroto_0.2.0_x64-setup.exe'),'duplicate');
  assert.throws(()=>stageInstallers(source,dest),/Duplicate/);
});
