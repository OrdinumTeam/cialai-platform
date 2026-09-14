// SPDX-License-Identifier: Apache-2.0
import { translate } from '../shared/i18n.js';

export function claudeHookInstaller(os) {
  return os === 'windows'
    ? 'scripts/install-claude-statusline.ps1'
    : 'scripts/install-claude-statusline.sh';
}

export function claudeHookMissingTitle(profile, os) {
  return translate('terminal.plan.missingClaudeHook', { profile, installer: claudeHookInstaller(os) });
}
