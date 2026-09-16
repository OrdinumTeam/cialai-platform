import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { formatLastSeen } from '../desktops/format';
import { MAX_DESKTOP_NAME, type DesktopEntry, type DesktopStore } from '../desktops/store';
import { useI18n } from '../i18n';
import type { DesktopConnection, DesktopConnectionState } from '../state/machine';
import { usePalette } from '../theme';
import { TransportBadge } from './TransportBadge';

type Props = {
  store: DesktopStore;
  describe: (desktopId: string) => DesktopConnection;
  onOpen: (desktop: DesktopEntry) => void;
  onPair: () => void;
  onSettings: () => void;
  onRename: (desktopId: string, name: string) => void;
  onForgetDesktop: (desktop: DesktopEntry) => void;
};

const STATE_KEYS: Readonly<Record<DesktopConnectionState, string>> = {
  idle: 'mobile.desktops.state.idle',
  connecting: 'mobile.desktops.state.connecting',
  connected: 'mobile.desktops.state.connected',
  offline: 'mobile.desktops.state.offline',
  removed: 'mobile.desktops.state.removed'
};

export function Desktops({ store, describe, onOpen, onPair, onSettings, onRename, onForgetDesktop }: Props) {
  const palette = usePalette();
  const { locale, t } = useI18n();
  const [selected, setSelected] = useState<DesktopEntry | null>(null);
  const [name, setName] = useState('');

  const stateColor = (state: DesktopConnectionState) => state === 'connected' ? palette.success
    : state === 'connecting' ? palette.warning
      : state === 'offline' || state === 'removed' ? palette.danger : palette.tertiaryLabel;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: palette.background }]}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text accessibilityRole="header" style={[styles.title, { color: palette.label }]}>{t('mobile.desktops.title')}</Text>
          <Text style={[styles.subtitle, { color: palette.secondaryLabel }]}>{t('mobile.desktops.subtitle')}</Text>
        </View>
        <Pressable accessibilityLabel={t('mobile.desktops.openSettings')} accessibilityRole="button" onPress={onSettings} style={styles.headerButton}>
          <Text style={[styles.headerButtonText, { color: palette.accent }]}>{t('mobile.desktops.settings')}</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        {store.desktops.map(desktop => {
          const connection = describe(desktop.id);
          const transport = connection.state === 'connected' ? connection.transport
            : desktop.lastTransport === '' ? null : desktop.lastTransport;
          const lastSeen = formatLastSeen(desktop.lastSeenAt, locale);
          return (
            <View key={desktop.id} style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.separator }]}>
              <Pressable accessibilityRole="button" disabled={connection.state === 'connecting'} onPress={() => onOpen(desktop)} style={styles.cardMain}>
                <View style={[styles.dot, { backgroundColor: stateColor(connection.state) }]} />
                <View style={styles.cardText}>
                  <Text style={[styles.cardTitle, { color: palette.label }]}>{desktop.name}</Text>
                  <Text style={[styles.cardState, { color: palette.secondaryLabel }]}>{t(STATE_KEYS[connection.state])}</Text>
                  <View style={styles.cardMetaRow}>
                    {transport ? <TransportBadge transport={transport} /> : null}
                    <Text style={[styles.cardMeta, { color: palette.tertiaryLabel }]}>
                      {lastSeen ? t('mobile.desktops.lastSeen', { date: lastSeen }) : t('mobile.desktops.never')}
                    </Text>
                  </View>
                </View>
              </Pressable>
              <Pressable accessibilityLabel={t('mobile.desktops.optionsFor', { name: desktop.name })} accessibilityRole="button"
                onPress={() => { setSelected(desktop); setName(desktop.name); }} style={styles.options}>
                <Text style={[styles.optionsText, { color: palette.accent }]}>{t('mobile.desktops.options')}</Text>
              </Pressable>
            </View>
          );
        })}
        {!store.desktops.length ? (
          <Text style={[styles.empty, { color: palette.secondaryLabel }]}>{t('mobile.desktops.empty')}</Text>
        ) : null}
        <Pressable accessibilityRole="button" onPress={onPair}
          style={({ pressed }) => [styles.primary, { backgroundColor: pressed ? palette.accentPressed : palette.accent }]}>
          <Text style={[styles.primaryText, { color: palette.accentText }]}>{t('mobile.desktops.pairAnother')}</Text>
        </Pressable>
      </ScrollView>

      <Modal animationType="fade" transparent visible={selected !== null} onRequestClose={() => setSelected(null)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modal, { backgroundColor: palette.surface }]}>
            <Text style={[styles.modalTitle, { color: palette.label }]}>{t('mobile.desktops.optionsTitle')}</Text>
            <TextInput accessibilityLabel={t('mobile.desktops.nameLabel')} maxLength={MAX_DESKTOP_NAME} onChangeText={setName} value={name}
              style={[styles.input, { backgroundColor: palette.background, color: palette.label, borderColor: palette.separator }]} />
            <Pressable accessibilityRole="button" onPress={() => {
              if (selected) onRename(selected.id, name);
              setSelected(null);
            }} style={styles.modalButton}>
              <Text style={[styles.modalButtonText, { color: palette.accent }]}>{t('mobile.desktops.rename')}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => {
              if (selected) onForgetDesktop(selected);
              setSelected(null);
            }} style={styles.modalButton}>
              <Text style={[styles.modalButtonText, { color: palette.danger }]}>{t('mobile.common.forget')}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setSelected(null)} style={styles.modalButton}>
              <Text style={[styles.modalButtonText, { color: palette.secondaryLabel }]}>{t('mobile.common.cancel')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  header: { paddingHorizontal: 24, paddingTop: 20, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  headerText: { flexShrink: 1 },
  title: { fontSize: 34, lineHeight: 41, fontWeight: '700', letterSpacing: 0.2 },
  subtitle: { marginTop: 4, fontSize: 17, lineHeight: 22 },
  headerButton: { minHeight: 44, justifyContent: 'center', paddingLeft: 16 },
  headerButtonText: { fontSize: 17, lineHeight: 22, fontWeight: '500' },
  list: { paddingHorizontal: 20, paddingVertical: 12, gap: 12 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, overflow: 'hidden' },
  cardMain: { minHeight: 92, flexDirection: 'row', alignItems: 'center', padding: 16 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  cardText: { flex: 1 },
  cardTitle: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  cardState: { marginTop: 2, fontSize: 15, lineHeight: 20 },
  cardMetaRow: { marginTop: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  cardMeta: { fontSize: 13, lineHeight: 18 },
  options: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 },
  optionsText: { fontSize: 15, fontWeight: '600' },
  empty: { textAlign: 'center', paddingVertical: 40, fontSize: 17 },
  primary: { minHeight: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  primaryText: { fontSize: 17, fontWeight: '600' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.42)', justifyContent: 'center', padding: 24 },
  modal: { borderRadius: 22, padding: 20 },
  modalTitle: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  input: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 14, fontSize: 17, marginTop: 16 },
  modalButton: { minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  modalButtonText: { fontSize: 17, fontWeight: '600' }
});
