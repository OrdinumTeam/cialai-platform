// SPDX-License-Identifier: Apache-2.0
// Imagem da sessão para os avisos do aparelho: o ícone dela em branco sobre um
// quadrado inteiro na cor da sessão, a mesma do card. A página desenha porque
// é ela que conhece os ícones e as cores; a casca recebe o PNG pronto no
// retrato do Início e o usa como ícone grande no Android e miniatura no
// iPhone.
//
// Uma imagem por combinação de ícone e cor, guardada enquanto a página vive.
// Sem canvas, como nos testes, nada é desenhado e o aviso sai sem imagem.
import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import SessionIcon from '../terminals/ui/SessionIcon.jsx';
import { resolveSessionAccent } from '../terminals/session-accent.js';
import { resolveSessionIcon } from '../terminals/session-icons.js';

export const BADGE_SIZE = 192;
const GLYPH_SIZE = 112;
// O que o retrato aceita: chave `icone:#cor` e no máximo tantas imagens.
export const BADGE_KEY = /^[a-z0-9-]{1,40}:#[0-9a-f]{6}$/;
export const MAX_BADGES = 24;
const PNG_BASE64 = 'iVBORw0KGgo';
// Tempo máximo que o retrato espera uma imagem nova; a que não ficou pronta
// vai no próximo.
const BADGE_WAIT_MS = 400;

const ready = new Map();
const pending = new Map();
const failed = new Set();

export function badgeKey(session) {
  const icon = resolveSessionIcon(session);
  const glyph = icon.kind === 'custom' ? icon.id : icon.kind === 'agent' ? `agent-${icon.agent}` : 'terminal';
  return `${glyph}:${resolveSessionAccent(session?.color).light.base.toLowerCase()}`;
}

export function canDrawBadges() {
  return typeof document !== 'undefined' && typeof Image !== 'undefined'
    && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined';
}

// O SVG do ícone como o card desenha, em branco e já no tamanho final.
function glyphMarkup(session) {
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    flushSync(() => root.render(React.createElement(SessionIcon, { session, size: GLYPH_SIZE })));
    const svg = host.querySelector('svg');
    if (!svg) return null;
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', String(GLYPH_SIZE));
    svg.setAttribute('height', String(GLYPH_SIZE));
    svg.setAttribute('color', '#FFFFFF');
    svg.style.color = '#FFFFFF';
    return svg.outerHTML;
  } finally {
    root.unmount();
  }
}

function loadImage(url) {
  const image = new Image();
  image.decoding = 'async';
  const loaded = new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('badge_image_failed'));
  });
  image.src = url;
  return loaded;
}

async function drawBadge(markup, color) {
  const canvas = document.createElement('canvas');
  canvas.width = BADGE_SIZE;
  canvas.height = BADGE_SIZE;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = color;
  context.fillRect(0, 0, BADGE_SIZE, BADGE_SIZE);
  // Blob da própria página: o canvas não fica marcado como de outra origem.
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  try {
    const image = await loadImage(url);
    const offset = (BADGE_SIZE - GLYPH_SIZE) / 2;
    context.drawImage(image, offset, offset, GLYPH_SIZE, GLYPH_SIZE);
  } finally {
    URL.revokeObjectURL(url);
  }
  const data = canvas.toDataURL('image/png');
  const base64 = data.slice(data.indexOf(',') + 1);
  return base64.startsWith(PNG_BASE64) ? base64 : null;
}

function render(session, key) {
  const color = key.slice(key.indexOf(':') + 1);
  const job = Promise.resolve()
    .then(() => {
      const markup = glyphMarkup(session);
      return markup ? drawBadge(markup, color) : null;
    })
    .then((image) => { if (image) ready.set(key, image); else failed.add(key); })
    .catch(() => { failed.add(key); })
    .finally(() => { pending.delete(key); });
  pending.set(key, job);
  return job;
}

// Imagens prontas das sessões, desenhando as que faltam. `byId` liga cada
// sessão à chave da imagem dela; `badges` leva cada imagem uma vez só.
export async function sessionBadges(sessions, { waitMs = BADGE_WAIT_MS } = {}) {
  const empty = { byId: {}, badges: {} };
  if (!canDrawBadges() || !Array.isArray(sessions)) return empty;
  const keys = new Map();
  for (const session of sessions) {
    if (!session || typeof session.id !== 'string') continue;
    const key = badgeKey(session);
    if (!BADGE_KEY.test(key)) continue;
    keys.set(session.id, key);
    if (!ready.has(key) && !pending.has(key) && !failed.has(key)) render(session, key);
  }
  const waiting = [...new Set(keys.values())].map((key) => pending.get(key)).filter(Boolean);
  if (waiting.length) {
    let timer = null;
    await Promise.race([
      Promise.allSettled(waiting),
      new Promise((resolve) => { timer = setTimeout(resolve, waitMs); }),
    ]);
    clearTimeout(timer);
  }
  const result = { byId: {}, badges: {} };
  for (const [id, key] of keys) {
    const image = ready.get(key);
    if (!image) continue;
    if (!(key in result.badges)) {
      if (Object.keys(result.badges).length >= MAX_BADGES) continue;
      result.badges[key] = image;
    }
    result.byId[id] = key;
  }
  return result;
}
