// SPDX-License-Identifier: Apache-2.0
// Tom de destaque de uma sessao, resolvido num lugar so.
//
// A cor escolhida para o card substitui o rosa em tudo que pertence aquela
// sessao: botoes, icones, nome do agente, percentuais, selecao e foco. Sem
// cor, vale o rosa do Cialai. Daqui saem as variaveis CSS que o card, o
// cabecalho, o explorador e o menu da sessao recebem inline, entao duas
// sessoes abertas nunca dividem o mesmo tom.
//
// Cada tema tem a base da paleta e as variantes derivadas dela. O texto e a
// base escurecida no claro, ou clareada no escuro, ate passar de 4,5:1 contra
// as superficies onde aparece: uma cor clara demais ou escura demais continua
// legivel sem trocar de matiz. Modulo puro, sem React e sem xterm, para os
// testes cobrirem cada cor da paleta.

import { ORGANIZATION_COLORS } from '../lib/organization-colors.js';

/// O rosa do Cialai: magenta no claro, rosa quente no escuro. Os mesmos
/// valores de `--mac-accent` em `desktop/brand.css`.
export const DEFAULT_ACCENT = Object.freeze({ id: null, light: '#E23B84', dark: '#FF7AB2' });

/// Superficies onde o texto de destaque aparece: o card e o fundo suave dos
/// campos e do card selecionado. O contraste vale para a pior delas.
export const ACCENT_SURFACES = Object.freeze({
  light: Object.freeze(['#FFFFFF', '#F2F4F9']),
  dark: Object.freeze(['#1C1C1E', '#26262A']),
});

export const TEXT_CONTRAST = 4.5;
const WHITE = '#FFFFFF';
const BLACK = '#000000';
/// Texto sobre a base cheia, quando o branco nao alcanca: o ameixa da marca.
const PLUM = '#3A1B33';

// Opacidade de cada variante por tema. O escuro pede mais tinta para a
// mesma presenca.
const ALPHA = Object.freeze({
  light: Object.freeze({ soft: 0.10, softHover: 0.15, ring: 0.24, border: 0.42 }),
  dark: Object.freeze({ soft: 0.16, softHover: 0.24, ring: 0.38, border: 0.52 }),
});

function parse(hex) {
  const value = String(hex || '').trim().replace(/^#/, '');
  const full = value.length === 3 ? value.split('').map((part) => part + part).join('') : value;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((start) => parseInt(full.slice(start, start + 2), 16));
}

function format(rgb) {
  return `#${rgb.map((part) => Math.round(Math.max(0, Math.min(255, part))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function channel(value) {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

/// Luminancia relativa da WCAG 2.
export function luminance(hex) {
  const rgb = parse(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/// Razao de contraste da WCAG 2 entre duas cores.
export function contrast(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  const light = Math.max(first, second);
  const dark = Math.min(first, second);
  return (light + 0.05) / (dark + 0.05);
}

function mix(hex, target, amount) {
  const from = parse(hex);
  const to = parse(target);
  if (!from || !to) return hex;
  return format(from.map((part, index) => part + (to[index] - part) * amount));
}

function rgba(hex, alpha) {
  const rgb = parse(hex) || parse(DEFAULT_ACCENT.light);
  return `rgba(${rgb.join(',')},${alpha})`;
}

function worstContrast(color, surfaces) {
  return Math.min(...surfaces.map((surface) => contrast(color, surface)));
}

/// A base, puxada para o preto no claro ou para o branco no escuro, ate o
/// contraste minimo contra todas as superficies do tema.
export function readableText(base, theme) {
  const surfaces = ACCENT_SURFACES[theme] || ACCENT_SURFACES.light;
  const target = theme === 'dark' ? WHITE : BLACK;
  for (let step = 0; step <= 50; step += 1) {
    const candidate = mix(base, target, step / 50);
    if (worstContrast(candidate, surfaces) >= TEXT_CONTRAST) return candidate;
  }
  return target;
}

/// Branco ou ameixa sobre a base cheia, o que contrastar mais.
export function onAccent(base) {
  return contrast(WHITE, base) >= contrast(PLUM, base) ? WHITE : PLUM;
}

function variant(base, theme) {
  const alpha = ALPHA[theme];
  return {
    base: format(parse(base)),
    text: readableText(base, theme),
    onBase: onAccent(base),
    soft: rgba(base, alpha.soft),
    softHover: rgba(base, alpha.softHover),
    ring: rgba(base, alpha.ring),
    border: rgba(base, alpha.border),
  };
}

/// Entrada da paleta para um id, ou null quando o id nao existe.
export function paletteEntry(colorId, palette = ORGANIZATION_COLORS) {
  if (!colorId) return null;
  return palette.find((entry) => entry.id === colorId && parse(entry.light) && parse(entry.dark)) || null;
}

/// Tom resolvido de uma cor da paleta. Sem cor, ou com id desconhecido, o
/// rosa do Cialai.
export function resolveSessionAccent(colorId, palette = ORGANIZATION_COLORS) {
  const entry = paletteEntry(colorId, palette);
  const source = entry || DEFAULT_ACCENT;
  return {
    id: entry ? entry.id : null,
    custom: Boolean(entry),
    light: variant(source.light, 'light'),
    dark: variant(source.dark, 'dark'),
  };
}

const VARS = Object.freeze({
  base: 'accent',
  text: 'accent-text',
  onBase: 'on-accent',
  soft: 'accent-soft',
  softHover: 'accent-soft-hover',
  ring: 'accent-ring',
  border: 'accent-border',
});

/// Variaveis CSS do tom resolvido, para os dois temas. O CSS escolhe o par
/// pelo `data-theme` em `.session-scope`.
export function accentVars(accent) {
  const style = {};
  ['light', 'dark'].forEach((theme) => {
    Object.entries(VARS).forEach(([key, name]) => { style[`--session-${name}-${theme}`] = accent[theme][key]; });
  });
  return style;
}

/// Estilo inline de uma sessao: sempre emite valor, inclusive o rosa padrao,
/// para que o contexto da sessao nunca herde o tom de outra.
export function sessionAccentStyle(session, palette = ORGANIZATION_COLORS) {
  return accentVars(resolveSessionAccent(session?.color ?? null, palette));
}

/// Tom da Barra de IA: a cor da sessao selecionada no estudio, para os
/// limites das IAs acompanharem o card em foco. Sem sessao, sem cor ou com
/// cor desconhecida, null, e a barra segue no rosa.
export function barAccent(selected, palette = ORGANIZATION_COLORS) {
  return paletteEntry(selected?.color, palette)?.id || null;
}
