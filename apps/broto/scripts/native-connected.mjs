// SPDX-License-Identifier: Apache-2.0
// Opt-in native monitor lab with real edge, hub and daemon, no production data.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const daemonBinary=process.env.CIALAI_BROTO_SELFTEST_DAEMON;
const monitorBinary=process.env.CIALAI_BROTO_SELFTEST_MONITOR;
if(!daemonBinary||!monitorBinary)throw Error('Built daemon and selftest monitor paths are required');
const profile=await mkdtemp('/tmp/bnc-');
const host=join(profile,'host');await mkdir(host,{mode:0o700});
const output=join(profile,'native-result.json');
const env={...process.env,CIALAI_BROTO_SOCKET:join(profile,'control.sock'),CIALAI_BROTO_SELFTEST_RESULT:output,CIALAI_BROTO_SELFTEST_PAIRING_FILE:join(host,'pairing.code')};
let daemon,monitor,monitorFailure,requestID=0;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const moduleRoot=fileURLToPath(new URL('../../../packages/tunnel-core/',import.meta.url));
const harness=spawn('go',['test','./internal/edge','-run','^TestBrotoExternalPeer$','-v','-timeout','35m'],{cwd:moduleRoot,env:{...env,BROTO_EXTERNAL_DIR:host,BROTO_EXTERNAL_ADDRESS:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
let harnessFailure;
harness.on('error',error=>{harnessFailure=error;});
harness.on('exit',code=>{harnessFailure=Error(`Host harness ended before completion: ${code}`);});
let harnessLog='';for(const stream of [harness.stdout,harness.stderr])stream.on('data',chunk=>{harnessLog+=chunk;});
function done(child,timeout){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Native lab timed out'));},timeout);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error(`Native lab process exited ${code}`));});});}
async function until(check,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(harnessFailure)throw harnessFailure;if(monitorFailure)throw monitorFailure;const result=await check();if(result)return result;await pause(50);}throw Error('Native lab condition timed out');}
async function readJSON(path){try{return JSON.parse(await readFile(path,'utf8'));}catch{return null;}}
async function admin(method,params={}){
 const id=++requestID;const path=join(host,`request-${id}.json`);await writeFile(path+'.tmp',JSON.stringify({id,method,params}),{mode:0o600});await rename(path+'.tmp',path);
 const response=await until(()=>readJSON(join(host,`response-${id}.json`)));
 return response;
}
async function call(method,params={}){const response=await admin(method,params);if(response.error)throw Error(`Lab command failed: ${method}`);return response.result;}
async function stage(name){await until(async()=> (await readJSON(join(profile,`native-stage-${name}.json`)))?.stage===name);}
async function next(name){await writeFile(join(profile,`continue-${name}`),'',{mode:0o600});}
async function status(){
 return new Promise((resolve,reject)=>{const child=spawn(daemonBinary,['status','--state-dir',join(profile,'state')],{env});let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.on('error',reject);child.on('exit',code=>{if(code!==0)reject(Error('Service unavailable'));else{try{resolve(JSON.parse(output));}catch(error){reject(error);}}});});
}
try{
 await until(async()=>{try{return (await readFile(join(host,'pairing.code'))).length>0;}catch{return false;}},120000);
 daemon=spawn(daemonBinary,['serve','--state-dir',join(profile,'state'),'--stun',''],{env,stdio:'ignore'});
 await until(async()=>{try{return (await status()).state==='disconnected';}catch{return false;}});
 monitor=spawn(monitorBinary,[],{env,stdio:'ignore'});const monitorDone=done(monitor,180000).catch(error=>{monitorFailure=error;});
 await stage('waiting');const progress=await readJSON(join(profile,'native-stage-waiting.json'));const pending=await call('broto.pair.pending');
 if(pending.length!==1||pending[0].digits!==progress.digits)throw Error('Approval digits mismatch');
 await call('broto.pair.decide',{approve:true});await next('waiting');
 await stage('connected');const device=(await call('broto.list')).find(device=>device.connected);if(!device)throw Error('Host did not observe connection');
 await call('broto.permission.set',{deviceId:device.id,level:'free'});
 const opened=await call('broto.call',{deviceId:device.id,cmd:'pty.open',actor:'human',args:{cols:80,rows:24}});
 await call('broto.call',{deviceId:device.id,cmd:'pty.write',actor:'human',args:{id:opened.id,data:Buffer.from("printf 'native-broto-ok\\n'\r").toString('base64')}});
 await next('connected');
 await stage('paused');await until(async()=> (await call('broto.list')).some(device=>device.paused));
 const denied=await admin('broto.call',{deviceId:device.id,cmd:'pty.open',actor:'human',args:{cols:80,rows:24}});if(!denied.error)throw Error('Paused daemon accepted a new terminal');await next('paused');
 await stage('resumed');await until(async()=> (await call('broto.list')).some(device=>device.connected&&!device.paused));
 await call('broto.call',{deviceId:device.id,cmd:'pty.write',actor:'human',args:{id:opened.id,data:Buffer.from("printf 'native-resume-ok\\n'\r").toString('base64')}});
 await until(async()=>{const data=await call('broto.call',{deviceId:device.id,cmd:'pty.read',actor:'human',args:{id:opened.id,offset:0}});return Buffer.from(data.data||'','base64').toString().includes('native-resume-ok');});await next('resumed');
 await stage('disconnected');await until(async()=> (await call('broto.list')).some(device=>device.revoked&&!device.connected));await next('disconnected');
 await monitorDone;if(monitorFailure)throw monitorFailure;const report=await readJSON(output);if(!report?.passed)throw Error('Native monitor selftest failed');
 Object.assign(report,{digitsMatchedOnHost:true,hostObservedPause:true,pausedMutationDenied:true,terminalOutputAfterResume:true,hostObservedRevocation:true,serviceSurvivedWindowExit:daemon.exitCode===null&&(await status()).state==='disconnected',platform:process.platform,transport:'direct',scope:'native WebView, protected IPC, real edge and hub, real daemon; not full desktop sidecar'});
 if(!report.serviceSurvivedWindowExit)throw Error('Daemon did not survive the native window exit');
 await writeFile(join(profile,'evidence.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({profile,...report}));
}finally{
 if(monitor?.exitCode===null)monitor.kill();if(daemon?.exitCode===null)daemon.kill();
 await writeFile(join(host,'finish'),'');if(harness.exitCode===null){try{await done(harness,10000);}catch{harness.kill();}}
 await writeFile(join(profile,'harness.log'),harnessLog);
}
