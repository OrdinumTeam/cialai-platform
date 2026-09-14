// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { dictionaries } from '@cialai/i18n';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, 'utf8');
const onboarding = read('packages/ui/src/desktop/Onboarding.jsx');
const desktop = read('packages/ui/src/desktop/DesktopApp.jsx');
const commands = read('apps/desktop/src-tauri/src/commands.rs');
const repos = read('apps/desktop/src-tauri/src/workspace/repos.rs');
const mobileFiles = read('apps/desktop/src-tauri/src/workspace/mobile_files.rs');

// As etapas vêm das chaves compartilhadas, com texto nos três idiomas.
assert.match(onboarding, /\['welcome', 'folders', 'shell', 'network', 'ready'\]\.map\(\(step\) => translate\(`desktop\.onboarding\.step\.\$\{step\}`\)\)/);
const steps = ['welcome', 'folders', 'shell', 'network', 'ready'].map((step) => dictionaries['pt-BR'][`desktop.onboarding.step.${step}`]);
assert.deepEqual(steps, ['Boas vindas', 'Pastas', 'Shell', 'Rede', 'Pronto']);
for (const locale of Object.keys(dictionaries)) {
  for (const step of ['welcome', 'folders', 'shell', 'network', 'ready']) assert.ok(dictionaries[locale][`desktop.onboarding.step.${step}`], `Etapa sem texto em ${locale}: ${step}`);
}
for (const command of ['get_preferences', 'set_preferences', 'detect_project_roots', 'list_repo_dirs', 'app_shell', 'shell_probe']) {
  assert.ok(onboarding.includes(`'${command}'`) || commands.includes(`fn ${command}`), `Contrato ausente: ${command}`);
}
assert.match(desktop, /shouldShowOnboarding/);
assert.match(desktop, /runtime\.openSession\(root\)/);
assert.match(onboarding, /cialai_onboarding_complete/);
assert.match(onboarding, /translate\('desktop\.onboarding\.foldersDescription'\)/);
assert.match(dictionaries['pt-BR']['desktop.onboarding.foldersDescription'], /Sessões fora delas continuam funcionando/);
assert.match(repos, /pub fn project_roots/);
assert.match(repos, /"Developer"[\s\S]*"Github Projects"/);
assert.doesNotMatch(`${repos}\n${mobileFiles}`, /REPO_ROOTS_FROM_HOME/);
assert.match(mobileFiles, /project_roots\(home, project_roots\)/);
assert.match(commands, /pub fn shell_probe/);
assert.match(commands, /native_pty_system\(\)/);

console.log('PASS onboarding: welcome, project roots, disposable PTY shell check and first session are wired');
