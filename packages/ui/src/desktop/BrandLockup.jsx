// SPDX-License-Identifier: Apache-2.0
// Assinatura oficial do Cialai: a cabeca do louva-a-deus e o lettering do
// site, nunca o nome escrito numa fonte. As imagens saem da assinatura
// aprovada por tools/brand/build-ui-lockup.mjs: a de cores para o tema claro
// e a de letras brancas para o escuro. So a do tema atual entra na pagina:
// imagem escondida por CSS continua sendo baixada, e as duas juntas pesavam
// na primeira pintura. A troca de tema chega pelo `data-theme` do html.
//
// Com `wordmark`, so o lettering, sem a cabeca: a marca discreta da toolbar
// quando a lateral fecha.

import React, { useSyncExternalStore } from 'react';
import { isDarkTheme, watchTheme } from '../terminals/theme.js';
import lockup from '../assets/cialai-lockup.png';
import lockupDark from '../assets/cialai-lockup-dark.png';
import wordmarkLight from '../assets/cialai-wordmark.png';
import wordmarkDark from '../assets/cialai-wordmark-dark.png';

const PIECES = Object.freeze({
  lockup: { light: lockup, dark: lockupDark, width: 480, height: 161 },
  wordmark: { light: wordmarkLight, dark: wordmarkDark, width: 360, height: 112 },
});

const subscribe = (notify) => watchTheme(notify);
const lightOnServer = () => false;

export default function BrandLockup({ className, alt = 'Cialai', wordmark = false }) {
  const piece = wordmark ? PIECES.wordmark : PIECES.lockup;
  const variant = useSyncExternalStore(subscribe, isDarkTheme, lightOnServer) ? 'dark' : 'light';
  return <img src={piece[variant]} alt={alt} width={piece.width} height={piece.height} className={`${className} ${className}--${variant}`} draggable="false" />;
}
