// SPDX-License-Identifier: Apache-2.0
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const result=spawnSync('go',['list','-mod=readonly','-m','-json','all'],{cwd:'packages/tunnel-core',encoding:'utf8'});
if(result.status!==0) throw Error(result.stderr);
// Go emits a sequence of JSON objects. Decode using brace depth outside strings.
const modules=[];let start=0,depth=0,quoted=false,escape=false;
for(let i=0;i<result.stdout.length;i++){const c=result.stdout[i];if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;continue;}if(c==='"')quoted=true;else if(c==='{'){if(depth++===0)start=i;}else if(c==='}'&&--depth===0)modules.push(JSON.parse(result.stdout.slice(start,i+1)));}
if(depth!==0||modules.length===0)throw Error('Invalid Go module inventory');
writeFileSync(process.argv[2],JSON.stringify({bomFormat:'CycloneDX',specVersion:'1.5',version:1,metadata:{component:{type:'application',name:'Cialai Broto'}},components:modules.filter(m=>!m.Main).map(m=>({type:'library',name:m.Path,version:m.Version,purl:`pkg:golang/${m.Path}@${m.Version}`}))},null,2)+'\n');
