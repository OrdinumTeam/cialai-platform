// SPDX-License-Identifier: Apache-2.0
// One paste owner per terminal. Native paste may arrive while an asynchronous
// clipboard read is pending; the native event wins that same operation.
export function clipboardPayload(data) {
  const text = data?.getData?.('text/plain') || '';
  if (text) return { kind: 'text', text };
  const image = Array.from(data?.items || []).some((item) => item.type?.startsWith('image/'));
  return { kind: image ? 'image' : 'empty' };
}

export async function readClipboard(clipboard) {
  if (clipboard?.read) {
    try {
      const items = await clipboard.read();
      for (const item of items) {
        if (item.types.includes('text/plain')) {
          const text = await (await item.getType('text/plain')).text();
          if (text) return { kind: 'text', text };
        }
      }
      return { kind: items.some((item) => item.types.some((type) => type.startsWith('image/'))) ? 'image' : 'empty' };
    } catch (error) {
      if (!clipboard.readText) throw error;
    }
  }
  if (!clipboard?.readText) throw new Error('clipboard_unavailable');
  const text = await clipboard.readText();
  return text ? { kind: 'text', text } : { kind: 'empty' };
}

export function installTerminalClipboard(term, { paste, image, valid = () => true, identity = () => null, focus = () => term.focus(), timeoutMs = 10000 }) {
  let disposed = false;
  const pending = [];
  const deliver = (payload, target = identity()) => {
    if (disposed || !valid() || target !== identity()) return 'cancelled';
    if (payload.kind === 'text') { paste(payload.text); focus(); }
    else if (payload.kind === 'image') { image?.(); focus(); }
    return payload.kind;
  };
  const onPaste = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const operation = pending.find((op) => !op.done);
    if (operation && operation.target !== identity()) {
      operation.done = true; operation.cancel?.(); return;
    }
    if (operation) { operation.done = true; operation.cancel?.('native'); }
    deliver(clipboardPayload(event.clipboardData));
  };
  term.element.addEventListener('paste', onPaste, true);
  return {
    async read(clipboard) {
      if (disposed || !valid()) return 'cancelled';
      const target = identity();
      const operation = { done: false, target };
      pending.push(operation);
      let timer;
      const cancelled = new Promise((resolve) => { operation.cancel = (kind = 'cancelled') => resolve({ kind }); });
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('clipboard_timeout')), timeoutMs); });
      try {
        const payload = await Promise.race([readClipboard(clipboard), cancelled, timeout]);
        if (payload.kind === 'cancelled') return 'cancelled';
        if (payload.kind === 'native') return 'native';
        if (operation.done) return 'native';
        operation.done = true;
        return deliver(payload, target);
      } finally {
        clearTimeout(timer);
        const index = pending.indexOf(operation);
        if (index >= 0) pending.splice(index, 1);
      }
    },
    dispose() {
      disposed = true;
      pending.forEach((operation) => operation.cancel?.());
      pending.length = 0;
      term.element.removeEventListener('paste', onPaste, true);
    },
  };
}
