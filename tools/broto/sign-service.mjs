// SPDX-License-Identifier: Apache-2.0
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync,cpSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {verify} from './install.mjs';
const [source,destination]=process.argv.slice(2);const key=process.env.BROTO_MINISIGN_SECRET_KEY,pin=process.env.CIALAI_BROTO_SERVICE_PUBLIC_KEY;
if(!source||!destination||!key||!pin)throw Error('Service payload, destination, signing key and independent public pin are required');
if(existsSync(destination)&&readdirSync(destination).length)throw Error('Service resource destination must be new or empty');
// O payload do Windows traz cialai-broto.exe. Os demais conferem como Linux, sem
// codesign, porque o macOS só assina o pacote da janela depois deste passo.
function payloadPlatform(dir){return existsSync(join(resolve(dir),'cialai-broto.exe'))?'win32':'linux';}
const temp=mkdtempSync(join(process.env.RUNNER_TEMP||tmpdir(),'broto-sign-'));const secret=join(temp,'key');
function minisign(args){const r=spawnSync('go',['run','-mod=readonly','aead.dev/minisign/cmd/minisign',...args],{cwd:'packages/tunnel-core',stdio:['ignore','pipe','pipe']});if(r.status!==0)throw Error('Broto service signature operation failed');}
try{writeFileSync(secret,key,{mode:0o600});minisign(['-S','-s',secret,'-m',join(resolve(source),'SHA256SUMS.txt'),'-x',join(resolve(source),'SHA256SUMS.txt.minisig')]);verify(resolve(source),pin,payloadPlatform(source),(_cmd,args)=>minisign(args));mkdirSync(destination,{recursive:true});cpSync(source,destination,{recursive:true});}finally{rmSync(temp,{recursive:true});}
