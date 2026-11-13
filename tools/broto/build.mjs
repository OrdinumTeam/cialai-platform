// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageLocalTorResource } from '../fetch-tor.mjs';
export const targets = { 'macos-arm64':['darwin','arm64','aarch64-apple-darwin'], 'macos-x64':['darwin','amd64','x86_64-apple-darwin'], 'linux-x64':['linux','amd64','x86_64-unknown-linux-gnu'], 'windows-x64':['windows','amd64','x86_64-pc-windows-msvc'] };
const root = fileURLToPath(new URL('../../', import.meta.url));
export async function build(target, output) {
  if (!targets[target]) throw new Error('Unsupported Broto target');
  const [goos, goarch, triple] = targets[target];
  const dir = resolve(output); mkdirSync(dir, {recursive:true});
  const binary = join(dir, `cialai-broto${goos === 'windows' ? '.exe' : ''}`);
  const r = spawnSync('go', ['build','-trimpath','-mod=readonly','-ldflags=-s -w','-o',binary,'./cmd/cialai-broto'], {cwd:join(root,'packages/tunnel-core'),env:{...process.env,CGO_ENABLED:'0',GOOS:goos,GOARCH:goarch},stdio:'inherit'});
  if(r.status !== 0) throw new Error('Go build failed');
  const mcp = spawnSync('go', ['build','-trimpath','-mod=readonly','-ldflags=-s -w','-o',join(dir,`cialai-broto-mcp${goos === 'windows' ? '.exe' : ''}`),'./cmd/cialai-broto-mcp'], {cwd:join(root,'packages/tunnel-core'),env:{...process.env,CGO_ENABLED:'0',GOOS:goos,GOARCH:goarch},stdio:'inherit'});
  if(mcp.status !== 0) throw new Error('MCP build failed');
  writeFileSync(join(dir,'release.json'),JSON.stringify({version:process.env.BROTO_VERSION || '0.1.0-local',target,binary:goos === 'windows'?'cialai-broto.exe':'cialai-broto'},null,2)+'\n');
  await stageLocalTorResource(triple,{resourceRoot:join(dir,'tor'),outputRoot:join(dir,'..','tor-cache')});
  for(const name of ['LICENSE','NOTICE']) copyFileSync(join(root,name),join(dir,name));
  mkdirSync(join(dir,'licenses'),{recursive:true});copyFileSync(join(root,'docs/legal/minisign-MIT.txt'),join(dir,'licenses/minisign-MIT.txt'));
  mkdirSync(join(dir,'install'),{recursive:true});copyFileSync(join(root,'packages/tunnel-core/internal/brotoinstall/install-service.ps1'),join(dir,'install/install-service.ps1'));
  const info=spawnSync('go',['version','-m',binary],{encoding:'utf8'});
  if(info.status !== 0) throw new Error('Dependency inventory failed');
  writeFileSync(join(dir,'go-buildinfo.txt'),info.stdout.replace(/^[^\n]*(: go[^\n]*)/,basename(binary)+'$1'));
}
if(process.argv[1] === fileURLToPath(import.meta.url)) {
  const [target,output] = process.argv.slice(2); if(!output) throw new Error('Usage: node tools/broto/build.mjs TARGET OUTPUT');
  await build(target,output);
}
