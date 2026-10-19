// SPDX-License-Identifier: Apache-2.0
// Icone da sessao, ao lado do nome no card e no cabecalho.
//
// O escolhido pelo usuario representa a sessao; sem escolha, o padrao e o
// glifo do agente que roda nela, ou o terminal. A cor vem do tom da sessao,
// pelo `--session-accent-text` do contexto, entao acompanha a cor do card e,
// sem cor, fica no rosa. Decorativo: o nome ao lado ja identifica a sessao.

import React from 'react';
import claudeGlyph from '../../notch/glyphs/claude.svg?raw';
import openaiGlyph from '../../notch/glyphs/openai.svg?raw';
import { resolveSessionIcon } from '../session-icons.js';

const GLYPHS = Object.freeze({ claude: claudeGlyph, codex: openaiGlyph });

export default function SessionIcon({ session, size = 14, className = '' }) {
  const icon = resolveSessionIcon(session);
  const classes = `session-icon session-icon--${icon.kind}${className ? ` ${className}` : ''}`;
  if (icon.kind === 'agent') {
    return (
      <span
        className={classes}
        style={{ width: size, height: size }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: GLYPHS[icon.agent] || '' }}
      />
    );
  }
  const { Icon } = icon;
  return (
    <span className={classes} style={{ width: size, height: size }} aria-hidden="true">
      <Icon size={size} strokeWidth={1.9} />
    </span>
  );
}
