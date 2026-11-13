// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verify} from './install.mjs';
import {service} from './service.mjs';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'broto-installer-'));t.after(()=>rmSync(dir,{recursive:true}));writeFileSync(join(dir,'cialai-broto'),'fixture');writeFileSync(join(dir,'SHA256SUMS.txt'),`${createHash('sha256').update('fixture').digest('hex')}  cialai-broto\n`);return dir;}
test('signature verification precedes all content checks',t=>{const dir=fixture(t);assert.throws(()=>verify(dir,'key','linux',()=>{throw Error('bad signature');}),/bad signature/);});
test('macOS requires codesign and Gatekeeper after signed sums',t=>{const dir=fixture(t),calls=[];verify(dir,'key','darwin',(cmd)=>calls.push(cmd));assert.deepEqual(calls,['minisign','codesign','spctl']);});
test('rejects tampering and additional payloads',t=>{const dir=fixture(t);writeFileSync(join(dir,'extra'),'unexpected');assert.throws(()=>verify(dir,'key','linux',()=>{}),/Checksum/);});
test('rejects traversal and symlink payloads',t=>{const dir=fixture(t);writeFileSync(join(dir,'SHA256SUMS.txt'),`${'a'.repeat(64)}  ../outside\n`);assert.throws(()=>verify(dir,'key','linux',()=>{}),/Invalid/);if(process.platform!=='win32'){symlinkSync('cialai-broto',join(dir,'link'));assert.throws(()=>verify(dir,'key','linux',()=>{}));}});
test('service templates quote paths without root privileges',()=>{assert.match(service('linux','/home/user/App Space/cialai-broto'),/ExecStart="\/home\/user\/App Space\/cialai-broto" serve/);assert.match(service('darwin','/Users/test/A&B/cialai-broto'),/A&amp;B/);assert.throws(()=>service('linux','bad\nExecStart=evil'));});
import {spawnSync} from 'node:child_process';import{readFileSync}from'node:fs';
test('real ephemeral minisign accepts signed fixture and rejects manifest tampering',t=>{if(spawnSync('minisign',['-h']).error)return t.skip('minisign is not installed');const dir=fixture(t),keyDir=mkdtempSync(join(tmpdir(),'broto-signing-'));t.after(()=>rmSync(keyDir,{recursive:true}));const secret=join(keyDir,'key'),pub=join(keyDir,'pub');const execute=(args)=>{const r=spawnSync('minisign',args,{stdio:'pipe'});assert.equal(r.status,0,'minisign fixture command failed');};execute(['-G','-W','-p',pub,'-s',secret]);const publicKey=readFileSync(pub,'utf8').trim().split('\n').at(-1);execute(['-S','-s',secret,'-m',join(dir,'SHA256SUMS.txt'),'-x',join(dir,'SHA256SUMS.txt.minisig')]);const silent=(cmd,args)=>{const r=spawnSync(cmd,args,{stdio:'pipe'});if(r.status!==0)throw Error('signature verification failed');};verify(dir,publicKey,'linux',silent);if(process.platform==='darwin')assert.throws(()=>verify(dir,publicKey,'darwin',silent),/signature verification failed/);writeFileSync(join(dir,'SHA256SUMS.txt'),`${'0'.repeat(64)}  cialai-broto\n`);assert.throws(()=>verify(dir,publicKey,'linux',silent),/signature verification failed/);});
