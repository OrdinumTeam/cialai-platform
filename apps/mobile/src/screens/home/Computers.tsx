import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { liveSessions } from '../../dashboard/model';
import { dashboardFor } from '../../dashboard/store';
import { formatLastSeen } from '../../desktops/format';
import type { DesktopEntry } from '../../desktops/store';
import { useI18n } from '../../i18n';
import type { DesktopConnection } from '../../state/machine';
import { useTokens } from '../../theme';
import { BottomSheet, Card, Icon, IconButton, PrimaryButton, SecondaryButton, StatusBadge, radius, space, typography } from '../../ui';
import { LaptopIllustration } from '../../ui/Illustrations';
import { STATE_KEYS, STATE_TONES } from '../Desktops';
import { TRANSPORT_DESCRIPTION_KEYS, TRANSPORT_KEYS } from '../TransportBadge';

type Props = {
  desktops: readonly DesktopEntry[];
  // Computador cujo proxy ficou aberto ao sair do terminal: o card oferece desconectar.
  keptDesktopId: string | null;
  onDisconnect: () => void;
  describe: (desktopId: string) => DesktopConnection;
  onFocus: (desktopId: string) => void;
  onOpen: (desktop: DesktopEntry) => void;
  onMenu: (desktop: DesktopEntry) => void;
};

function ComputerSlide({ desktop, connection, width, kept, onOpen, onMenu, onDisconnect }: {
  desktop: DesktopEntry; connection: DesktopConnection; width: number; kept: boolean;
  onOpen: () => void; onMenu: () => void; onDisconnect: () => void;
}) {
  const { colors } = useTokens();
  const { locale, t } = useI18n();
  const transport = connection.state === 'connected' ? connection.transport
    : desktop.lastTransport === '' ? null : desktop.lastTransport;
  const lastSeen = formatLastSeen(desktop.lastSeenAt, locale);
  const sessions = liveSessions(dashboardFor(desktop.id).snapshot).length;
  const online = connection.state === 'connected';
  return (
    <Card style={[styles.slide, { width }]}>
      <View style={[styles.art, { backgroundColor: online ? colors.primarySoft : colors.surfaceMuted }]}>
        <LaptopIllustration online={online} width={96} />
      </View>
      <View style={styles.body}>
        <Text numberOfLines={1} style={[typography.headline, { color: colors.text }]}>{desktop.name}</Text>
        <View style={styles.badges}>
          <StatusBadge label={t(STATE_KEYS[connection.state])} tone={STATE_TONES[connection.state]} />
          {transport ? (
            <StatusBadge accessibilityLabel={t(TRANSPORT_DESCRIPTION_KEYS[transport])} label={t(TRANSPORT_KEYS[transport])}
              tone={transport === 'tor' ? 'warning' : 'success'} variant="pill" />
          ) : null}
        </View>
        <Text numberOfLines={1} style={[typography.caption, { color: colors.textSecondary }]}>
          {sessions ? t(sessions === 1 ? 'mobile.home.sessionsOpen.one' : 'mobile.home.sessionsOpen.many', { count: sessions })
            : lastSeen ? t('mobile.desktops.lastSeen', { date: lastSeen }) : t('mobile.desktops.never')}
        </Text>
        <View style={styles.actions}>
          <PrimaryButton accessibilityLabel={t('mobile.home.openTerminalIn', { name: desktop.name })}
            disabled={connection.state === 'connecting' || connection.state === 'removed'}
            label={t('mobile.home.openTerminalButton')} onPress={onOpen} style={styles.open} />
          <IconButton accessibilityLabel={t('mobile.desktops.optionsFor', { name: desktop.name })} icon="ellipsis" onPress={onMenu} variant="surface" />
        </View>
        {kept ? (
          <Pressable accessibilityRole="button" hitSlop={8} onPress={onDisconnect} style={({ pressed }) => [styles.disconnect, pressed && styles.pressed]}>
            <Icon color={colors.primary} name="unplug" size={14} />
            <Text style={[typography.footnote, styles.disconnectText, { color: colors.primary }]}>{t('mobile.home.disconnect')}</Text>
          </Pressable>
        ) : null}
      </View>
    </Card>
  );
}

// Carrossel dos computadores: um por página, com pontos embaixo. O que está
// à vista define os agentes e os projetos mostrados no Início.
export function ComputerCarousel({ desktops, keptDesktopId, describe, onFocus, onOpen, onMenu, onDisconnect }: Props) {
  const { colors } = useTokens();
  const { t } = useI18n();
  // Antes da primeira medida vale a largura da tela menos as margens do Início.
  const screen = useWindowDimensions().width;
  const [measured, setWidth] = useState(0);
  const width = measured || Math.max(240, screen - 2 * space.lg);
  const [page, setPage] = useState(0);
  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!width) return;
    const next = Math.max(0, Math.min(desktops.length - 1, Math.round(event.nativeEvent.contentOffset.x / (width + space.sm))));
    setPage(next);
    const desktop = desktops[next];
    if (desktop) onFocus(desktop.id);
  };
  return (
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)}>
      {desktops.length ? (
        <ScrollView contentContainerStyle={styles.track} decelerationRate="fast" horizontal onMomentumScrollEnd={settle}
          showsHorizontalScrollIndicator={false} snapToAlignment="start" snapToInterval={width + space.sm}>
          {desktops.map(desktop => (
            <ComputerSlide connection={describe(desktop.id)} desktop={desktop} kept={keptDesktopId === desktop.id} key={desktop.id}
              onDisconnect={onDisconnect} onMenu={() => onMenu(desktop)} onOpen={() => onOpen(desktop)} width={width} />
          ))}
        </ScrollView>
      ) : null}
      {desktops.length > 1 ? (
        <View accessibilityLabel={t('mobile.home.computerPage', { index: page + 1, count: desktops.length })} accessible style={styles.dots}>
          {desktops.map((desktop, index) => (
            <View key={desktop.id} style={[styles.dot, { backgroundColor: index === page ? colors.primary : colors.borderStrong },
              index === page && styles.dotActive]} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

type MenuProps = {
  desktop: DesktopEntry | null;
  kept: boolean;
  onOpen: (desktop: DesktopEntry) => void;
  onDisconnect: () => void;
  onDesktops: () => void;
  onClose: () => void;
};

export function ComputerMenu({ desktop, kept, onOpen, onDisconnect, onDesktops, onClose }: MenuProps) {
  const { t } = useI18n();
  const run = (action: () => void) => () => { onClose(); action(); };
  return (
    <BottomSheet onClose={onClose} title={desktop?.name ?? ''} visible={!!desktop}>
      {desktop ? <>
        <PrimaryButton icon="terminal" label={t('mobile.home.openTerminalButton')} onPress={run(() => onOpen(desktop))} />
        {kept ? <SecondaryButton icon="unplug" label={t('mobile.home.disconnect')} onPress={run(onDisconnect)} variant="neutral" /> : null}
        <SecondaryButton icon="monitor" label={t('mobile.home.openDesktops')} onPress={run(onDesktops)} variant="neutral" />
      </> : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  track: { gap: space.sm },
  slide: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.sm },
  art: { width: 112, alignSelf: 'stretch', minHeight: 104, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0, gap: space.xxs },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.xs },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
  open: { flex: 1, paddingHorizontal: space.sm },
  disconnect: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32, alignSelf: 'flex-start' },
  disconnectText: { fontWeight: '600' },
  pressed: { opacity: 0.6 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: space.sm },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotActive: { width: 16 }
});
