// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFileSync,readdirSync,lstatSync,writeFileSync } from 'node:fs';
import {join,relative,sep} from 'node:path';
const root=process.argv[2]; if(!root)throw new Error('Provide payload directory');
const lines=[];
function walk(dir){for(const name of readdirSync(dir).sort()){const file=join(dir,name),s=lstatSync(file),rel=relative(root,file).split(sep).join('/');if(s.isSymbolicLink())throw new Error('Symlink forbidden');if(s.isDirectory())walk(file);else if(!['SHA256SUMS.txt','SHA256SUMS.txt.minisig'].includes(rel))lines.push(`${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${rel}`);}}
walk(root);writeFileSync(join(root,'SHA256SUMS.txt'),lines.join('\n')+'\n');
