// SPDX-License-Identifier: Apache-2.0
// Anel de uso de um perfil, em SVG.
//
// Duas camadas: a trilha e o arco. O arco comeca as doze horas e anda no
// sentido horario, e a cor vem da banda de uso, nao do provedor: o que o anel
// comunica e quanto sobrou, e uma cor por marca competiria com isso. O glifo
// no centro diz de qual ferramenta e a conta.
//
// Por dentro vai o anel do uso semanal, com a mesma convencao e a mesma
// espessura, para os dois pesarem igual. Ele so existe quando a conta tem
// janela semanal; sem leitura vira uma trilha tracejada, que nao se confunde
// com 0%.

import React from 'react';
import claudeGlyph from './glyphs/claude.svg?raw';
import openaiGlyph from './glyphs/openai.svg?raw';

export { bandOf } from './model.js';

const GLYPHS = { claude: claudeGlyph, codex: openaiGlyph };

export const RING_SIZE = 40;
const STROKE = 3;
const RADIUS = (RING_SIZE - STROKE) / 2;
const CENTRE = RING_SIZE / 2;
// Anel semanal: o mesmo traco do externo, com dois pixels de folga ate a
// borda de dentro dele.
const INNER_STROKE = 3;
const INNER_GAP = 2;
const INNER_RADIUS = RADIUS - STROKE / 2 - INNER_GAP - INNER_STROKE / 2;
// Trilha tracejada da semana sem leitura: vinte tracos curtos repartindo a
// volta por igual, para nao sobrar um traco grudado no outro onde ela fecha.
const UNKNOWN_DASHES = 20;
const UNKNOWN_DASH = 1.6;
const UNKNOWN_PATTERN = `${UNKNOWN_DASH} ${((2 * Math.PI * INNER_RADIUS) / UNKNOWN_DASHES - UNKNOWN_DASH).toFixed(3)}`;
const GLYPH = 15;
const GLYPH_WITH_INNER = 14;

function Arc({ className, radius, stroke, fraction }) {
  const circumference = 2 * Math.PI * radius;
  // Em 0% fica um traco minimo, que a ponta redonda transforma num ponto:
  // leitura de zero aparece, e so a falta de leitura fica sem arco.
  const filled = Math.max(0.01, Math.max(0, Math.min(1, fraction ?? 0)) * circumference);
  return (
    <circle
      className={className}
      cx={CENTRE}
      cy={CENTRE}
      r={radius}
      strokeWidth={stroke}
      strokeLinecap="round"
      fill="none"
      transform={`rotate(-90 ${CENTRE} ${CENTRE})`}
      strokeDasharray={`${filled.toFixed(3)} ${circumference.toFixed(3)}`}
    />
  );
}

/// `weekly` e o resultado de `weeklyState`: `available` desenha trilha e
/// arco, `unknown` a trilha tracejada e `none`, ou ausente, nada.
export default function Ring({ provider, fraction, band = 'ample', stale = false, weekly = null }) {
  const glyph = (GLYPHS[provider] || GLYPHS.claude).replace(/<svg[^>]*>|<\/svg>/g, '');
  const inner = weekly && (weekly.kind === 'available' || weekly.kind === 'unknown') ? weekly : null;
  const size = inner ? GLYPH_WITH_INNER : GLYPH;

  return (
    <svg
      className={`notch-ring${stale ? ' is-stale' : ''}${inner ? ' has-weekly' : ''}`}
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden="true"
    >
      <circle className="notch-ring__track" cx={CENTRE} cy={CENTRE} r={RADIUS} strokeWidth={STROKE} fill="none" />
      {fraction !== null && fraction !== undefined && (
        <Arc className={`notch-ring__arc is-${band}`} radius={RADIUS} stroke={STROKE} fraction={fraction} />
      )}
      {inner && (
        <g className={`notch-ring__weekly is-${inner.kind}${inner.stale ? ' is-stale' : ''}`}>
          <circle
            className="notch-ring__weekly-track"
            cx={CENTRE}
            cy={CENTRE}
            r={INNER_RADIUS}
            strokeWidth={INNER_STROKE}
            strokeDasharray={inner.kind === 'unknown' ? UNKNOWN_PATTERN : undefined}
            fill="none"
          />
          {inner.kind === 'available' && (
            <Arc className={`notch-ring__weekly-arc is-${inner.band}`} radius={INNER_RADIUS} stroke={INNER_STROKE} fraction={inner.fraction} />
          )}
        </g>
      )}
      <g
        className={`notch-ring__glyph${band === 'exhausted' ? ' is-spent' : ''}`}
        transform={`translate(${CENTRE - size / 2} ${CENTRE - size / 2}) scale(${size / 24})`}
        dangerouslySetInnerHTML={{ __html: glyph }}
      />
    </svg>
  );
}
