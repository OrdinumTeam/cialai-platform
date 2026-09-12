// SPDX-License-Identifier: Apache-2.0
// Sessao de navegacao sobre um cliente CDP: as abas do Chromium, a aba ativa,
// dialogos de JavaScript sempre respondidos, abas que travaram e as acoes de
// navegar, recarregar, parar e andar no historico. Traducao da `Session` da
// extensao dev-browser-panel, sem o processo, que aqui e do Rust.

// Um confirm ou prompt que ninguem responde recebe "nao" depois disto, para a
// aba nunca ficar congelada.
const DIALOG_FALLBACK_MS = 60000;

export class BrowserSession {
  constructor(cdp) {
    this.cdp = cdp;
    this.targets = new Map();
    this.activeTargetId = null;
    this.listeners = new Map();
    this.dialogTimers = new Map();
    this.offs = [];
  }

  on(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    return () => { this.listeners.get(type)?.delete(listener); };
  }

  emit(type, payload) {
    this.listeners.get(type)?.forEach((listener) => {
      try { listener(payload); } catch (error) { console.error('[browser/session]', error); }
    });
  }

  async start() {
    const { cdp } = this;
    this.offs.push(cdp.on('Target.targetCreated', (event) => this.onTargetCreated(event)));
    this.offs.push(cdp.on('Target.targetDestroyed', (event) => this.onTargetDestroyed(event)));
    this.offs.push(cdp.on('Target.targetInfoChanged', (event) => this.onTargetInfoChanged(event)));
    this.offs.push(cdp.on('Target.attachedToTarget', (event) => this.onAttachedToTarget(event)));
    this.offs.push(cdp.on('Page.javascriptDialogOpening', (event) => this.onDialogOpening(event)));
    this.offs.push(cdp.on('Page.javascriptDialogClosed', (event) => { if (event.sessionId) this.clearDialogTimer(event.sessionId); }));
    this.offs.push(cdp.on('Inspector.targetCrashed', (event) => this.onTargetCrashed(event)));
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const target of targetInfos) {
      if (target.type !== 'page') continue;
      if (!this.targets.has(target.targetId)) {
        this.targets.set(target.targetId, target);
        // eslint-disable-next-line no-await-in-loop
        await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }).catch(() => {});
      }
    }
    if (!this.activeTargetId) {
      const first = [...this.targets.values()].find((target) => target.type === 'page');
      if (first) this.activeTargetId = first.targetId;
    }
    this.emit('targets-changed');
  }

  onTargetCreated(event) {
    const target = event.params.targetInfo;
    if (!target || target.type !== 'page') return;
    this.targets.set(target.targetId, target);
    if (!this.activeTargetId) this.activeTargetId = target.targetId;
    this.emit('targets-changed');
  }

  onTargetDestroyed(event) {
    const id = event.params.targetId;
    if (!this.targets.has(id)) return;
    this.targets.delete(id);
    if (this.activeTargetId === id) {
      const next = this.targets.keys().next().value;
      this.activeTargetId = next ?? null;
      this.emit('active-changed', this.activeTargetId);
    }
    this.emit('targets-changed');
  }

  onTargetInfoChanged(event) {
    const target = event.params.targetInfo;
    const previous = this.targets.get(target?.targetId);
    if (!previous) return;
    this.targets.set(target.targetId, { ...previous, url: target.url, title: target.title });
    this.emit('targets-changed');
  }

  onAttachedToTarget(event) {
    const { sessionId, targetInfo } = event.params;
    if (!targetInfo || targetInfo.type !== 'page') return;
    this.targets.set(targetInfo.targetId, { ...targetInfo, sessionId });
    // Page em toda aba: eventos de carregamento para a barra e, o que
    // importa, javascriptDialogOpening. Um dialogo sem resposta congela a aba.
    this.cdp.send('Page.enable', {}, sessionId).catch(() => {});
    this.emit('attached', { targetId: targetInfo.targetId, sessionId });
    this.emit('targets-changed');
  }

  targetIdForSession(sessionId) {
    if (!sessionId) return null;
    for (const target of this.targets.values()) {
      if (target.sessionId === sessionId) return target.targetId;
    }
    return null;
  }

  onDialogOpening(event) {
    const { sessionId } = event;
    if (!sessionId) return;
    const params = event.params || {};
    const dialog = {
      targetId: this.targetIdForSession(sessionId),
      sessionId,
      type: params.type || 'alert',
      message: params.message || '',
      defaultPrompt: params.defaultPrompt || '',
      url: params.url || '',
    };
    if (dialog.type === 'alert' || dialog.type === 'beforeunload') {
      this.answerDialog(sessionId, true);
      this.emit('dialog', { ...dialog, answered: true });
      return;
    }
    const timer = setTimeout(() => { this.answerDialog(sessionId, false); }, DIALOG_FALLBACK_MS);
    this.dialogTimers.set(sessionId, timer);
    this.emit('dialog', { ...dialog, answered: false });
  }

  clearDialogTimer(sessionId) {
    const timer = this.dialogTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.dialogTimers.delete(sessionId);
    }
  }

  async answerDialog(sessionId, accept, promptText) {
    this.clearDialogTimer(sessionId);
    const params = { accept };
    if (promptText !== undefined) params.promptText = promptText;
    await this.cdp.send('Page.handleJavaScriptDialog', params, sessionId).catch(() => {});
  }

  onTargetCrashed(event) {
    const targetId = this.targetIdForSession(event.sessionId);
    if (!targetId) return;
    const target = this.targets.get(targetId);
    this.emit('target-crashed', { targetId, url: target?.url || '' });
  }

  activeTarget() {
    return this.activeTargetId ? this.targets.get(this.activeTargetId) || null : null;
  }

  activeSessionId() {
    return this.activeTarget()?.sessionId || null;
  }

  setActive(targetId) {
    if (!this.targets.has(targetId)) return;
    this.activeTargetId = targetId;
    this.emit('active-changed', targetId);
  }

  async recoverTarget(targetId) {
    const target = this.targets.get(targetId);
    if (!target?.sessionId) return;
    try {
      await this.cdp.send('Page.reload', { ignoreCache: false }, target.sessionId);
    } catch (_error) {
      if (target.url) await this.cdp.send('Page.navigate', { url: target.url }, target.sessionId).catch(() => {});
    }
  }

  async createTab(url = 'about:blank') {
    const { targetId } = await this.cdp.send('Target.createTarget', { url });
    if (!this.targets.has(targetId)) this.targets.set(targetId, { targetId, url, title: '', type: 'page' });
    this.activeTargetId = targetId;
    this.emit('active-changed', targetId);
    this.emit('targets-changed');
    return targetId;
  }

  async closeTab(targetId) {
    const pages = [...this.targets.values()].filter((target) => target.type === 'page');
    if (pages.length <= 1) await this.createTab('about:blank');
    await this.cdp.send('Target.closeTarget', { targetId });
  }

  async navigate(targetId, url) {
    const target = this.targets.get(targetId);
    if (!target?.sessionId) return;
    await this.cdp.send('Page.navigate', { url }, target.sessionId);
  }

  async reload(targetId, ignoreCache = false) {
    const target = this.targets.get(targetId);
    if (!target?.sessionId) return;
    await this.cdp.send('Page.reload', { ignoreCache }, target.sessionId);
  }

  async stopLoading(targetId) {
    const target = this.targets.get(targetId);
    if (!target?.sessionId) return;
    await this.cdp.send('Page.stopLoading', {}, target.sessionId);
  }

  async history(sessionId) {
    try {
      return await this.cdp.send('Page.getNavigationHistory', {}, sessionId);
    } catch (_error) {
      return null;
    }
  }

  async goBack(targetId) {
    const target = this.targets.get(targetId);
    if (!target?.sessionId) return;
    const history = await this.history(target.sessionId);
    if (!history || history.currentIndex <= 0) return;
    await this.cdp.send('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex - 1].id }, target.sessionId);
  }

  async goForward(targetId) {
    const target = this.targets.get(targetId);
    if (!target?.sessionId) return;
    const history = await this.history(target.sessionId);
    if (!history || history.currentIndex >= history.entries.length - 1) return;
    await this.cdp.send('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex + 1].id }, target.sessionId);
  }

  async navState(targetId) {
    const target = this.targets.get(targetId);
    if (!target?.sessionId) return { canGoBack: false, canGoForward: false };
    const history = await this.history(target.sessionId);
    if (!history) return { canGoBack: false, canGoForward: false };
    return { canGoBack: history.currentIndex > 0, canGoForward: history.currentIndex < history.entries.length - 1 };
  }

  dispose() {
    this.offs.forEach((off) => off());
    this.offs = [];
    this.dialogTimers.forEach((timer) => clearTimeout(timer));
    this.dialogTimers.clear();
    this.targets.clear();
    this.activeTargetId = null;
    this.listeners.clear();
  }
}
