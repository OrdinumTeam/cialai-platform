// SPDX-License-Identifier: Apache-2.0
// Anel de uso de um perfil, em SVG.
//
// Duas camadas: a trilha e o arco. O arco comeca as doze horas e anda no
// sentido horario, e a cor vem da banda de uso, nao do provedor: o que o anel
// comunica e quanto sobrou, e uma cor por marca competiria com isso. O glifo
// no centro diz de qual ferramenta e a conta.

import React from 'react';
import claudeGlyph from './glyphs/claude.svg?raw';
import openaiGlyph from './glyphs/openai.svg?raw';

export { bandOf } from './model.js';

const GLYPHS = { claude: claudeGlyph, codex: openaiGlyph };

export const RING_SIZE = 40;
const STROKE = 4;
const RADIUS = (RING_SIZE - STROKE) / 2;
const CENTRE = RING_SIZE / 2;
const GLYPH = 15;

export default function Ring({ provider, fraction, band = 'ample', stale = false }) {
  const circumference = 2 * Math.PI * RADIUS;
  const filled = Math.max(0, Math.min(1, fraction ?? 0)) * circumference;
  const glyph = (GLYPHS[provider] || GLYPHS.claude).replace(/<svg[^>]*>|<\/svg>/g, '');

  return (
    <svg
      className={`notch-ring${stale ? ' is-stale' : ''}`}
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden="true"
    >
      <circle className="notch-ring__track" cx={CENTRE} cy={CENTRE} r={RADIUS} strokeWidth={STROKE} fill="none" />
      {fraction !== null && fraction !== undefined && (
        <circle
          className={`notch-ring__arc is-${band}`}
          cx={CENTRE}
          cy={CENTRE}
          r={RADIUS}
          strokeWidth={STROKE}
          strokeLinecap="round"
          fill="none"
          transform={`rotate(-90 ${CENTRE} ${CENTRE})`}
          strokeDasharray={`${filled.toFixed(3)} ${circumference.toFixed(3)}`}
        />
      )}
      <g
        className={`notch-ring__glyph${band === 'exhausted' ? ' is-spent' : ''}`}
        transform={`translate(${CENTRE - GLYPH / 2} ${CENTRE - GLYPH / 2}) scale(${GLYPH / 24})`}
        dangerouslySetInnerHTML={{ __html: glyph }}
      />
    </svg>
  );
}
