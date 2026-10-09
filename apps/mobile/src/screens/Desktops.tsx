import { useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { formatLastSeen } from '../desktops/format';
import { MAX_DESKTOP_NAME, type DesktopEntry, type DesktopStore } from '../desktops/store';
import { useI18n } from '../i18n';
import type { DesktopConnection, DesktopConnectionState } from '../state/machine';
import { useTokens } from '../theme';
import {
  ActionList, AppHeader, BottomSheet, ComputerCard, EmptyState, PrimaryButton, Screen, SearchInput, SegmentedControl,
  radius, space, typography, type Meta, type Tone
} from '../ui';
import type { IntentRequest } from './Home';
import { TRANSPORT_DESCRIPTION_KEYS, TRANSPORT_KEYS } from './TransportBadge';

type Props = {
  store: DesktopStore;
  describe: (desktopId: string) => DesktopConnection;
  // Computador cujo proxy ficou aberto ao sair do terminal: o menu oferece desconectar.
  keptDesktopId: string | null;
  onOpen: (desktop: DesktopEntry) => void;
  onIntent: (desktop: DesktopEntry, intent: IntentRequest) => void;
  onHome: () => void;
  onPair: () => void;
  onDisconnect: () => void;
  onRename: (desktopId: string, name: string) => void;
  onForgetDesktop: (desktop: DesktopEntry) => void;
};

type Filter = 'all' | 'connected' | 'disconnected';

export const STATE_KEYS: Readonly<Record<DesktopConnectionState, string>> = {
  idle: 'mobile.desktops.state.idle',
  connecting: 'mobile.desktops.state.connecting',
  connected: 'mobile.desktops.state.connected',
  offline: 'mobile.desktops.state.offline',
  removed: 'mobile.desktops.state.removed'
};

export const STATE_TONES: Readonly<Record<DesktopConnectionState, Tone>> = {
  connected: 'success', connecting: 'warning', idle: 'neutral', offline: 'danger', removed: 'danger'
};

const online = (state: DesktopConnectionState) => state === 'connected' || state === 'connecting';

// Busca sem acento nem caixa, como a lista de sessões da página.
const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// O computador em uso: o que ficou com o proxy aberto, senão o conectado,
// senão o último aberto.
export function activeDesktopId(store: DesktopStore, keptDesktopId: string | null,
  describe: (desktopId: string) => DesktopConnection): string | null {
  if (keptDesktopId && store.desktops.some(desktop => desktop.id === keptDesktopId)) return keptDesktopId;
  return store.desktops.find(desktop => describe(desktop.id).state === 'connected')?.id ?? store.lastDesktopId;
}

export function Desktops({ store, describe, keptDesktopId, onOpen, onIntent, onHome, onPair, onDisconnect, onRename, onForgetDesktop }: Props) {
  const { colors } = useTokens();
  const { locale, t } = useI18n();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<DesktopEntry | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');

  const states = new Map(store.desktops.map(desktop => [desktop.id, describe(desktop.id)]));
  const activeId = activeDesktopId(store, keptDesktopId, describe);
  const connectedCount = store.desktops.filter(desktop => online(states.get(desktop.id)!.state)).length;
  const needle = fold(query.trim());
  const visible = store.desktops.filter(desktop => {
    const state = states.get(desktop.id)!.state;
    if (filter === 'connected' && !online(state)) return false;
    if (filter === 'disconnected' && online(state)) return false;
    return !needle || fold(desktop.name).includes(needle);
  });

  const closeMenu = () => { setMenuFor(null); setRenaming(false); };
  const run = (action: () => void) => () => { closeMenu(); action(); };

  return (
    <Screen>
      <AppHeader actions={[{ icon: 'plus', accessibilityLabel: t('mobile.desktops.pair'), onPress: onPair }]}
        backLabel={t('mobile.home.open')} onBack={onHome} title={t('mobile.desktops.title')} />

      {store.desktops.length ? (
        <View style={styles.controls}>
          <SegmentedControl onChange={setFilter} value={filter} variant="separate" options={[
            { value: 'all', label: t('mobile.desktops.filter.all') },
            { value: 'connected', label: t('mobile.desktops.filter.connected'), count: connectedCount },
            { value: 'disconnected', label: t('mobile.desktops.filter.disconnected') }
          ]} />
          <SearchInput accessibilityLabel={t('mobile.desktops.search')} onChangeText={setQuery} placeholder={t('mobile.desktops.search')} value={query} />
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
        {visible.map(desktop => {
          const connection = states.get(desktop.id)!;
          const transport = connection.state === 'connected' ? connection.transport
            : desktop.lastTransport === '' ? null : desktop.lastTransport;
          const lastSeen = formatLastSeen(desktop.lastSeenAt, locale);
          // Só o que o computador informa de verdade: o caminho e o último acesso.
          const meta: Meta[] = [];
          if (transport === 'direct') meta.push({ icon: 'zap', label: t(TRANSPORT_KEYS.direct) });
          meta.push({ icon: 'clock', label: lastSeen ? t('mobile.desktops.lastSeen', { date: lastSeen }) : t('mobile.desktops.never') });
          const active = desktop.id === activeId;
          return (
            <ComputerCard key={desktop.id} name={desktop.name} meta={meta} selected={active}
              accessibilityLabel={active ? t('mobile.desktops.activeLabel', { name: desktop.name }) : desktop.name}
              badge={transport === 'tor' ? { label: t(TRANSPORT_KEYS.tor), tone: 'warning', accessibilityLabel: t(TRANSPORT_DESCRIPTION_KEYS.tor) } : undefined}
              disabled={connection.state === 'connecting'}
              moreLabel={t('mobile.desktops.optionsFor', { name: desktop.name })}
              onMore={() => { setMenuFor(desktop); setName(desktop.name); setRenaming(false); }}
              onPress={() => onOpen(desktop)}
              status={{ label: t(STATE_KEYS[connection.state]), tone: STATE_TONES[connection.state] }} />
          );
        })}
        {!store.desktops.length ? (
          <EmptyState action={{ label: t('mobile.desktops.pair'), onPress: onPair, icon: 'qr-code' }} detail={t('mobile.desktops.emptyDetail')}
            icon="laptop" title={t('mobile.desktops.empty')} />
        ) : !visible.length ? (
          <EmptyState detail={t('mobile.desktops.noResultsDetail')} icon="search" title={t('mobile.desktops.noResults')} />
        ) : null}
      </ScrollView>

      <BottomSheet onClose={closeMenu} title={menuFor?.name ?? ''} visible={menuFor !== null}>
        {menuFor && renaming ? (
          <View style={styles.rename}>
            <TextInput accessibilityLabel={t('mobile.desktops.nameLabel')} autoFocus maxLength={MAX_DESKTOP_NAME} onChangeText={setName}
              returnKeyType="done" selectTextOnFocus value={name}
              style={[typography.body, styles.input, { backgroundColor: colors.surfaceMuted, color: colors.text, borderColor: colors.border }]} />
            <PrimaryButton disabled={!name.trim()} label={t('mobile.desktops.saveName')} onPress={run(() => onRename(menuFor.id, name))} />
          </View>
        ) : menuFor ? (
          <ActionList groups={[
            [
              { key: 'open', icon: 'terminal', label: t('mobile.home.openTerminalButton'), onPress: run(() => onOpen(menuFor)),
                disabled: states.get(menuFor.id)?.state === 'connecting' },
              { key: 'new', icon: 'plus', label: t('mobile.home.quick.newSession'), onPress: run(() => onIntent(menuFor, { kind: 'new-session' })) },
              { key: 'agents', icon: 'bot', label: t('mobile.home.quick.agents'), onPress: run(() => onIntent(menuFor, { kind: 'profiles' })) }
            ],
            [
              { key: 'rename', icon: 'pencil', label: t('mobile.desktops.rename'), onPress: () => setRenaming(true) },
              ...(keptDesktopId === menuFor.id
                ? [{ key: 'disconnect', icon: 'unplug' as const, label: t('mobile.home.disconnect'), onPress: run(onDisconnect) }] : [])
            ],
            [
              { key: 'forget', icon: 'trash', label: t('mobile.common.forget'), destructive: true, onPress: run(() => onForgetDesktop(menuFor)) }
            ]
          ]} />
        ) : null}
      </BottomSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  controls: { paddingHorizontal: space.lg, paddingTop: space.xs, gap: space.sm },
  list: { flexGrow: 1, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xl, gap: space.sm },
  rename: { gap: space.sm },
  input: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.md }
});
