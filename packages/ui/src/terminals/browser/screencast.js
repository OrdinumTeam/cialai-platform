// SPDX-License-Identifier: Apache-2.0
// Screencast da aba ativa num canvas: pede ao Chromium quadros JPEG do
// tamanho do painel, desenha com ajuste de proporcao e devolve o
// mapeamento de coordenadas para a entrada. Sem painel visivel nao ha
// screencast: com varias sessoes, so a exibida gasta CPU.
//
// Decodificacao por createImageBitmap a partir de um Blob, fora da thread
// principal; um quadro que chega enquanto outro decodifica substitui o
// pendente, nunca enfileira.

const RESIZE_DEBOUNCE_MS = 150;
const RESTART_THRESHOLD_PX = 50;
const JPEG_QUALITY = 85;

function base64ToBytes(text) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export class Screencast {
  constructor({ cdp, session }) {
    this.cdp = cdp;
    this.session = session;
    this.canvas = null;
    this.ctx = null;
    this.observer = null;
    this.resizeTimer = null;
    this.visible = false;
    this.cssWidth = 0;
    this.cssHeight = 0;
    this.dpr = 1;
    this.pageW = 0;
    this.pageH = 0;
    this.dest = null;
    this.lastBitmap = null;
    this.decoding = false;
    this.pendingFrame = null;
    this.activeSessionId = null;
    this.streamKey = '';
    this.streamMaxW = 0;
    this.streamMaxH = 0;
    this.offFrame = cdp.on('Page.screencastFrame', (event) => this.onFrame(event));
    this.offActive = session.on('active-changed', () => { this.switchTarget(); });
    this.offAttached = session.on('attached', () => { this.switchTarget(); });
  }

  attach(canvas) {
    this.detach();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.observer = new ResizeObserver(() => this.onResize());
    this.observer.observe(canvas);
    this.onResize({ immediate: true });
  }

  detach() {
    if (this.observer) { this.observer.disconnect(); this.observer = null; }
    if (this.resizeTimer) { clearTimeout(this.resizeTimer); this.resizeTimer = null; }
    this.canvas = null;
    this.ctx = null;
  }

  setVisible(visible) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) this.apply().catch(() => {});
    else this.stop().catch(() => {});
  }

  measure() {
    const canvas = this.canvas;
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    if (width <= 0 || height <= 0) return false;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const changed = width !== this.cssWidth || height !== this.cssHeight || dpr !== this.dpr;
    this.cssWidth = width;
    this.cssHeight = height;
    this.dpr = dpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    if (this.ctx) {
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';
    }
    this.redraw();
    return changed;
  }

  onResize({ immediate = false } = {}) {
    if (!this.measure() && !immediate) return;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.apply().catch(() => {});
    }, immediate ? 0 : RESIZE_DEBOUNCE_MS);
  }

  async switchTarget() {
    const next = this.session.activeSessionId();
    if (next === this.activeSessionId) return;
    if (this.activeSessionId) await this.cdp.send('Page.stopScreencast', {}, this.activeSessionId).catch(() => {});
    this.activeSessionId = next;
    this.streamKey = '';
    this.lastBitmap = null;
    this.redraw();
    await this.apply();
  }

  // Metricas do dispositivo pelo tamanho do painel e screencast so quando a
  // chave muda ou o painel cresceu mais que o limiar.
  async apply() {
    const sessionId = this.session.activeSessionId();
    this.activeSessionId = sessionId;
    if (!sessionId || !this.visible || !this.canvas || this.cssWidth <= 0) return;
    const { cssWidth, cssHeight, dpr } = this;
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: cssWidth, height: cssHeight, deviceScaleFactor: dpr, mobile: false }, sessionId).catch(() => {});
    const maxW = Math.round(cssWidth * dpr);
    const maxH = Math.round(cssHeight * dpr);
    const key = `${sessionId}|${dpr}`;
    const grew = maxW - this.streamMaxW > RESTART_THRESHOLD_PX || maxH - this.streamMaxH > RESTART_THRESHOLD_PX;
    if (key === this.streamKey && !grew) return;
    this.streamKey = key;
    this.streamMaxW = Math.max(maxW, this.streamMaxW);
    this.streamMaxH = Math.max(maxH, this.streamMaxH);
    await this.cdp.send('Page.stopScreencast', {}, sessionId).catch(() => {});
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: JPEG_QUALITY, everyNthFrame: 1, maxWidth: this.streamMaxW, maxHeight: this.streamMaxH }, sessionId).catch(() => {});
  }

  async stop() {
    const sessionId = this.activeSessionId;
    this.streamKey = '';
    this.streamMaxW = 0;
    this.streamMaxH = 0;
    if (sessionId) await this.cdp.send('Page.stopScreencast', {}, sessionId).catch(() => {});
  }

  onFrame(event) {
    if (event.sessionId !== this.activeSessionId) return;
    const params = event.params;
    // Confirmar na hora: sem o ack o Chromium para de mandar quadros.
    if (typeof params.sessionId === 'number') {
      this.cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, event.sessionId).catch(() => {});
    }
    if (params.metadata?.deviceWidth) this.pageW = params.metadata.deviceWidth;
    if (params.metadata?.deviceHeight) this.pageH = params.metadata.deviceHeight;
    this.pendingFrame = params.data;
    if (!this.decoding) this.decodeNext();
  }

  async decodeNext() {
    const data = this.pendingFrame;
    this.pendingFrame = null;
    if (!data) return;
    this.decoding = true;
    try {
      const bitmap = await createImageBitmap(new Blob([base64ToBytes(data)], { type: 'image/jpeg' }));
      if (this.lastBitmap && typeof this.lastBitmap.close === 'function') this.lastBitmap.close();
      this.lastBitmap = bitmap;
      this.redraw();
    } catch (_error) {
      // Quadro corrompido: o proximo substitui.
    } finally {
      this.decoding = false;
      if (this.pendingFrame) this.decodeNext();
    }
  }

  redraw() {
    const { canvas, ctx } = this;
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const bitmap = this.lastBitmap;
    if (!bitmap) { this.dest = null; return; }
    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
    const dw = Math.max(1, Math.round(bitmap.width * scale));
    const dh = Math.max(1, Math.round(bitmap.height * scale));
    const dx = Math.round((canvas.width - dw) / 2);
    const dy = Math.round((canvas.height - dh) / 2);
    this.dest = { dx, dy, dw, dh };
    ctx.drawImage(bitmap, dx, dy, dw, dh);
  }

  hasFrame() {
    return Boolean(this.lastBitmap);
  }

  // Coordenadas CSS da pagina, o espaco que Input.dispatchMouseEvent espera,
  // a partir de um evento de mouse no canvas.
  toPageCoords(event) {
    const canvas = this.canvas;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;
    const dest = this.dest;
    if (!dest || !this.pageW || !this.pageH || rect.width === 0 || rect.height === 0) return { x: cssX, y: cssY };
    const ratio = canvas.width / rect.width;
    const px = ((cssX * ratio) - dest.dx) / dest.dw * this.pageW;
    const py = ((cssY * ratio) - dest.dy) / dest.dh * this.pageH;
    return { x: Math.max(0, Math.min(this.pageW, px)), y: Math.max(0, Math.min(this.pageH, py)) };
  }

  dispose() {
    this.detach();
    this.offFrame?.();
    this.offActive?.();
    this.offAttached?.();
    if (this.lastBitmap && typeof this.lastBitmap.close === 'function') this.lastBitmap.close();
    this.lastBitmap = null;
  }
}
