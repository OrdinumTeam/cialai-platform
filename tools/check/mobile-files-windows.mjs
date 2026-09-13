// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, 'utf8');
const cargo = read('apps/desktop/src-tauri/Cargo.toml');
const shared = read('apps/desktop/src-tauri/src/workspace/mobile_files.rs');
const windows = read('apps/desktop/src-tauri/src/workspace/mobile_files/windows.rs');

assert.match(cargo, /"Win32_Storage_FileSystem"/);
assert.match(shared, /cfg\(target_os = "windows"\)[\s\S]*mod windows;/);
for (const contract of [
  'CreateFileW',
  'FILE_FLAG_OPEN_REPARSE_POINT',
  'FILE_FLAG_BACKUP_SEMANTICS',
  'FILE_ATTRIBUTE_REPARSE_POINT',
  'GetFinalPathNameByHandleW',
  'GetFileInformationByHandle',
  'nNumberOfLinks',
]) {
  assert.match(windows, new RegExp(`\\b${contract}\\b`), `Windows mobile_files sem ${contract}`);
}
assert.match(windows, /contained\(&cwd_handle\.final_path, &opened\.final_path\)/);
assert.doesNotMatch(windows, /indisponíveis neste sistema/);

console.log('PASS mobile_files Windows: reparse points, final path, hard links and bounds guarded');
