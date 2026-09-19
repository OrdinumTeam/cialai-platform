// SPDX-License-Identifier: Apache-2.0
// Desenho do grafo da documentacao num canvas 2D, e o acerto do ponteiro.
//
// Canvas e nao SVG: sao ate mil e quinhentas marcas, e em SVG cada mudanca de
// camera faria o WebKit repintar milhares de nos de DOM. WebGL disputaria o
// teto de contextos com o xterm de cada sessao. O molde e o do screencast do
// Dev Browser: `attach`, `detach`, `ResizeObserver` e razao de pixels limitada.
//
// O desenho nunca depende so de `requestAnimationFrame`. Fora da tela, que e
// como o `wksnap` captura, o WKWebView nao entrega quadros: `requestDraw`
// corre contra um prazo curto e `drawNow` desenha na hora ao anexar, ao
// redimensionar e ao trocar a cena.
//
// Codificacao, seguindo a skill dataviz: a forma diz o tipo, anel duplo para a
// raiz, circulo para pasta e quadrado arredondado para documento; o
// preenchimento diz o estado, disco cheio com o total para pasta recolhida e
// anel vazado para expandida; a cor diz o agrupamento e nunca carrega a
// identidade sozinha. Texto sempre em token de texto, nunca na cor do grupo.
// Marcas com anel na cor da superficie em vez de borda.

import { ORGANIZATION_COLORS } from '../../lib/organization-colors.js';
import { isDarkTheme } from '../theme.js';
import { badgeCount } from './copy.js';
import { NEUTRAL_TONE } from './model.js';

const DOC_SIZE = 7;
const LABEL_CAP = 140;
// Raio de tela a partir do qual a marca de uma pasta reserva lugar na grade.
const RESERVE_RADIUS = 10;
const CELL_W = 64;
const CELL_H = 20;
const DRAW_DEADLINE_MS = 120;

function token(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function rgba(hex, alpha) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((part) => part + part).join('') : value;
  const number = Number.parseInt(full, 16);
  return `rgba(${(number >> 16) & 255},${(number >> 8) & 255},${number & 255},${alpha})`;
}

// So tokens da casca e a paleta compartilhada: o canvas nao define cor propria.
export function readGraphTheme() {
  const dark = isDarkTheme();
  const tones = {};
  ORGANIZATION_COLORS.forEach((color) => { tones[color.id] = dark ? color.dark : color.light; });
  return {
    dark,
    surface: token('--mac-surface', dark ? '#1c1c1e' : '#ffffff'),
    ink: token('--mac-label', dark ? '#f5f5f7' : '#1d1d1f'),
    ink2: token('--mac-label-2', dark ? 'rgba(235,235,245,.62)' : '#6e6e73'),
    ink3: token('--mac-label-3', dark ? 'rgba(235,235,245,.40)' : '#a1a1a6'),
    accent: token('--mac-accent', dark ? '#4a8ae6' : '#1a4fa0'),
    accentRing: token('--mac-accent-ring', 'rgba(26,79,160,.18)'),
    warn: token('--mac-warn', dark ? '#f0a629' : '#c27a00'),
    font: token('--mac-font', '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'),
    tones,
    neutral: tones[NEUTRAL_TONE],
    washAlpha: dark ? 0.09 : 0.06,
    ringAlpha: dark ? 0.24 : 0.16,
  };
}

// Branco ou tinta sobre um disco cheio, pelo contraste com o tom.
function inkOn(hex) {
  const value = hex.replace('#', '');
  const number = Number.parseInt(value, 16);
  const channel = (raw) => { const part = raw / 255; return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4; };
  const luminance = 0.2126 * channel((number >> 16) & 255) + 0.7152 * channel((number >> 8) & 255) + 0.0722 * channel(number & 255);
  return luminance > 0.42 ? '#1d1d1f' : '#ffffff';
}

export class DocGraphRenderer {
  constructor({ stats = null } = {}) {
    this.canvas = null;
    this.host = null;
    this.ctx = null;
    this.observer = null;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.theme = null;
    this.scene = { dirs: [], docs: [], links: [], index: new Map() };
    this.view = { x: 0, y: 0, s: 1 };
    this.state = { hover: null, selected: null, matches: null, keyboard: false, path: null };
    this.pending = false;
    this.raf = 0;
    this.timer = 0;
    this.docLabels = false;
    // Retangulos de tela cobertos pelo cartao e pela legenda: rotulo ali
    // embaixo so atrapalha a leitura do que esta por cima.
    this.occluded = [];
    this.widths = new Map();
    this.stats = stats;
    this.onResize = null;
  }

  attach(canvas, host, { onResize = null } = {}) {
    this.canvas = canvas;
    this.host = host;
    this.ctx = canvas.getContext('2d');
    this.onResize = onResize;
    this.theme = this.theme || readGraphTheme();
    this.observer = new ResizeObserver(() => { if (this.measure()) { this.onResize?.(this.width, this.height); this.drawNow(); } });
    this.observer.observe(host);
    this.stats?.on('observer');
    this.measure();
    this.drawNow();
  }

  detach() {
    this.cancelPending();
    this.observer?.disconnect();
    if (this.observer) this.stats?.off('observer');
    this.observer = null;
    // Largura e altura zeradas: o WebKit solta a memoria do canvas.
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; }
    this.canvas = null;
    this.ctx = null;
    this.host = null;
    this.onResize = null;
  }

  measure() {
    if (!this.canvas || !this.host) return false;
    const rect = this.host.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (width === this.width && height === this.height && dpr === this.dpr && this.canvas.width) return false;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    return true;
  }

  setTheme(theme) { this.theme = theme; this.widths.clear(); this.requestDraw(); }

  setScene(scene) { this.scene = scene; this.drawNow(); }

  setView(view) {
    if (!view || !Number.isFinite(view.x) || !Number.isFinite(view.y) || !Number.isFinite(view.s)) return;
    this.view = view;
    this.requestDraw();
  }

  setState(patch) { Object.assign(this.state, patch); this.requestDraw(); }

  setOccluded(rects) {
    const next = rects || [];
    const key = next.map((rect) => `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`).join(';');
    if (key === this.occludedKey) return;
    this.occludedKey = key;
    this.occluded = next;
    this.requestDraw();
  }

  cancelPending() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.timer) clearTimeout(this.timer);
    this.raf = 0;
    this.timer = 0;
    this.pending = false;
  }

  // Um desenho por quadro, no maximo. O prazo cobre o webview fora da tela,
  // onde o quadro de animacao nunca chega.
  requestDraw() {
    if (this.pending || !this.ctx) return;
    this.pending = true;
    this.stats?.count('rafRequested');
    const run = () => { this.cancelPending(); this.drawNow(); };
    this.raf = requestAnimationFrame(run);
    this.timer = setTimeout(run, DRAW_DEADLINE_MS);
  }

  /* ── geometria ──────────────────────────────────────────────────── */

  docPosition(doc) {
    const dir = this.scene.dirs[doc.dir].sim;
    return { x: dir.x + doc.dx, y: dir.y + doc.dy };
  }

  toWorld(sx, sy) {
    return { x: (sx - this.view.x) / this.view.s, y: (sy - this.view.y) / this.view.s };
  }

  toScreen(wx, wy) {
    return { x: wx * this.view.s + this.view.x, y: wy * this.view.s + this.view.y };
  }

  // A marca mais proxima do ponteiro. O alvo e maior que a marca: o raio mais
  // tres pontos, com doze de minimo, para um documento pequeno ser alcancavel.
  pick(sx, sy) {
    const started = this.stats ? performance.now() : 0;
    const scale = this.view.s;
    const world = this.toWorld(sx, sy);
    let best = null;
    let bestDistance = Infinity;
    const consider = (id, x, y, radius) => {
      const gap = Math.max(0, Math.hypot(world.x - x, world.y - y) - radius) * scale;
      const reach = Math.max(3, 12 - radius * scale);
      if (gap <= reach && gap < bestDistance) { bestDistance = gap; best = id; }
    };
    this.scene.dirs.forEach((dir) => consider(dir.id, dir.sim.x, dir.sim.y, dir.sim.hub));
    this.scene.docs.forEach((doc) => { const position = this.docPosition(doc); consider(doc.id, position.x, position.y, DOC_SIZE / 2); });
    if (this.stats) this.stats.sample('pickMs', performance.now() - started);
    return best;
  }

  // Centro e raio de um no, no espaco do mundo.
  locate(id) {
    const entry = this.scene.index.get(id);
    if (!entry) return null;
    if (entry.kind === 'dir') { const dir = this.scene.dirs[entry.at]; return { x: dir.sim.x, y: dir.sim.y, r: dir.sim.R }; }
    const position = this.docPosition(this.scene.docs[entry.at]);
    return { x: position.x, y: position.y, r: DOC_SIZE };
  }

  /* ── desenho ────────────────────────────────────────────────────── */

  drawNow() {
    const { ctx, theme } = this;
    if (!ctx || !theme || !this.canvas?.width) return;
    const started = this.stats ? performance.now() : 0;
    const { x: vx, y: vy, s } = this.view;
    const { dpr, width, height, scene, state } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!scene.dirs.length) { this.stats?.count('draws'); return; }

    // Janela visivel no mundo, com folga, para nao desenhar o que esta fora.
    const margin = 40 / s;
    const left = -vx / s - margin; const right = (width - vx) / s + margin;
    const top = -vy / s - margin; const bottom = (height - vy) / s + margin;
    const inside = (x, y, r) => x + r >= left && x - r <= right && y + r >= top && y - r <= bottom;
    const tone = (id) => (id && theme.tones[id]) || theme.neutral;
    const dim = state.matches;
    const lit = (id) => !dim || dim.has(id);

    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * vx, dpr * vy);
    const px = 1 / s;

    // Disco de fundo de cada pasta expandida com documentos.
    scene.dirs.forEach((dir) => {
      if (dir.sim.R <= dir.sim.hub + 1 || !inside(dir.sim.x, dir.sim.y, dir.sim.R)) return;
      ctx.beginPath();
      ctx.arc(dir.sim.x, dir.sim.y, dir.sim.R, 0, Math.PI * 2);
      ctx.fillStyle = rgba(tone(dir.tone), theme.washAlpha * (lit(dir.id) ? 1 : 0.5));
      ctx.fill();
    });

    // Ligacoes entre pastas.
    scene.links.forEach((link) => {
      const a = scene.dirs[link.source].sim; const b = scene.dirs[link.target].sim;
      if (!inside(a.x, a.y, 0) && !inside(b.x, b.y, 0) && !inside((a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y) / 2)) return;
      const onPath = state.path && state.path.has(scene.dirs[link.target].id);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineWidth = (onPath || link.depth <= 1 ? 1.5 : 1) * px;
      ctx.strokeStyle = onPath ? rgba(theme.dark ? '#f5f5f7' : '#1d1d1f', 0.55) : rgba(tone(link.tone), dim ? 0.18 : 0.38);
      ctx.stroke();
    });

    // Raios ate os documentos, so de perto e em pastas pequenas.
    if (s >= 0.9) {
      const spokes = new Map();
      scene.docs.forEach((doc) => { if (scene.dirs[doc.dir].docTotal <= 60) { if (!spokes.has(doc.dir)) spokes.set(doc.dir, []); spokes.get(doc.dir).push(doc); } });
      spokes.forEach((docs, at) => {
        const dir = scene.dirs[at];
        if (!inside(dir.sim.x, dir.sim.y, dir.sim.R)) return;
        ctx.beginPath();
        docs.forEach((doc) => { ctx.moveTo(dir.sim.x, dir.sim.y); ctx.lineTo(dir.sim.x + doc.dx, dir.sim.y + doc.dy); });
        ctx.lineWidth = 0.75 * px;
        ctx.strokeStyle = rgba(tone(dir.tone), 0.16);
        ctx.stroke();
      });
    }

    // Documentos: quadrado arredondado, retangulo simples quando fica pequeno
    // demais na tela, e nunca menor que um ponto e meio.
    const size = Math.max(DOC_SIZE, 1.5 * px);
    const half = size / 2;
    const rounded = DOC_SIZE * s >= 5;
    const folded = s >= 1.7;
    let fill = '';
    scene.docs.forEach((doc) => {
      const dir = scene.dirs[doc.dir].sim;
      const x = dir.x + doc.dx; const y = dir.y + doc.dy;
      if (!inside(x, y, half)) return;
      const next = rgba(tone(doc.tone), lit(doc.id) ? 1 : 0.28);
      if (next !== fill) { fill = next; ctx.fillStyle = fill; }
      if (rounded) {
        ctx.beginPath();
        if (folded) {
          const fold = size * 0.34;
          ctx.moveTo(x - half, y - half + 1.2);
          ctx.lineTo(x - half, y + half - 1.2);
          ctx.quadraticCurveTo(x - half, y + half, x - half + 1.2, y + half);
          ctx.lineTo(x + half - 1.2, y + half);
          ctx.quadraticCurveTo(x + half, y + half, x + half, y + half - 1.2);
          ctx.lineTo(x + half, y - half + fold);
          ctx.lineTo(x + half - fold, y - half);
          ctx.lineTo(x - half + 1.2, y - half);
          ctx.quadraticCurveTo(x - half, y - half, x - half, y - half + 1.2);
        } else {
          ctx.roundRect(x - half, y - half, size, size, 1.5);
        }
        ctx.fill();
      } else {
        ctx.fillRect(x - half, y - half, size, size);
      }
    });

    // Pastas e raiz, com anel na cor da superficie em vez de borda.
    scene.dirs.forEach((dir) => {
      const { x, y, hub } = dir.sim;
      if (!inside(x, y, hub + 8)) return;
      const alpha = lit(dir.id) ? 1 : 0.28;
      ctx.beginPath();
      ctx.arc(x, y, hub + 2 * px, 0, Math.PI * 2);
      ctx.fillStyle = theme.surface;
      ctx.fill();
      if (dir.kind === 'root') {
        ctx.beginPath();
        ctx.arc(x, y, hub, 0, Math.PI * 2);
        ctx.fillStyle = rgba(theme.dark ? '#f5f5f7' : '#1d1d1f', alpha);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, hub + 5, 0, Math.PI * 2);
        ctx.lineWidth = 1.5 * px;
        ctx.strokeStyle = theme.ink3;
        ctx.stroke();
      } else if (dir.expanded) {
        ctx.beginPath();
        ctx.arc(x, y, hub, 0, Math.PI * 2);
        ctx.fillStyle = rgba(tone(dir.tone), theme.ringAlpha * alpha);
        ctx.fill();
        ctx.lineWidth = 1.5 * px;
        ctx.strokeStyle = rgba(tone(dir.tone), alpha);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, hub, 0, Math.PI * 2);
        ctx.fillStyle = rgba(tone(dir.tone), alpha);
        ctx.fill();
      }
      if (dir.partial) {
        ctx.beginPath();
        ctx.arc(x + hub * 0.72, y - hub * 0.72, Math.max(3.5, 3.5 * px), 0, Math.PI * 2);
        ctx.fillStyle = theme.warn;
        ctx.fill();
      }
    });

    // Aneis de ponteiro, selecao e foco do teclado.
    const ring = (id, width, color, extra) => {
      const spot = id && this.locate(id);
      if (!spot) return;
      const entry = scene.index.get(id);
      const radius = (entry.kind === 'dir' ? scene.dirs[entry.at].sim.hub : DOC_SIZE * 0.75) + extra * px;
      ctx.beginPath();
      ctx.arc(spot.x, spot.y, radius, 0, Math.PI * 2);
      ctx.lineWidth = width * px;
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    if (state.hover && state.hover !== state.selected) ring(state.hover, 1.5, theme.ink2, 3);
    if (state.selected) {
      if (state.keyboard) ring(state.selected, 6, theme.accentRing, 5);
      ring(state.selected, 2, theme.accent, 3);
    }

    this.drawLabels(inside, lit);
    this.stats?.count('draws');
    if (this.stats) this.stats.sample('drawMs', performance.now() - started);
  }

  textWidth(text, font) {
    const key = `${font}|${text}`;
    let width = this.widths.get(key);
    if (width === undefined) {
      this.ctx.font = font;
      width = this.ctx.measureText(text).width;
      if (this.widths.size > 4000) this.widths.clear();
      this.widths.set(key, width);
    }
    return width;
  }

  // Rotulos em tamanho de tela constante, do mais importante para o menos, com
  // uma grade de ocupacao para nenhum cair em cima de outro. A grade e so a
  // fase larga: cada celula guarda os retangulos ja postos, e a recusa vem do
  // cruzamento real entre eles. Dividir uma celula sem se sobrepor nao derruba
  // o rotulo do vizinho.
  drawLabels(inside, lit) {
    const { ctx, theme, scene, state, dpr } = this;
    const s = this.view.s;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    // Histerese: os rotulos de documento entram em 1,15 e so saem abaixo de 1,05.
    if (s >= 1.15) this.docLabels = true; else if (s < 1.05) this.docLabels = false;

    const taken = new Map();
    const claim = (x, y, w, h, force) => {
      const x0 = Math.floor(x / CELL_W); const x1 = Math.floor((x + w) / CELL_W);
      const y0 = Math.floor(y / CELL_H); const y1 = Math.floor((y + h) / CELL_H);
      const cells = [];
      for (let cx = x0; cx <= x1; cx += 1) {
        for (let cy = y0; cy <= y1; cy += 1) {
          const key = cx * 4096 + cy;
          const placed = taken.get(key);
          if (!force && placed && placed.some((rect) => x < rect.x + rect.w && x + w > rect.x && y < rect.y + rect.h && y + h > rect.y)) return false;
          cells.push(key);
        }
      }
      // O rotulo forcado tambem ocupa o lugar dele, para os seguintes o respeitarem.
      const rect = { x, y, w, h };
      cells.forEach((key) => { const placed = taken.get(key); if (placed) placed.push(rect); else taken.set(key, [rect]); });
      return true;
    };
    let drawn = 0;
    const put = (text, sx, sy, { size, weight, color, align = 'center', force = false, count = null }) => {
      if (drawn >= LABEL_CAP && !force) return;
      const font = `${weight} ${size}px ${theme.font}`;
      const width = this.textWidth(text, font);
      // A contagem vai colada ao nome e ocupa espaco junto com ele.
      const countFont = count ? `400 ${Math.max(10.5, size - 1.5)}px ${theme.font}` : null;
      const span = count ? width + 5 + this.textWidth(count, countFont) : width;
      const x = align === 'center' ? sx - width / 2 : align === 'right' ? sx - span : sx;
      if (x + span < 0 || x > this.width || sy < -10 || sy > this.height + 10) return;
      if (this.occluded.some((rect) => x < rect.x + rect.w && x + span > rect.x && sy + size / 2 > rect.y && sy - size / 2 < rect.y + rect.h)) return;
      if (!claim(x - 2, sy - size / 2 - 1, span + 4, size + 2, force)) return;
      ctx.font = font;
      ctx.textAlign = 'left';
      ctx.lineWidth = 3;
      ctx.strokeStyle = theme.surface;
      ctx.strokeText(text, x, sy);
      ctx.fillStyle = color;
      ctx.fillText(text, x, sy);
      if (count) {
        ctx.font = countFont;
        ctx.strokeText(count, x + width + 5, sy);
        ctx.fillStyle = theme.ink3;
        ctx.fillText(count, x + width + 5, sy);
      }
      drawn += 1;
    };

    const dirLabel = (dir, force) => {
      const spot = this.toScreen(dir.sim.x, dir.sim.y);
      const root = dir.kind === 'root';
      put(dir.label, spot.x, spot.y + dir.sim.hub * s + (root ? 13 : 11), {
        size: root ? 13 : 12, weight: root ? 600 : 500, color: lit(dir.id) ? theme.ink : theme.ink3, force,
      });
    };
    // O rotulo do documento sai para fora da pasta: a esquerda dela ele cresce
    // para a esquerda, senao passaria por cima da marca da propria pasta.
    const docLabel = (doc, force) => {
      const position = this.docPosition(doc);
      const spot = this.toScreen(position.x, position.y);
      const gap = Math.max(6, DOC_SIZE * s * 0.5 + 4);
      const leftward = doc.dx < 0;
      put(doc.label, leftward ? spot.x - gap : spot.x + gap, spot.y, { size: 11, weight: 400, color: lit(doc.id) ? theme.ink2 : theme.ink3, align: leftward ? 'right' : 'left', force });
    };

    // A raiz e as marcas grandes reservam o proprio lugar, para rotulo nenhum
    // cair em cima delas: sao as que levam a contagem por dentro. Reservar
    // todas as pastas limpava as marcas, mas derrubava rotulos demais no
    // centro do grafo, inclusive o da raiz. Os documentos nao reservam: sao
    // muitos e pequenos, e o rotulo deles ja nasce ao lado da marca.
    scene.dirs.forEach((dir) => {
      if (!inside(dir.sim.x, dir.sim.y, dir.sim.hub)) return;
      const radius = dir.sim.hub * s + 1;
      if (dir.kind !== 'root' && radius < RESERVE_RADIUS) return;
      const spot = this.toScreen(dir.sim.x, dir.sim.y);
      claim(spot.x - radius, spot.y - radius, radius * 2, radius * 2, true);
    });

    // Total dentro do disco cheio de uma pasta recolhida.
    scene.dirs.forEach((dir) => {
      if (dir.kind === 'root' || dir.expanded || dir.sim.hub * s < 9 || !inside(dir.sim.x, dir.sim.y, dir.sim.hub)) return;
      const spot = this.toScreen(dir.sim.x, dir.sim.y);
      const text = badgeCount(dir.count);
      const size = Math.min(11, Math.max(8.5, dir.sim.hub * s * 0.72));
      ctx.font = `600 ${size}px ${theme.font}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = inkOn((theme.tones[dir.tone] || theme.neutral));
      ctx.globalAlpha = lit(dir.id) ? 1 : 0.4;
      ctx.fillText(text, spot.x, spot.y + 0.5);
      ctx.globalAlpha = 1;
    });

    // Primeiro o que o usuario esta olhando.
    const focus = new Set([state.selected, state.hover].filter(Boolean));
    focus.forEach((id) => {
      const entry = scene.index.get(id);
      if (!entry) return;
      if (entry.kind === 'dir') dirLabel(scene.dirs[entry.at], true); else docLabel(scene.docs[entry.at], true);
    });
    if (state.matches && state.matches.size <= 60) {
      state.matches.forEach((id) => {
        if (focus.has(id)) return;
        const entry = scene.index.get(id);
        if (!entry) return;
        if (entry.kind === 'dir') dirLabel(scene.dirs[entry.at], false); else docLabel(scene.docs[entry.at], false);
      });
    }
    const dirs = scene.dirs.filter((dir) => !focus.has(dir.id) && inside(dir.sim.x, dir.sim.y, dir.sim.hub));
    dirs.sort((a, b) => Number(b.kind === 'root') - Number(a.kind === 'root') || Number(b.groupRoot) - Number(a.groupRoot) || b.count - a.count);
    dirs.forEach((dir) => {
      const always = dir.kind === 'root' || dir.groupRoot;
      if (!always && s < 0.22) return;
      if (!always && s < 0.55 && dir.count < 12) return;
      dirLabel(dir, false);
    });
    if (this.docLabels) {
      scene.docs.forEach((doc) => {
        if (drawn >= LABEL_CAP || focus.has(doc.id)) return;
        const position = this.docPosition(doc);
        if (inside(position.x, position.y, DOC_SIZE)) docLabel(doc, false);
      });
    }
    this.stats?.sample('labels', drawn);
  }
}
