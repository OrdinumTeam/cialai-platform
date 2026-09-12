// SPDX-License-Identifier: Apache-2.0
// One server-owned lease per PTY. Measurements never acquire control.
//
// `repeat` e `cancel` viram propriedades da instancia e sao chamados como
// metodo. Guardar `setInterval` cru aqui faria o WebKit recebe-lo com `this`
// errado e recusar: "Can only call Window.setInterval on instances of
// Window". Por isso os padroes embrulham a chamada no `window`.
const repeatOnWindow = (callback, ms) => window.setInterval(callback, ms);
const cancelOnWindow = (timer) => window.clearInterval(timer);
const sameSize = (a, b) => Boolean(a && b) && a.cols === b.cols && a.rows === b.rows;

export class TerminalViewport {
  constructor({ id, invoke, apply, changed, repeat = repeatOnWindow, cancel = cancelOnWindow }) {
    Object.assign(this, { id, invoke, apply, changed, repeat, cancel });
    this.latest = null;
    this.leaseId = null;
    this.epoch = 0;
    this.timer = null;
    this.pending = null;
    this.invalidated = false;
  }

  get owned() { return this.leaseId != null && this.latest?.leaseId === this.leaseId; }

  stop() { if (this.timer != null) this.cancel(this.timer); this.timer = null; }

  receive(view) {
    if (this.invalidated || !view || view.id !== this.id || view.revision <= (this.latest?.revision ?? -1)) return;
    this.latest = view;
    if (!this.owned) { this.leaseId = null; this.stop(); }
    this.apply(view);
    this.changed();
  }

  async claim(size) {
    if (this.invalidated) return;
    // Toque no terminal ja proprio e do mesmo tamanho: nada a renovar. O
    // heartbeat mantem a concessao; sem isto cada arrasto ia ao servidor.
    if (this.owned && sameSize(this.size, size)) return;
    this.size = size;
    if (this.owned) return this.resize(size);
    if (this.pending) return this.pending;
    const epoch = this.epoch;
    const pending = this.invoke('pty_view_claim', { id: this.id, ...size }).then(async (view) => {
      if (this.invalidated) return;
      if (epoch !== this.epoch) {
        await this.invoke('pty_view_release', { id: this.id, leaseId: view.leaseId }).catch(() => {});
        return;
      }
      if (view.revision < (this.latest?.revision ?? -1)) return;
      this.leaseId = view.leaseId;
      this.receive(view);
      // The matching event may have arrived before the call result.
      this.changed();
      if (this.owned) {
        this.stop();
        this.timer = this.repeat(() => this.resize(this.size).catch(() => {}), 5000);
      }
    }).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }

  async resize(size) {
    this.size = size;
    if (!this.owned) return;
    const epoch = this.epoch;
    const leaseId = this.leaseId;
    try {
      const view = await this.invoke('pty_view_renew', { id: this.id, leaseId, ...size });
      if (epoch === this.epoch) this.receive(view);
    } catch (error) {
      if (epoch === this.epoch && this.leaseId === leaseId) { this.leaseId = null; this.stop(); this.changed(); }
      throw error;
    }
  }

  async release() {
    if (this.invalidated) return;
    const leaseId = this.leaseId;
    this.epoch += 1;
    this.leaseId = null;
    this.stop();
    this.changed();
    if (leaseId != null) await this.invoke('pty_view_release', { id: this.id, leaseId }).catch(() => {});
  }

  // A process or transport replacement may reuse both PTY and lease IDs.
  // Retire this controller locally; its outstanding replies have no authority.
  invalidate() {
    this.invalidated = true;
    this.epoch += 1;
    this.leaseId = null;
    this.latest = null;
    this.pending = null;
    this.stop();
    this.changed();
  }
}
