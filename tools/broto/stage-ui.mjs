// SPDX-License-Identifier: Apache-2.0
import {cpSync,mkdirSync,readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
const [source,dest]=process.argv.slice(2);if(!dest)throw Error('Source and destination required');mkdirSync(dest,{recursive:true});
let count=0;
for(const sub of readdirSync(source)){const dir=join(source,sub);if(!lstatSync(dir).isDirectory())continue;for(const name of readdirSync(dir)){if(/\.(app|dmg|AppImage|deb|rpm|exe|msi)$/.test(name)){cpSync(join(dir,name),join(dest,name),{recursive:true,dereference:true});count++;}}}
if(!count)throw Error('No Broto UI packages found');
