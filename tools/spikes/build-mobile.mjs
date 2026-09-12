// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cwd = resolve(root, 'packages/tunnel-core');
const platform = process.argv[2];
if (!['ios', 'android'].includes(platform)) throw new Error('Usage: node tools/spikes/build-mobile.mjs ios|android');
const output = resolve(cwd, 'build/spikes');
const toolDir = resolve(output, 'tools');
const env = { ...process.env, PATH: `${toolDir}${delimiter}${process.env.PATH ?? ''}` };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (platform === 'ios') {
  if (process.platform !== 'darwin') throw new Error('iOS builds require macOS and full Xcode');
  run('xcodebuild', ['-version']);
  run('xcrun', ['--sdk', 'iphoneos', '--show-sdk-path']);
} else if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
  throw new Error('Set ANDROID_HOME to an installed Android SDK with its matching NDK before building');
}

mkdirSync(toolDir, { recursive: true });
// Both tools are pinned by Go tool directives in the module. No global install.
run('go', ['build', '-mod=readonly', '-o', resolve(toolDir, process.platform === 'win32' ? 'gobind.exe' : 'gobind'), 'golang.org/x/mobile/cmd/gobind']);
run('go', ['tool', 'gomobile', 'init']);
const args = platform === 'ios'
  ? ['-target=ios,iossimulator', '-o', resolve(output, 'CialaiProbe.xcframework')]
  : ['-target=android/arm64,android/amd64', '-androidapi=26', '-o', resolve(output, 'cialai-probe.aar')];
run('go', ['tool', 'gomobile', 'bind', ...args, './spikes/mobileprobe']);
console.log(`Built experimental ${platform} binding in ${output}. Device acceptance remains pending.`);
