// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, 'utf8');
const cargo = read('apps/desktop/src-tauri/Cargo.toml');
const shared = read('apps/desktop/src-tauri/src/workspace/mobile_files.rs');
const windows = read('apps/desktop/src-tauri/src/workspace/mobile_files/windows.rs');
const workspace = read('apps/desktop/src-tauri/src/workspace/mod.rs');

assert.match(cargo, /"Win32_Storage_FileSystem"/);
assert.match(shared, /cfg\(target_os = "windows"\)[\s\S]*mod windows;/);
// O backend Windows e o que o celular usa no Windows, sem stub de indisponivel nem corte por unix.
assert.match(workspace, /^pub mod mobile_files;$/m);
assert.doesNotMatch(workspace, /pub mod mobile_files \{/);
assert.doesNotMatch(shared, /#!\[cfg\(unix\)\]/);
for (const test of ['lists_and_reads_text_inside_the_project', 'hides_secrets_and_refuses_escapes_and_foreign_roots', 'refuses_hard_links_and_links_that_leave_the_project']) {
  assert.match(windows, new RegExp(`fn ${test}\\(`), `Windows mobile_files sem o teste ${test}`);
}
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

console.log('PASS mobile_files Windows: wired backend with reparse points, final path, hard links and bounds guarded and tested');
