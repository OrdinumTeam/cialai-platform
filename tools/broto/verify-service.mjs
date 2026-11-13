// SPDX-License-Identifier: Apache-2.0
import {spawnSync}from'node:child_process';import{resolve}from'node:path';import{existsSync,statSync}from'node:fs';import{verify}from'./install.mjs';
const [payload,pin]=process.argv.slice(2);if(!payload||!pin)throw Error('Payload and independent public pin required');
const windows=existsSync(resolve(payload,'cialai-broto.exe'));
verify(resolve(payload),pin,windows?'win32':'linux',(_command,args)=>{const result=spawnSync('go',['run','-mod=readonly','aead.dev/minisign/cmd/minisign',...args],{cwd:'packages/tunnel-core',stdio:'pipe'});if(result.status!==0)throw Error('Embedded service signature verification failed');});
if(!windows&&process.platform!=='win32'&&(statSync(resolve(payload,'cialai-broto')).mode&0o100)===0)throw Error('Embedded service is not executable');
