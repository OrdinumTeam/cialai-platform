// SPDX-License-Identifier: Apache-2.0
// One paste owner per terminal. Native paste may arrive while an asynchronous
// clipboard read is pending; the native event wins that same operation.
export function clipboardPaths(uris) {
  const lines = String(uris || '').split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
  // GNOME's copied-files target starts with copy/cut. A terminal only inserts
  // arguments; it must never move or delete the source files.
  if (['copy', 'cut'].includes(lines[0])) lines.shift();
  if (!lines.length) return [];
  const paths = lines.map((line) => {
    try {
      const url = new URL(line);
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost') || url.search || url.hash) return null;
      const path = decodeURIComponent(url.pathname);
      if (/[\x00-\x1f\x7f]/.test(path)) return null;
      return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path;
    } catch (_error) { return null; }
  });
  return paths.every(Boolean) ? paths : [];
}

export function clipboardPayload(data) {
  const paths = clipboardPaths(data?.getData?.('text/uri-list') || data?.getData?.('x-special/gnome-copied-files'));
  if (paths.length) return { kind: 'paths', paths };
  const text = data?.getData?.('text/plain') || '';
  if (text) return { kind: 'text', text };
  const files = Array.from(data?.files || []);
  if (!files.length) {
    for (const item of Array.from(data?.items || [])) {
      const file = item.getAsFile?.();
      if (file) files.push(file);
    }
  }
  if (files.length) return { kind: 'files', files };
  const image = Array.from(data?.items || []).some((item) => item.type?.startsWith('image/'));
  return { kind: image ? 'image' : 'empty' };
}

export async function readClipboard(clipboard) {
  if (clipboard?.read) {
    try {
      const items = await clipboard.read();
      for (const item of items) {
        for (const type of ['text/uri-list', 'x-special/gnome-copied-files']) {
          if (!item.types.includes(type)) continue;
          const paths = clipboardPaths(await (await item.getType(type)).text());
          if (paths.length) return { kind: 'paths', paths };
        }
      }
      for (const item of items) {
        if (item.types.includes('text/plain')) {
          const text = await (await item.getType('text/plain')).text();
          if (text) return { kind: 'text', text };
        }
      }
      const files = [];
      for (const item of items) {
        const type = item.types.find((type) => type.startsWith('image/'));
        if (type) files.push(await item.getType(type));
      }
      return files.length ? { kind: 'files', files } : { kind: 'empty' };
    } catch (error) {
      if (!clipboard.readText) throw error;
    }
  }
  if (!clipboard?.readText) throw new Error('clipboard_unavailable');
  const text = await clipboard.readText();
  return text ? { kind: 'text', text } : { kind: 'empty' };
}

export function installTerminalClipboard(term, { paste, image, paths, files, readNative, onError = () => {}, valid = () => true, identity = () => null, focus = () => term.focus(), timeoutMs = 10000 }) {
  let disposed = false;
  const pending = [];
  const deliver = (payload, target = identity()) => {
    if (disposed || !valid() || target !== identity()) return 'cancelled';
    if (payload.kind === 'text') { paste(payload.text); focus(); }
    else if (payload.kind === 'paths') { paths?.(payload.paths); focus(); }
    else if (payload.kind === 'files') {
      // Saving blobs is asynchronous. Check the PTY again immediately before
      // delivering paths, including when a native paste cancelled an API read.
      return Promise.resolve(files?.(payload.files)).then((saved) => {
        if (disposed || !valid() || target !== identity()) return 'cancelled';
        if (saved?.length) { paths?.(saved); focus(); }
        return 'files';
      });
    }
    else if (payload.kind === 'image') {
      if (!image) return Promise.reject(new Error('clipboard_image_unavailable'));
      image(); focus();
    }
    return payload.kind;
  };
  const onPaste = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const operation = pending.find((op) => !op.done);
    if (operation && operation.target !== identity()) {
      operation.done = true; operation.cancel?.(); return;
    }
    const payload = clipboardPayload(event.clipboardData);
    const needsNative = readNative && (payload.kind === 'empty' || (payload.kind === 'image' && !image));
    if (needsNative && operation) return;
    if (operation) { operation.done = true; operation.cancel?.('native'); }
    // A WebView may expose no data for a file manager's native formats. Read
    // the OS clipboard instead of swallowing that paste as empty.
    if (needsNative && !operation) {
      controller.read().catch(onError);
    } else {
      Promise.resolve(deliver(payload)).catch(onError);
    }
  };
  term.element.addEventListener('paste', onPaste, true);
  const controller = {
    async read(clipboard) {
      if (disposed || !valid()) return 'cancelled';
      const target = identity();
      const operation = { done: false, target };
      pending.push(operation);
      let timer;
      const cancelled = new Promise((resolve) => { operation.cancel = (kind = 'cancelled') => resolve({ kind }); });
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('clipboard_timeout')), timeoutMs); });
      try {
        const payload = await Promise.race([readNative ? readNative() : readClipboard(clipboard), cancelled, timeout]);
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
  return controller;
}
