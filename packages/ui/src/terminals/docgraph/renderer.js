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
// anel vazado para expandida; a cor diz o que o modo de cor escolheu e nunca
// carrega a identidade sozinha. Texto sempre em token de texto, nunca na cor
// do grupo. Marcas com anel na cor da superficie em vez de borda.
//
// O Mapa tem o desenho de sempre, com as citacoes entre arquivos por cima das
// ligacoes de pasta. Arvore, Radial e Vizinhos passam por `drawLayout`, os
// Blocos por `drawBlocks` e o 3D por `drawSpace`, que projeta cada no a cada
// quadro. O acerto do ponteiro segue a vista da cena.

import { isDarkTheme } from '../theme.js';
import { badgeCount } from './copy.js';
import { paletteColors, toneColor } from './colors.js';
import { focalOf, project, rotationOf } from './space.js';
import { BLOCK_HEADER } from './views.js';

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

// So tokens da casca e a paleta escolhida, que sai da paleta compartilhada:
// o canvas nao define cor propria.
export function readGraphTheme(palette = 'safe') {
  const dark = isDarkTheme();
  const colors = paletteColors(palette, dark);
  return {
    dark,
    palette,
    surface: token('--mac-surface', dark ? '#1c1c1e' : '#ffffff'),
    ink: token('--mac-label', dark ? '#f5f5f7' : '#1d1d1f'),
    ink2: token('--mac-label-2', dark ? 'rgba(235,235,245,.62)' : '#6e6e73'),
    ink3: token('--mac-label-3', dark ? 'rgba(235,235,245,.40)' : '#a1a1a6'),
    accent: token('--mac-accent', dark ? '#4a8ae6' : '#1a4fa0'),
    accentRing: token('--mac-accent-ring', 'rgba(26,79,160,.18)'),
    warn: token('--mac-warn', dark ? '#f0a629' : '#c27a00'),
    font: token('--mac-font', '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'),
    colors,
    colorOf: (key) => toneColor(key, colors),
    neutral: colors.neutral,
    // Tinta das citacoes: neutra, para nao competir com a cor dos grupos.
    refInk: dark ? '#f5f5f7' : '#1d1d1f',
    washAlpha: dark ? 0.09 : 0.06,
    ringAlpha: dark ? 0.24 : 0.16,
  };
}

// Curva de uma citacao: sempre para o mesmo lado de quem vai de `a` para
// `b`, para duas citacoes entre os mesmos vizinhos nao se cruzarem.
function bend(ctx, ax, ay, bx, by) {
  const mx = (ax + bx) / 2; const my = (ay + by) / 2;
  const dx = bx - ax; const dy = by - ay;
  ctx.moveTo(ax, ay);
  ctx.quadraticCurveTo(mx - dy * 0.18, my + dx * 0.18, bx, by);
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

  // Posicao e id de uma entrada do indice do Mapa.
  entrySpot(entry) {
    if (entry.kind === 'dir') { const dir = this.scene.dirs[entry.at]; return { id: dir.id, x: dir.sim.x, y: dir.sim.y }; }
    const doc = this.scene.docs[entry.at];
    const position = this.docPosition(doc);
    return { id: doc.id, x: position.x, y: position.y };
  }

  toWorld(sx, sy) {
    return { x: (sx - this.view.x) / this.view.s, y: (sy - this.view.y) / this.view.s };
  }

  toScreen(wx, wy) {
    return { x: wx * this.view.s + this.view.x, y: wy * this.view.s + this.view.y };
  }

  isMap() {
    return !this.scene.mode || this.scene.mode === 'map';
  }

  // A marca mais proxima do ponteiro. O alvo e maior que a marca: o raio mais
  // tres pontos, com doze de minimo, para um documento pequeno ser alcancavel.
  pick(sx, sy) {
    if (!this.isMap()) return this.pickLayout(sx, sy);
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
    if (!this.isMap()) return this.locateLayout(entry.at);
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
    if (!this.isMap()) {
      if (scene.nodes?.length) {
        if (scene.mode === 'space') this.drawSpace();
        else if (scene.mode === 'blocks') this.drawBlocks();
        else this.drawLayout();
      }
      this.stats?.count('draws');
      if (this.stats) this.stats.sample('drawMs', performance.now() - started);
      return;
    }
    if (!scene.dirs?.length) { this.stats?.count('draws'); return; }

    // Janela visivel no mundo, com folga, para nao desenhar o que esta fora.
    const margin = 40 / s;
    const left = -vx / s - margin; const right = (width - vx) / s + margin;
    const top = -vy / s - margin; const bottom = (height - vy) / s + margin;
    const inside = (x, y, r) => x + r >= left && x - r <= right && y + r >= top && y - r <= bottom;
    const tone = (key) => theme.colorOf(key);
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

    // Citacoes entre arquivos, por cima das ligacoes de pasta. As que tocam a
    // selecao ganham a cor de acento.
    if (scene.refs?.length) {
      const hot = [];
      ctx.beginPath();
      scene.refs.forEach((ref) => {
        const a = this.entrySpot(ref.a); const b = this.entrySpot(ref.b);
        if (!inside(a.x, a.y, 0) && !inside(b.x, b.y, 0) && !inside((a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y) / 2)) return;
        if (state.selected && (a.id === state.selected || b.id === state.selected)) { hot.push([a, b]); return; }
        bend(ctx, a.x, a.y, b.x, b.y);
      });
      ctx.lineWidth = 0.9 * px;
      ctx.strokeStyle = rgba(theme.refInk, dim ? 0.06 : theme.dark ? 0.16 : 0.13);
      ctx.stroke();
      if (hot.length) {
        ctx.beginPath();
        hot.forEach(([a, b]) => bend(ctx, a.x, a.y, b.x, b.y));
        ctx.lineWidth = 1.5 * px;
        ctx.strokeStyle = theme.accent;
        ctx.globalAlpha = 0.85;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
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

  /* ── outras vistas ──────────────────────────────────────────────── */

  // Teste de visibilidade no mundo, com folga em pixels de tela.
  worldWindow(margin = 40) {
    const { x: vx, y: vy, s } = this.view;
    const pad = margin / s;
    const left = -vx / s - pad; const right = (this.width - vx) / s + pad;
    const top = -vy / s - pad; const bottom = (this.height - vy) / s + pad;
    return (x, y, r) => x + r >= left && x - r <= right && y + r >= top && y - r <= bottom;
  }

  // Raio de mundo de uma marca fora do Mapa. Pasta recolhida cresce devagar
  // com o total, como o disco do Mapa.
  markRadius(node) {
    if (node.kind === 'root') return 9;
    if (node.kind === 'doc') return node.focus ? 6.5 : DOC_SIZE / 2;
    if (node.expanded) return 5.5;
    return Math.min(11, 4.5 + 1.3 * Math.log2(1 + node.count));
  }

  drawMark(node, x, y, r, alpha, px) {
    const { ctx, theme } = this;
    const color = theme.colorOf(node.tone);
    if (node.kind === 'doc') {
      const size = Math.max(r * 2, 1.5 * px);
      ctx.beginPath();
      if (size / px >= 5) ctx.roundRect(x - size / 2, y - size / 2, size, size, Math.min(1.5, size / 4)); else ctx.rect(x - size / 2, y - size / 2, size, size);
      ctx.fillStyle = rgba(color, alpha);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.arc(x, y, r + 2 * px, 0, Math.PI * 2);
    ctx.fillStyle = theme.surface;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (node.kind === 'root') {
      ctx.fillStyle = rgba(theme.dark ? '#f5f5f7' : '#1d1d1f', alpha);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r * 1.45, 0, Math.PI * 2);
      ctx.lineWidth = 1.5 * px;
      ctx.strokeStyle = theme.ink3;
      ctx.stroke();
    } else if (node.expanded) {
      ctx.fillStyle = rgba(color, theme.ringAlpha * alpha);
      ctx.fill();
      ctx.lineWidth = 1.5 * px;
      ctx.strokeStyle = rgba(color, alpha);
      ctx.stroke();
    } else {
      ctx.fillStyle = rgba(color, alpha);
      ctx.fill();
    }
    if (node.partial) {
      ctx.beginPath();
      ctx.arc(x + r * 0.72, y - r * 0.72, Math.max(3, 3 * px), 0, Math.PI * 2);
      ctx.fillStyle = theme.warn;
      ctx.fill();
    }
  }

  // Ligacao da hierarquia: curva horizontal na Arvore, curva radial no
  // Radial e reta nos Vizinhos.
  traceEdge(a, b, mode) {
    const { ctx } = this;
    const ax = a.pos.x; const ay = a.pos.y; const bx = b.pos.x; const by = b.pos.y;
    ctx.moveTo(ax, ay);
    if (mode === 'tree') {
      const mx = (ax + bx) / 2;
      ctx.bezierCurveTo(mx, ay, mx, by, bx, by);
    } else if (mode === 'radial' && Number.isFinite(a.radius) && Number.isFinite(b.radius)) {
      const mid = (a.radius + b.radius) / 2;
      ctx.bezierCurveTo(mid * Math.cos(a.angle), mid * Math.sin(a.angle), mid * Math.cos(b.angle), mid * Math.sin(b.angle), bx, by);
    } else {
      ctx.lineTo(bx, by);
    }
  }

  // Citacoes por cima da hierarquia, com as da selecao em acento. `spot`
  // devolve a posicao de um no pelo indice.
  drawRefs(spot, inside, px) {
    const { ctx, theme, scene, state } = this;
    const hot = [];
    ctx.beginPath();
    scene.refs.forEach((ref) => {
      const a = spot(ref.source); const b = spot(ref.target);
      if (!inside(a.x, a.y, 0) && !inside(b.x, b.y, 0) && !inside((a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y) / 2)) return;
      const ids = [scene.nodes[ref.source].id, scene.nodes[ref.target].id];
      if (state.selected && ids.includes(state.selected)) { hot.push([a, b]); return; }
      bend(ctx, a.x, a.y, b.x, b.y);
    });
    ctx.lineWidth = 0.9 * px;
    ctx.strokeStyle = rgba(theme.refInk, state.matches ? 0.06 : theme.dark ? 0.16 : 0.13);
    ctx.stroke();
    if (!hot.length) return;
    ctx.beginPath();
    hot.forEach(([a, b]) => bend(ctx, a.x, a.y, b.x, b.y));
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = theme.accent;
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawRings(px) {
    const { ctx, theme, state, scene } = this;
    const ring = (id, width, color, extra) => {
      const entry = id && scene.index.get(id);
      if (!entry) return;
      const spot = this.locateLayout(entry.at);
      ctx.beginPath();
      ctx.arc(spot.x, spot.y, spot.r + extra * px, 0, Math.PI * 2);
      ctx.lineWidth = width * px;
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    if (scene.focus && scene.focus !== state.selected) ring(scene.focus, 1.5, theme.ink3, 4);
    if (state.hover && state.hover !== state.selected) ring(state.hover, 1.5, theme.ink2, 3);
    if (state.selected) {
      if (state.keyboard) ring(state.selected, 6, theme.accentRing, 5);
      ring(state.selected, 2, theme.accent, 3);
    }
  }

  // Arvore, Radial e Vizinhos.
  drawLayout() {
    const { ctx, theme, scene, state, dpr } = this;
    const { x: vx, y: vy, s } = this.view;
    const px = 1 / s;
    const inside = this.worldWindow();
    const lit = (id) => !state.matches || state.matches.has(id);
    const nodes = scene.nodes;
    const mode = scene.mode;
    const neighbors = mode === 'neighbors';
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * vx, dpr * vy);

    // Ligacoes, agrupadas por tom para trocar de cor o minimo. O caminho ate
    // a selecao e as citacoes da selecao ficam por cima.
    const groups = new Map();
    const strong = [];
    scene.edges.forEach((edge) => {
      const a = nodes[edge.source]; const b = nodes[edge.target];
      if (!inside(a.pos.x, a.pos.y, 0) && !inside(b.pos.x, b.pos.y, 0) && !inside((a.pos.x + b.pos.x) / 2, (a.pos.y + b.pos.y) / 2, Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) / 2)) return;
      const touched = neighbors ? state.selected && (a.id === state.selected || b.id === state.selected) : state.path && state.path.has(a.id) && state.path.has(b.id);
      if (touched) { strong.push(edge); return; }
      const key = neighbors ? '' : b.tone || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(edge);
    });
    const trace = (edge) => this.traceEdge(nodes[edge.source], nodes[edge.target], mode);
    groups.forEach((edges, key) => {
      ctx.beginPath();
      edges.forEach(trace);
      ctx.lineWidth = px;
      ctx.strokeStyle = neighbors ? rgba(theme.refInk, state.matches ? 0.1 : 0.28) : rgba(theme.colorOf(key || null), state.matches ? 0.16 : 0.42);
      ctx.stroke();
    });
    if (strong.length) {
      ctx.beginPath();
      strong.forEach(trace);
      ctx.lineWidth = 1.5 * px;
      if (neighbors) { ctx.strokeStyle = theme.accent; ctx.globalAlpha = 0.85; } else ctx.strokeStyle = rgba(theme.refInk, 0.55);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Setas nos Vizinhos: de quem cita para quem e citado.
    if (neighbors && s >= 0.45) {
      ctx.beginPath();
      scene.edges.forEach((edge) => {
        const a = nodes[edge.source]; const b = nodes[edge.target];
        const dx = b.pos.x - a.pos.x; const dy = b.pos.y - a.pos.y;
        const length = Math.hypot(dx, dy);
        if (length < 1 || !inside(b.pos.x, b.pos.y, 12)) return;
        const ux = dx / length; const uy = dy / length;
        const tip = this.markRadius(b) + 2.5;
        const tx = b.pos.x - ux * tip; const ty = b.pos.y - uy * tip;
        const size = 5;
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - ux * size - uy * size * 0.55, ty - uy * size + ux * size * 0.55);
        ctx.lineTo(tx - ux * size + uy * size * 0.55, ty - uy * size - ux * size * 0.55);
        ctx.closePath();
      });
      ctx.fillStyle = rgba(theme.refInk, 0.42);
      ctx.fill();
    }
    if (scene.refs?.length) this.drawRefs((at) => nodes[at].pos, inside, px);

    // Marcas: arquivos primeiro, pastas por cima.
    nodes.forEach((node) => {
      if (node.kind === 'doc' && inside(node.pos.x, node.pos.y, 8)) this.drawMark(node, node.pos.x, node.pos.y, this.markRadius(node), lit(node.id) ? 1 : 0.28, px);
    });
    nodes.forEach((node) => {
      if (node.kind !== 'doc' && inside(node.pos.x, node.pos.y, 14)) this.drawMark(node, node.pos.x, node.pos.y, this.markRadius(node), lit(node.id) ? 1 : 0.28, px);
    });
    this.drawRings(px);
    this.drawLayoutLabels(inside, lit);
  }

  // Corta o texto com reticencias ate caber. Sem espaco nem para tres
  // letras, nada.
  fitText(text, font, room) {
    if (this.textWidth(text, font) <= room) return text;
    let end = text.length - 1;
    while (end >= 3) {
      const candidate = `${text.slice(0, end)}…`;
      if (this.textWidth(candidate, font) <= room) return candidate;
      end -= Math.max(1, Math.floor((end - 3) / 4));
    }
    return null;
  }

  // Blocos: retangulos com area proporcional aos bytes. Pasta aberta e uma
  // moldura com o nome na faixa de cima; arquivo e pasta recolhida sao
  // blocos cheios. O vao de dois pontos entre blocos e a superficie.
  drawBlocks() {
    const { ctx, theme, scene, state, dpr } = this;
    const { x: vx, y: vy, s } = this.view;
    const px = 1 / s;
    const inside = this.worldWindow(0);
    const lit = (id) => !state.matches || state.matches.has(id);
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * vx, dpr * vy);
    scene.nodes.forEach((node) => {
      const r = node.rect;
      const w = r.x1 - r.x0; const h = r.y1 - r.y0;
      if (w <= 0 || h <= 0 || !inside((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, Math.max(w, h) / 2)) return;
      const color = theme.colorOf(node.tone);
      const alpha = lit(node.id) ? 1 : 0.3;
      ctx.beginPath();
      ctx.roundRect(r.x0, r.y0, w, h, Math.min(3, w / 4, h / 4));
      if (node.kind === 'doc') {
        ctx.fillStyle = rgba(color, 0.85 * alpha);
        ctx.fill();
      } else if (node.open) {
        if (node.kind === 'root') return;
        ctx.fillStyle = rgba(color, theme.washAlpha * 1.6 * alpha);
        ctx.fill();
        ctx.lineWidth = px;
        ctx.strokeStyle = rgba(color, 0.4 * alpha);
        ctx.stroke();
      } else {
        ctx.fillStyle = rgba(color, 0.42 * alpha);
        ctx.fill();
        ctx.lineWidth = 1.5 * px;
        ctx.strokeStyle = rgba(color, 0.95 * alpha);
        ctx.stroke();
      }
    });
    const outline = (id, width, color) => {
      const entry = id && scene.index.get(id);
      if (!entry) return;
      const r = scene.nodes[entry.at].rect;
      ctx.beginPath();
      ctx.roundRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, 3);
      ctx.lineWidth = width * px;
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    if (state.hover && state.hover !== state.selected) outline(state.hover, 1.5, theme.ink2);
    if (state.selected) {
      if (state.keyboard) outline(state.selected, 5, theme.accentRing);
      outline(state.selected, 2, theme.accent);
    }

    // Nomes dentro das caixas, em pixels de tela, so quando cabem. Pasta
    // recolhida leva o total na linha de baixo.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let drawn = 0;
    scene.nodes.forEach((node) => {
      if (drawn >= LABEL_CAP * 3 || (node.open && !node.header)) return;
      const r = node.rect;
      const x0 = r.x0 * s + vx; const y0 = r.y0 * s + vy;
      const w = (r.x1 - r.x0) * s; const h = (r.y1 - r.y0) * s;
      if (x0 > this.width || y0 > this.height || x0 + w < 0 || y0 + h < 0) return;
      const header = node.open;
      if (header ? BLOCK_HEADER * s < 11 || w < 40 : w < 34 || h < 16) return;
      const size = node.kind === 'root' ? 12 : 11;
      const font = `${node.kind === 'doc' ? 400 : 600} ${size}px ${theme.font}`;
      const text = this.fitText(node.label, font, w - 8);
      if (!text) return;
      let ink = theme.ink2;
      if (node.kind === 'doc') ink = inkOn(theme.colorOf(node.tone));
      else if (!header) ink = theme.ink;
      ctx.font = font;
      ctx.fillStyle = ink;
      ctx.globalAlpha = lit(node.id) ? 1 : 0.45;
      ctx.fillText(text, x0 + 4, header ? y0 + Math.min(BLOCK_HEADER * s, 18) / 2 + 1 : y0 + 9);
      if (!header && node.kind !== 'doc' && h >= 30) {
        ctx.font = `400 10.5px ${theme.font}`;
        ctx.fillStyle = theme.ink2;
        ctx.fillText(badgeCount(node.count), x0 + 4, y0 + 22);
      }
      ctx.globalAlpha = 1;
      drawn += 1;
    });
  }

  // Posicoes projetadas da cena 3D, refeitas a cada desenho.
  projectSpace() {
    const scene = this.scene;
    const nodes = scene.nodes;
    let extent = 60;
    nodes.forEach((node) => { const value = Math.hypot(node.pos.x || 0, node.pos.y || 0, node.pos.z || 0); if (value > extent) extent = value; });
    const rotation = rotationOf(scene.orbit);
    const focal = focalOf(extent);
    const projected = new Array(nodes.length);
    for (let at = 0; at < nodes.length; at += 1) {
      const pos = nodes[at].pos;
      projected[at] = project(pos.x || 0, pos.y || 0, pos.z || 0, rotation, focal);
    }
    this.projected = projected;
    this.projectedFor = scene;
    this.spaceDepth = extent;
    return projected;
  }

  // 3D: projeta, desenha do mais longe para o mais perto e apaga um pouco o
  // que esta no fundo.
  drawSpace() {
    const { ctx, theme, scene, state, dpr } = this;
    const { x: vx, y: vy, s } = this.view;
    const px = 1 / s;
    const projected = this.projectSpace();
    const inside = this.worldWindow();
    const lit = (id) => !state.matches || state.matches.has(id);
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * vx, dpr * vy);
    const groups = new Map();
    scene.edges.forEach((edge) => {
      const key = scene.nodes[edge.target].tone || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(edge);
    });
    groups.forEach((edges, key) => {
      ctx.beginPath();
      edges.forEach((edge) => { const a = projected[edge.source]; const b = projected[edge.target]; ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); });
      ctx.lineWidth = px;
      ctx.strokeStyle = rgba(theme.colorOf(key || null), state.matches ? 0.12 : 0.3);
      ctx.stroke();
    });
    if (scene.refs?.length) this.drawRefs((at) => projected[at], inside, px);
    const extent = this.spaceDepth || 1;
    const order = projected.map((_, at) => at).sort((a, b) => projected[b].depth - projected[a].depth);
    order.forEach((at) => {
      const spot = projected[at];
      if (!inside(spot.x, spot.y, 16)) return;
      const node = scene.nodes[at];
      const fog = Math.min(1, Math.max(0.35, 1 - (0.65 * (spot.depth + extent)) / (2 * extent)));
      this.drawMark(node, spot.x, spot.y, this.markRadius(node) * spot.k, fog * (lit(node.id) ? 1 : 0.3), px);
    });
    this.drawRings(px);
    this.drawLayoutLabels(inside, lit);
  }

  // Rotulos das vistas fora do Mapa, do mais importante para o menos: o que o
  // usuario olha, a busca, a raiz, os grupos, as pastas por total e, de
  // perto, os arquivos. No 3D o mais perto vem antes.
  drawLayoutLabels(inside, lit) {
    const { theme, scene, state } = this;
    const s = this.view.s;
    const mode = scene.mode;
    const nodes = scene.nodes;
    const labels = this.labeler();
    const docMin = mode === 'tree' ? 0.75 : mode === 'radial' ? 0.85 : mode === 'neighbors' ? 0.45 : 1.1;
    const dirMin = mode === 'neighbors' ? 0 : mode === 'space' ? 0.55 : 0.3;
    const place = (at, force) => {
      const node = nodes[at];
      const spot = this.locateLayout(at);
      if (!inside(spot.x, spot.y, spot.r)) return;
      const screen = this.toScreen(spot.x, spot.y);
      const r = spot.r * s;
      const isDir = node.kind !== 'doc';
      const options = {
        size: node.kind === 'root' ? 13 : isDir ? 12 : 11,
        weight: node.kind === 'root' || node.focus ? 600 : isDir ? 500 : 400,
        color: lit(node.id) ? (isDir || node.focus ? theme.ink : theme.ink2) : theme.ink3,
        force,
      };
      const side = mode === 'tree' || mode === 'radial' ? node.side : 'below';
      if (side === 'left') labels.put(node.label, screen.x - r - 6, screen.y, { ...options, align: 'right' });
      else if (side === 'right') labels.put(node.label, screen.x + r + 6, screen.y, { ...options, align: 'left' });
      else if (!labels.put(node.label, screen.x, screen.y + r + (node.kind === 'root' ? 13 : 10), options) && (mode === 'neighbors' || mode === 'space')) {
        // Nos Vizinhos e no 3D ha poucos nomes e cada um conta: sem lugar
        // embaixo, o rotulo tenta a direita, a esquerda e em cima.
        const placed = labels.put(node.label, screen.x + r + 6, screen.y, { ...options, align: 'left' })
          || labels.put(node.label, screen.x - r - 6, screen.y, { ...options, align: 'right' });
        if (!placed) labels.put(node.label, screen.x, screen.y - r - 10, options);
      }
    };
    const first = new Set([state.selected, state.hover, scene.focus].filter(Boolean));
    first.forEach((id) => { const entry = scene.index.get(id); if (entry) place(entry.at, true); });
    if (state.matches && state.matches.size <= 60) {
      state.matches.forEach((id) => { if (first.has(id)) return; const entry = scene.index.get(id); if (entry) place(entry.at, false); });
    }
    const ranked = [];
    nodes.forEach((node, at) => {
      if (first.has(node.id)) return;
      let rank;
      if (node.kind === 'root') rank = 3e9;
      else if (node.groupRoot) rank = 2e9 + node.count;
      else if (node.kind !== 'doc') { if (s < dirMin) return; rank = 1e9 + node.count; }
      else { if (s < docMin) return; rank = 0; }
      if (mode === 'space' && this.projected?.[at]) rank -= this.projected[at].depth;
      ranked.push([at, rank]);
    });
    ranked.sort((a, b) => b[1] - a[1]);
    for (const [at] of ranked) {
      if (labels.drawn() >= LABEL_CAP) break;
      place(at, false);
    }
    this.stats?.sample('labels', labels.drawn());
  }

  // Centro, raio e, no 3D, profundidade de um no fora do Mapa, no espaco do
  // mundo. No 3D o mundo e a cena ja projetada.
  locateLayout(at) {
    const scene = this.scene;
    const node = scene.nodes[at];
    if (!node) return null;
    if (scene.mode === 'space') {
      const projected = this.projectedFor === scene && this.projected?.length === scene.nodes.length ? this.projected : this.projectSpace();
      const spot = projected[at];
      return { x: spot.x, y: spot.y, r: this.markRadius(node) * spot.k, depth: spot.depth };
    }
    if (scene.mode === 'blocks') {
      const r = node.rect;
      return { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2, r: Math.max(4, Math.min(r.x1 - r.x0, r.y1 - r.y0) / 2) };
    }
    return { x: node.pos.x, y: node.pos.y, r: this.markRadius(node) };
  }

  pickLayout(sx, sy) {
    const started = this.stats ? performance.now() : 0;
    const scene = this.scene;
    if (!scene.nodes?.length) return null;
    const world = this.toWorld(sx, sy);
    let best = null;
    if (scene.mode === 'blocks') {
      // A caixa mais funda que contem o ponto. A lista vem em largura, entao
      // de tras para a frente o primeiro acerto e o mais fundo.
      for (let at = scene.nodes.length - 1; at >= 0; at -= 1) {
        const r = scene.nodes[at].rect;
        if (world.x >= r.x0 && world.x <= r.x1 && world.y >= r.y0 && world.y <= r.y1) { best = scene.nodes[at].id; break; }
      }
    } else {
      const scale = this.view.s;
      let bestGap = Infinity;
      let bestDepth = Infinity;
      scene.nodes.forEach((node, at) => {
        const spot = this.locateLayout(at);
        const gap = Math.max(0, Math.hypot(world.x - spot.x, world.y - spot.y) - spot.r) * scale;
        const reach = Math.max(3, 12 - spot.r * scale);
        if (gap > reach) return;
        const depth = spot.depth ?? 0;
        // No 3D, entre alvos igualmente perto do ponteiro, vale o da frente.
        if (gap < bestGap - 0.5 || (Math.abs(gap - bestGap) <= 0.5 && depth < bestDepth)) { best = node.id; bestGap = gap; bestDepth = depth; }
      });
    }
    if (this.stats) this.stats.sample('pickMs', performance.now() - started);
    return best;
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

  // Rotulos em tamanho de tela constante, com uma grade de ocupacao para
  // nenhum cair em cima de outro. A grade e so a fase larga: cada celula
  // guarda os retangulos ja postos, e a recusa vem do cruzamento real entre
  // eles. Dividir uma celula sem se sobrepor nao derruba o rotulo do vizinho.
  // Serve ao Mapa e as outras vistas.
  labeler() {
    const { ctx, theme, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
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
    // Devolve verdadeiro quando desenhou, para quem chama tentar outro lugar.
    const put = (text, sx, sy, { size, weight, color, align = 'center', force = false, count = null }) => {
      if (drawn >= LABEL_CAP && !force) return false;
      const font = `${weight} ${size}px ${theme.font}`;
      const width = this.textWidth(text, font);
      // A contagem vai colada ao nome e ocupa espaco junto com ele.
      const countFont = count ? `400 ${Math.max(10.5, size - 1.5)}px ${theme.font}` : null;
      const span = count ? width + 5 + this.textWidth(count, countFont) : width;
      const x = align === 'center' ? sx - width / 2 : align === 'right' ? sx - span : sx;
      if (x + span < 0 || x > this.width || sy < -10 || sy > this.height + 10) return false;
      if (this.occluded.some((rect) => x < rect.x + rect.w && x + span > rect.x && sy + size / 2 > rect.y && sy - size / 2 < rect.y + rect.h)) return false;
      if (!claim(x - 2, sy - size / 2 - 1, span + 4, size + 2, force)) return false;
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
      return true;
    };
    return { claim, put, drawn: () => drawn };
  }

  drawLabels(inside, lit) {
    const { ctx, theme, scene, state } = this;
    const s = this.view.s;
    // Histerese: os rotulos de documento entram em 1,15 e so saem abaixo de 1,05.
    if (s >= 1.15) this.docLabels = true; else if (s < 1.05) this.docLabels = false;
    const labels = this.labeler();
    const { claim, put } = labels;

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
      ctx.fillStyle = inkOn(theme.colorOf(dir.tone));
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
        if (labels.drawn() >= LABEL_CAP || focus.has(doc.id)) return;
        const position = this.docPosition(doc);
        if (inside(position.x, position.y, DOC_SIZE)) docLabel(doc, false);
      });
    }
    this.stats?.sample('labels', labels.drawn());
  }
}
