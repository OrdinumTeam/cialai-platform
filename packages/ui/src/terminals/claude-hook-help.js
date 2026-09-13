// SPDX-License-Identifier: Apache-2.0

export function claudeHookInstaller(os) {
  return os === 'windows'
    ? 'scripts/install-claude-statusline.ps1'
    : 'scripts/install-claude-statusline.sh';
}

export function claudeHookMissingTitle(profile, os) {
  return `Perfil ${profile} sem o hook de linha de estado. Rode ${claudeHookInstaller(os)}`;
}
