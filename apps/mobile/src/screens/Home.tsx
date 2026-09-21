import { Alert, Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { COMMUNITIES, isCommunityUrl } from '../config/community';

import { findDesktop, type DesktopEntry, type DesktopStore } from '../desktops/store';
import { useI18n } from '../i18n';
import type { DesktopConnection } from '../state/machine';
import { usePalette } from '../theme';
import { STATE_KEYS, stateColor } from './Desktops';
import { TransportBadge } from './TransportBadge';

type Props = {
  store: DesktopStore;
  describe: (desktopId: string) => DesktopConnection;
  // Computador cujo proxy ficou aberto ao sair do terminal; o card Continuar oferece desconectar.
  keptDesktopId: string | null;
  onContinue: (desktop: DesktopEntry) => void;
  onDisconnect: () => void;
  onDesktops: () => void;
  onPair: () => void;
  onTerminal: () => void;
  onSettings: () => void;
};

type Glyph = 'desktops' | 'pair' | 'terminal' | 'settings';

// Marcas de terceiro, geradas por `tools/brand/build-community-glyphs.mjs` a
// partir do traçado oficial, o mesmo que o site usa. São pretas sobre
// transparente e a cor vem de `tintColor`, então servem aos dois temas.
const COMMUNITY_GLYPHS = {
  discord: require('../assets/discord.png'),
  whatsapp: require('../assets/whatsapp.png'),
};
const COMMUNITY_LABELS = {
  discord: 'mobile.home.discord',
  whatsapp: 'mobile.home.whatsapp',
} as const;

// Glifos desenhados só com View, no acento, para o início ter ícones sem
// dependência nova: monitor, código QR, janela de terminal e controles.
function GlyphTile({ glyph }: { glyph: Glyph }) {
  const palette = usePalette();
  const stroke = { borderColor: palette.accent };
  const fill = { backgroundColor: palette.accent };
  let shape;
  if (glyph === 'desktops') {
    shape = (
      <View style={styles.glyph}>
        <View style={[styles.monitorScreen, stroke]} />
        <View style={[styles.monitorStand, fill]} />
      </View>
    );
  } else if (glyph === 'pair') {
    shape = (
      <View style={styles.glyph}>
        <View style={[styles.qrFinder, styles.qrTopLeft, stroke]} />
        <View style={[styles.qrFinder, styles.qrTopRight, stroke]} />
        <View style={[styles.qrFinder, styles.qrBottomLeft, stroke]} />
        <View style={[styles.qrModule, styles.qrBottomRight, fill]} />
      </View>
    );
  } else if (glyph === 'terminal') {
    shape = (
      <View style={[styles.glyph, styles.terminalWindow, stroke]}>
        <View style={[styles.terminalChevron, stroke]} />
        <View style={[styles.terminalCursor, fill]} />
      </View>
    );
  } else {
    shape = (
      <View style={[styles.glyph, styles.sliders]}>
        {[2, 12, 7].map(offset => (
          <View key={offset} style={styles.sliderRow}>
            <View style={[styles.sliderTrack, fill]} />
            <View style={[styles.sliderKnob, fill, { left: offset }]} />
          </View>
        ))}
      </View>
    );
  }
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.tile, { backgroundColor: palette.chip }]}>
      {shape}
    </View>
  );
}

export function Home({ store, describe, keptDesktopId, onContinue, onDisconnect, onDesktops, onPair, onTerminal, onSettings }: Props) {
  const palette = usePalette();
  const { t } = useI18n();
  const last = findDesktop(store, store.lastDesktopId);
  const connection = last ? describe(last.id) : null;
  const transport = last && connection
    ? connection.state === 'connected' ? connection.transport : last.lastTransport === '' ? null : last.lastTransport
    : null;
  const count = store.desktops.length;
  const countText = count === 0 ? t('mobile.home.desktopsCount.none')
    : count === 1 ? t('mobile.home.desktopsCount.one') : t('mobile.home.desktopsCount.many', { count });
  const actions: { glyph: Glyph; label: string; title: string; hint: string; onPress: () => void }[] = [
    { glyph: 'desktops', label: t('mobile.home.openDesktops'), title: t('mobile.home.desktops'), hint: countText, onPress: onDesktops },
    { glyph: 'pair', label: t('mobile.home.openPair'), title: t('mobile.home.pair'), hint: t('mobile.home.pairHint'), onPress: onPair },
    { glyph: 'terminal', label: t('mobile.home.openTerminal'), title: t('mobile.home.terminal'),
      hint: last ? last.name : t('mobile.home.terminalChoose'), onPress: onTerminal },
    { glyph: 'settings', label: t('mobile.desktops.openSettings'), title: t('mobile.home.settings'), hint: t('mobile.home.settingsHint'), onPress: onSettings }
  ];
  const surface = { backgroundColor: palette.surface, borderColor: palette.separator };

  // Abre no navegador do sistema. O endereço é conferido antes: um valor
  // inesperado aqui viraria abertura de app de terceiro.
  const openCommunity = async (url: string) => {
    if (!isCommunityUrl(url)) return;
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert(t('mobile.home.community'), t('mobile.home.communityFailed'));
    }
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: palette.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={[styles.title, { color: palette.label }]}>{t('mobile.home.title')}</Text>
          <Text style={[styles.subtitle, { color: palette.secondaryLabel }]}>{t('mobile.home.subtitle')}</Text>
        </View>

        {last && connection ? (
          <View style={[styles.card, styles.continueCard, surface]}>
            <Pressable accessibilityLabel={t('mobile.home.continueIn', { name: last.name })} accessibilityRole="button"
              disabled={connection.state === 'connecting'} onPress={() => onContinue(last)}
              style={({ pressed }) => [styles.continueMain, pressed && styles.pressed]}>
              <View style={[styles.dot, { backgroundColor: stateColor(palette, connection.state) }]} />
              <View style={styles.continueText}>
                <Text style={[styles.continueLabel, { color: palette.accent }]}>{t('mobile.home.continue')}</Text>
                <Text numberOfLines={1} style={[styles.continueName, { color: palette.label }]}>{last.name}</Text>
                <View style={styles.continueMetaRow}>
                  <Text style={[styles.continueState, { color: palette.secondaryLabel }]}>{t(STATE_KEYS[connection.state])}</Text>
                  {transport ? <TransportBadge transport={transport} /> : null}
                </View>
              </View>
            </Pressable>
            {keptDesktopId === last.id ? (
              <Pressable accessibilityRole="button" onPress={onDisconnect} style={styles.disconnect}>
                <Text style={[styles.disconnectText, { color: palette.accent }]}>{t('mobile.home.disconnect')}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View style={styles.grid}>
          {actions.map(action => (
            <Pressable accessibilityLabel={action.label} accessibilityRole="button" key={action.glyph} onPress={action.onPress}
              style={({ pressed }) => [styles.card, surface, pressed && styles.pressed]}>
              <GlyphTile glyph={action.glyph} />
              <Text style={[styles.cardTitle, { color: palette.label }]}>{action.title}</Text>
              <Text numberOfLines={2} style={[styles.cardHint, { color: palette.secondaryLabel }]}>{action.hint}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.community}>
          <Text accessibilityRole="header" style={[styles.communityTitle, { color: palette.label }]}>{t('mobile.home.community')}</Text>
          <Text style={[styles.communityHint, { color: palette.secondaryLabel }]}>{t('mobile.home.communityHint')}</Text>
          <View style={styles.communityRow}>
            {COMMUNITIES.map(space => {
              const label = t(COMMUNITY_LABELS[space.id]);
              return (
                <Pressable accessibilityLabel={label} accessibilityRole="link" key={space.id} onPress={() => openCommunity(space.url)}
                  style={({ pressed }) => [styles.communityButton, surface, pressed && styles.pressed]}>
                  <Image accessibilityIgnoresInvertColors resizeMode="contain" source={COMMUNITY_GLYPHS[space.id]}
                    style={[styles.communityGlyph, { tintColor: palette.label }]} />
                  <Text numberOfLines={1} style={[styles.communityLabel, { color: palette.label }]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: { paddingHorizontal: 20, paddingBottom: 24, gap: 12 },
  header: { paddingHorizontal: 4, paddingTop: 20, paddingBottom: 4 },
  title: { fontSize: 34, lineHeight: 41, fontWeight: '700', letterSpacing: 0.2 },
  subtitle: { marginTop: 4, fontSize: 17, lineHeight: 22 },
  card: { width: '48%', minHeight: 92, borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, overflow: 'hidden', padding: 16 },
  continueCard: { width: '100%', padding: 0 },
  continueMain: { minHeight: 92, flexDirection: 'row', alignItems: 'center', padding: 16 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  continueText: { flex: 1 },
  continueLabel: { fontSize: 13, lineHeight: 18, fontWeight: '600', textTransform: 'uppercase' },
  continueName: { marginTop: 2, fontSize: 20, lineHeight: 25, fontWeight: '700' },
  continueMetaRow: { marginTop: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  continueState: { fontSize: 15, lineHeight: 20 },
  disconnect: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 },
  disconnectText: { fontSize: 15, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 12 },
  cardTitle: { marginTop: 12, fontSize: 17, lineHeight: 22, fontWeight: '600' },
  cardHint: { marginTop: 2, fontSize: 13, lineHeight: 18 },
  pressed: { opacity: 0.7 },
  community: { marginTop: 8, paddingHorizontal: 4, gap: 2 },
  communityTitle: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  communityHint: { fontSize: 13, lineHeight: 18 },
  communityRow: { marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  communityButton: { flexGrow: 1, flexBasis: '46%', minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 14, borderWidth: StyleSheet.hairlineWidth, borderRadius: 999 },
  communityGlyph: { width: 18, height: 18 },
  communityLabel: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  tile: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  glyph: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  monitorScreen: { width: 22, height: 15, borderWidth: 2, borderRadius: 4 },
  monitorStand: { width: 10, height: 2, borderRadius: 1, marginTop: 3 },
  qrFinder: { position: 'absolute', width: 9, height: 9, borderWidth: 2, borderRadius: 2 },
  qrTopLeft: { top: 0, left: 0 },
  qrTopRight: { top: 0, right: 0 },
  qrBottomLeft: { bottom: 0, left: 0 },
  qrModule: { position: 'absolute', width: 5, height: 5, borderRadius: 1 },
  qrBottomRight: { bottom: 1, right: 1 },
  terminalWindow: { height: 17, borderWidth: 2, borderRadius: 4, flexDirection: 'row', justifyContent: 'center', gap: 3 },
  terminalChevron: { width: 6, height: 6, borderTopWidth: 2, borderRightWidth: 2, transform: [{ rotate: '45deg' }] },
  terminalCursor: { width: 6, height: 2, borderRadius: 1, alignSelf: 'flex-end', marginBottom: 3 },
  sliders: { gap: 2 },
  sliderRow: { width: 22, height: 6, justifyContent: 'center' },
  sliderTrack: { width: 22, height: 2, borderRadius: 1 },
  sliderKnob: { position: 'absolute', width: 6, height: 6, borderRadius: 3 }
});
