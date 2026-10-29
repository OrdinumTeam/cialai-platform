// SPDX-License-Identifier: Apache-2.0
import{writeFileSync}from'node:fs';
const tag=process.env.BROTO_VERSION||process.env.GITHUB_REF_NAME||'';if(!/^broto-v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(tag))throw Error('Valid Broto release tag required');
writeFileSync(process.argv[2],JSON.stringify({version:tag.slice('broto-v'.length)})+'\n');
