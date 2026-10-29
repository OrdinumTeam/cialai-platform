// SPDX-License-Identifier: Apache-2.0
import{spawnSync}from'node:child_process';import{join,resolve}from'node:path';import{fileURLToPath}from'node:url';
// Git Bash also installs GNU tar, which interprets drive-letter paths as remote hosts.
export const tarExecutable=process.platform==='win32'?join(process.env.SystemRoot||process.env.SYSTEMROOT||'C:\\Windows','System32','tar.exe'):'tar';
export function archive(source,destination){const args=process.platform==='darwin'?['--no-xattrs','-cf',resolve(destination),'-C',resolve(source),'.']:['-cf',resolve(destination),'-C',resolve(source),'.'];const result=spawnSync(tarExecutable,args,{env:{...process.env,COPYFILE_DISABLE:'1'},stdio:'pipe'});if(result.status!==0)throw Error('Broto archive failed');}
if(process.argv[1]===fileURLToPath(import.meta.url)){const[source,destination]=process.argv.slice(2);if(!destination)throw Error('Source and archive required');archive(source,destination);}
