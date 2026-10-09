// Chaves de texto do transporte e do caminho, e a cor do ponto de estado.
import type { PathKind, TorState, Transport } from 'cialai-tunnel';

import { useTokens } from '../theme';

export const TRANSPORT_KEYS: Readonly<Record<Transport, string>> = {
  direct: 'mobile.transport.direct',
  tor: 'mobile.transport.tor'
};

export const TRANSPORT_DESCRIPTION_KEYS: Readonly<Record<Transport, string>> = {
  direct: 'mobile.transport.directDescription',
  tor: 'mobile.transport.torDescription'
};

export const PATH_KEYS: Readonly<Record<PathKind, string>> = {
  lan: 'mobile.path.lan',
  direct: 'mobile.path.direct',
  tor: 'mobile.path.tor'
};

export const TOR_STATE_KEYS: Readonly<Record<Exclude<TorState, 'bootstrapping'>, string>> = {
  disabled: 'mobile.tor.disabled',
  starting: 'mobile.tor.starting',
  ready: 'mobile.tor.ready',
  failed: 'mobile.tor.failed'
};

export function useTransportColor() {
  const { colors } = useTokens();
  return (transport: Transport | null) => transport === 'direct' ? colors.success
    : transport === 'tor' ? colors.warning : colors.danger;
}
