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
const prefs = read('apps/desktop/src-tauri/src/prefs.rs');

// As etapas vêm das chaves compartilhadas, com texto nos três idiomas.
assert.match(onboarding, /\['welcome', 'folders', 'shell', 'network', 'ready'\]\.map\(\(step\) => translate\(`desktop\.onboarding\.step\.\$\{step\}`\)\)/);
const steps = ['welcome', 'folders', 'shell', 'network', 'ready'].map((step) => dictionaries['pt-BR'][`desktop.onboarding.step.${step}`]);
assert.deepEqual(steps, ['Boas vindas', 'Pastas', 'Shell', 'Rede', 'Pronto']);

// A etapa de rede só informa: a conexão sobe sozinha, sem assistente nem campos.
const mobileStep = onboarding.slice(onboarding.indexOf('function MobileStep'), onboarding.indexOf('function Ready'));
assert.ok(mobileStep.includes("translate('desktop.onboarding.mobileAccess')"), 'Etapa informativa do celular ausente');
assert.doesNotMatch(mobileStep, /<(input|select|textarea|button)\b/, 'A etapa do celular não pode pedir dados');
assert.match(onboarding, /step === 3 \? <MobileStep \/>/);
assert.doesNotMatch(onboarding, /NetworkSetup|controlUrl|userName|networkIsConfigured|configureNow/, 'O assistente do Headscale saiu do onboarding');
assert.match(onboarding, /network: \{\s*desktopName: null,\s*requireApproval: false,\s*keepAwakeWhilePaired: false,\s*\}/);
assert.match(onboarding, /onClick=\{\(\) => finish\(true\)\}>\{translate\('desktop\.action\.pairPhone'\)\}/, 'Vincular celular fica disponível ao concluir');
for (const locale of Object.keys(dictionaries)) {
  for (const key of ['desktop.onboarding.mobileAccess', 'desktop.onboarding.networkDescription', 'desktop.onboarding.factLocal', 'desktop.onboarding.factReserve', 'desktop.onboarding.factPairing']) assert.ok(dictionaries[locale][key], `Texto do celular ausente em ${locale}: ${key}`);
}
assert.doesNotMatch(prefs, /control_url|user_id|user_name/, 'preferences.json não guarda mais o Headscale');
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

console.log('PASS onboarding: welcome, project roots, disposable PTY shell check, informative phone access step and first session are wired');
