// SPDX-License-Identifier: Apache-2.0
// Botao da toolbar que traz a barra de IA de volta, visivel so quando ela
// esta escondida. Com a barra a vista, ela mesma tem o botao de recolher.

import React from 'react';
import { PanelRight } from 'lucide-react';
import { notchActions, useNotch } from './notch-runtime.js';
import { translate, useI18n } from './i18n.js';

export default function NotchIndicator() {
  useI18n();
  const { prefs } = useNotch();
  if (!prefs || prefs.visibility !== 'hidden') return null;
  return (
    <button
      type="button"
      className="mac-tool"
      onClick={() => notchActions.setVisibility('open').catch(() => {})}
      title={translate('desktop.notch.action.show')}
      aria-label={translate('desktop.notch.action.show')}
    >
      <PanelRight size={15} strokeWidth={1.75} />
    </button>
  );
}
