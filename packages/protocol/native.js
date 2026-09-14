// SPDX-License-Identifier: Apache-2.0
// Small adapter that gives Tauri IPC and remote WebSocket the same interface.

export const NATIVE_ONLY_MESSAGE = 'Disponível só no aplicativo desktop.';

const invalidBridgeUrl = () => Object.assign(new Error('Informe um endereço WebSocket válido.'), { code: 'bridge_url_invalid' });

function explicitBridgeUrl(value) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch (_error) { throw invalidBridgeUrl(); }
  if (!['ws:', 'wss:'].includes(url.protocol)) throw invalidBridgeUrl();
  return url.href;
}

export function remoteBridgeUrl(locationLike, explicit = '') {
  if (explicit) return explicitBridgeUrl(explicit);
  const hostname = String(locationLike?.hostname || '').replace(/^\[|\]$/g, '');
  if (!hostname || ['localhost', '127.0.0.1', '::1'].includes(hostname)) return '';
  const protocol = locationLike?.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${locationLike.host}/pty`;
}

export function createNativeBridge({
  isNative,
  isRemoteConfigured,
  authorizeRemote,
  invokeRemote,
  invokeNative,
  listenRemote,
  listenNative,
  createRemoteChannel,
  createNativeChannel,
}) {
  const hasBridge = () => isNative() || isRemoteConfigured();
  return {
    hasBridge,
    async invoke(command, args) {
      if (isNative()) return invokeNative(command, args);
      if (!isRemoteConfigured()) return undefined;
      await authorizeRemote(command, args);
      return invokeRemote(command, args);
    },
    async listen(event, handler) {
      if (isNative()) return listenNative(event, handler);
      if (isRemoteConfigured()) return listenRemote(event, handler);
      return () => {};
    },
    async createChannel(onmessage) {
      if (isNative()) return createNativeChannel(onmessage);
      return isRemoteConfigured() ? createRemoteChannel(onmessage) : null;
    },
  };
}
