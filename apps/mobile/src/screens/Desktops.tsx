import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { TunnelStatus } from 'cialai-tunnel';

import type { DesktopProfile, HeadscaleProfile, ProfileStore } from '../profiles/store';
import { usePalette } from '../theme';

type Props = {
  store: ProfileStore;
  tunnelStatus: TunnelStatus | null;
  onOpen: (profile: HeadscaleProfile, desktop: DesktopProfile) => void;
  onPair: () => void;
  onSettings: () => void;
  onSwitchProfile: (profile: HeadscaleProfile) => void;
  onRename: (desktopId: string, name: string) => void;
  onForgetDesktop: (profile: HeadscaleProfile, desktop: DesktopProfile) => void;
};

function formatLastSeen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Nunca acessado';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

export function Desktops({
  store, tunnelStatus, onOpen, onPair, onSettings, onSwitchProfile, onRename, onForgetDesktop
}: Props) {
  const palette = usePalette();
  const activeProfile = store.profiles.find(profile => profile.id === store.lastProfileId) ?? store.profiles[0];
  const [selected, setSelected] = useState<{ profile: HeadscaleProfile; desktop: DesktopProfile } | null>(null);
  const [name, setName] = useState('');
  const peerMap = useMemo(() => new Map(tunnelStatus?.peers.map(peer => [peer.nodeKey, peer]) ?? []), [tunnelStatus]);

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: palette.background }]}>
      <View style={styles.header}>
        <View>
          <Text accessibilityRole="header" style={[styles.title, { color: palette.label }]}>Computadores</Text>
          <Text style={[styles.subtitle, { color: palette.secondaryLabel }]}>Escolha onde deseja continuar</Text>
        </View>
        <Pressable accessibilityLabel="Abrir ajustes" accessibilityRole="button" onPress={onSettings} style={styles.headerButton}>
          <Text style={[styles.headerButtonText, { color: palette.accent }]}>Ajustes</Text>
        </Pressable>
      </View>

      {store.profiles.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.profiles}>
          {store.profiles.map(profile => {
            const active = profile.id === activeProfile?.id;
            return (
              <Pressable accessibilityRole="button" key={profile.id} onPress={() => onSwitchProfile(profile)}
                style={[styles.profileChip, { backgroundColor: active ? palette.accent : palette.surface, borderColor: palette.separator }]}>
                <Text style={{ color: active ? palette.accentText : palette.label, fontWeight: '600' }}>{profile.userName}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      <ScrollView contentContainerStyle={styles.list}>
        {activeProfile?.desktops.map(desktop => {
          const peer = peerMap.get(desktop.nodeKey);
          const online = peer?.online === true;
          return (
            <View key={desktop.id} style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.separator }]}>
              <Pressable accessibilityRole="button" onPress={() => onOpen(activeProfile, desktop)} style={styles.cardMain}>
                <View style={[styles.dot, { backgroundColor: online ? palette.success : palette.tertiaryLabel }]} />
                <View style={styles.cardText}>
                  <Text style={[styles.cardTitle, { color: palette.label }]}>{desktop.name}</Text>
                  <Text style={[styles.cardMeta, { color: palette.secondaryLabel }]}>
                    {online ? 'Disponível' : 'Fora de alcance'}
                  </Text>
                  <Text style={[styles.cardMeta, { color: palette.tertiaryLabel }]}>Último acesso {formatLastSeen(desktop.lastSeenAt)}</Text>
                </View>
              </Pressable>
              <Pressable accessibilityLabel={`Opções de ${desktop.name}`} accessibilityRole="button"
                onPress={() => { setSelected({ profile: activeProfile, desktop }); setName(desktop.name); }} style={styles.options}>
                <Text style={[styles.optionsText, { color: palette.accent }]}>Opções</Text>
              </Pressable>
            </View>
          );
        })}
        {!activeProfile?.desktops.length ? (
          <Text style={[styles.empty, { color: palette.secondaryLabel }]}>Nenhum computador neste perfil</Text>
        ) : null}
        <Pressable accessibilityRole="button" onPress={onPair}
          style={({ pressed }) => [styles.primary, { backgroundColor: pressed ? palette.accentPressed : palette.accent }]}>
          <Text style={[styles.primaryText, { color: palette.accentText }]}>Vincular outro</Text>
        </Pressable>
      </ScrollView>

      <Modal animationType="fade" transparent visible={selected !== null} onRequestClose={() => setSelected(null)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modal, { backgroundColor: palette.surface }]}>
            <Text style={[styles.modalTitle, { color: palette.label }]}>Opções do computador</Text>
            <TextInput accessibilityLabel="Nome do computador" maxLength={48} onChangeText={setName} value={name}
              style={[styles.input, { backgroundColor: palette.background, color: palette.label, borderColor: palette.separator }]} />
            <Pressable accessibilityRole="button" onPress={() => {
              if (selected) onRename(selected.desktop.id, name);
              setSelected(null);
            }} style={styles.modalButton}>
              <Text style={[styles.modalButtonText, { color: palette.accent }]}>Renomear</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => {
              if (selected) onForgetDesktop(selected.profile, selected.desktop);
              setSelected(null);
            }} style={styles.modalButton}>
              <Text style={[styles.modalButtonText, { color: palette.danger }]}>Esquecer</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setSelected(null)} style={styles.modalButton}>
              <Text style={[styles.modalButtonText, { color: palette.secondaryLabel }]}>Cancelar</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  header: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 30, lineHeight: 36, fontWeight: '700' },
  subtitle: { marginTop: 3, fontSize: 15 },
  headerButton: { minHeight: 44, justifyContent: 'center', paddingLeft: 16 },
  headerButtonText: { fontSize: 16, fontWeight: '600' },
  profiles: { paddingHorizontal: 22, gap: 8, paddingBottom: 10 },
  profileChip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingVertical: 8, paddingHorizontal: 14 },
  list: { padding: 18, gap: 12 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, overflow: 'hidden' },
  cardMain: { minHeight: 92, flexDirection: 'row', alignItems: 'center', padding: 16 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  cardText: { flex: 1 },
  cardTitle: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  cardMeta: { marginTop: 2, fontSize: 13, lineHeight: 18 },
  options: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 },
  optionsText: { fontSize: 15, fontWeight: '600' },
  empty: { textAlign: 'center', paddingVertical: 40, fontSize: 16 },
  primary: { minHeight: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  primaryText: { fontSize: 17, fontWeight: '600' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.42)', justifyContent: 'center', padding: 24 },
  modal: { borderRadius: 22, padding: 20 },
  modalTitle: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  input: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 14, fontSize: 17, marginTop: 16 },
  modalButton: { minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  modalButtonText: { fontSize: 17, fontWeight: '600' }
});
