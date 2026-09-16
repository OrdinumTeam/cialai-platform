import { StyleSheet, Text, View } from 'react-native';

import type { PathKind, TorState, Transport } from 'cialai-tunnel';

import { useI18n } from '../i18n';
import { usePalette } from '../theme';

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
  const palette = usePalette();
  return (transport: Transport | null) => transport === 'direct' ? palette.success
    : transport === 'tor' ? palette.warning : palette.danger;
}

type Props = { transport: Transport };

// Badge curto com o transporte, sem endereço nem porta.
export function TransportBadge({ transport }: Props) {
  const palette = usePalette();
  const color = useTransportColor();
  const { t } = useI18n();
  return (
    <View accessibilityLabel={t(TRANSPORT_DESCRIPTION_KEYS[transport])} accessible
      style={[styles.badge, { backgroundColor: palette.chip }]}>
      <View style={[styles.dot, { backgroundColor: color(transport) }]} />
      <Text style={[styles.text, { color: palette.secondaryLabel }]}>{t(TRANSPORT_KEYS[transport])}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  text: { fontSize: 12, lineHeight: 16, fontWeight: '600' }
});
