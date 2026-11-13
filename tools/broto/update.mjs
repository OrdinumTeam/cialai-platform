// SPDX-License-Identifier: Apache-2.0
// Stage a signed update beside the current release; never overwrite a running executable.
import {readFileSync,existsSync,lstatSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {homedir} from 'node:os';
import {run} from './install.mjs';
import {service} from './service.mjs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {install,verify} from './install.mjs';
export function metadata(source){
 const m=JSON.parse(readFileSync(join(source,'release.json'),'utf8'));
 if(!/^(?:broto-v)?\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/.test(m.version||'')||!['macos-arm64','macos-x64','linux-x64','windows-x64'].includes(m.target)||m.binary!==(m.target==='windows-x64'?'cialai-broto.exe':'cialai-broto'))throw Error('Invalid signed release metadata');
 return m;
}
function parts(version){return version.replace(/^broto-v/,'').split(/[.-]/).slice(0,3).map(Number)}
export function prepare(source,current,releases,key,operations={verify,install}){
 source=resolve(source);current=resolve(current);releases=resolve(releases);
 if(lstatSync(current).isSymbolicLink())throw Error('Current release must be an immutable directory');
 // Both current and incoming metadata must be authenticated before selecting paths.
 operations.verify(current,key);operations.verify(source,key);
 const previous=metadata(current),next=metadata(source);
 if(previous.target!==next.target)throw Error('Update target mismatch');
 const a=parts(previous.version),b=parts(next.version);let greater=false;
 for(let i=0;i<3;i++){if(b[i]<a[i])throw Error('Downgrade refused');if(b[i]>a[i]){greater=true;break;}}
 if(!greater)throw Error('Update must advance the release version');
 const destination=join(releases,next.version);if(existsSync(destination))throw Error('Version already installed');
 operations.install(source,destination,key);
 return {version:next.version,target:next.target,previousBinary:join(current,previous.binary),nextBinary:join(destination,next.binary),activationRequired:true};
}
// Explicit activation is separate from staging so running binaries are never overwritten.
export function activate(update,{platform=process.platform,home=homedir(),execute=run}={}) {
 if(platform==='win32') {
  execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Stop-Service -Name CialaiBroto -ErrorAction Stop; (Get-Service CialaiBroto).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))"]);
  try { execute('sc.exe',['config','CialaiBroto','binPath=',`"${update.nextBinary}" service`]);execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Start-Service -Name CialaiBroto -ErrorAction Stop; (Get-Service CialaiBroto).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))"]); }
  catch(error){execute('sc.exe',['config','CialaiBroto','binPath=',`"${update.previousBinary}" service`]);execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Start-Service -Name CialaiBroto -ErrorAction Stop; (Get-Service CialaiBroto).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))"]);throw error;}
  return;
 }
 if(!['darwin','linux'].includes(platform))throw Error('Unsupported service platform');
 const path=platform==='darwin'?join(home,'Library','LaunchAgents','br.com.ordinum.cialai.broto.plist'):join(home,'.config','systemd','user','cialai-broto.service');
 const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid())throw Error('Unsafe service descriptor');
 const previous=readFileSync(path,'utf8');
 if(previous!==service(platform,update.previousBinary))throw Error('Service descriptor differs from expected current release');
 const temporary=path+'.broto-update';if(existsSync(temporary))throw Error('Update descriptor already exists');
 const stop=()=>platform==='darwin'?execute('launchctl',['bootout',`gui/${process.getuid()}`,path]):execute('systemctl',['--user','stop','cialai-broto.service']);
 const start=()=>{if(platform==='darwin')execute('launchctl',['bootstrap',`gui/${process.getuid()}`,path]);else{execute('systemctl',['--user','daemon-reload']);execute('systemctl',['--user','start','cialai-broto.service']);}};
 stop();
 try {writeFileSync(temporary,service(platform,update.nextBinary),{flag:'wx',mode:0o600});renameSync(temporary,path);start();}
 catch(error){if(existsSync(temporary))unlinkSync(temporary);writeFileSync(temporary,previous,{flag:'wx',mode:0o600});renameSync(temporary,path);start();throw error;}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const [source,current,releases,key,...flags]=process.argv.slice(2);if(!key)throw Error('Usage: node tools/broto/update.mjs SIGNED_PAYLOAD CURRENT_RELEASE RELEASES_DIR TRUSTED_KEY [--activate]');const update=prepare(source,current,releases,key);if(flags.includes('--activate')){activate(update);update.activationRequired=false;}process.stdout.write(JSON.stringify(update,null,2)+'\n');}
