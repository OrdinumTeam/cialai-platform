import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgentId, ShellIntent } from '../bridge/messages';
import { COMMUNITIES, isCommunityUrl } from '../config/community';
import { orderDesktops, orderProjects } from '../dashboard/model';
import { chooseAccount, loadDashboard, toggleFavorite, useDashboard } from '../dashboard/store';
import { useNow } from '../dashboard/useNow';
import { formatAge } from '../desktops/format';
import type { DesktopEntry, DesktopStore } from '../desktops/store';
import { useI18n } from '../i18n';
import type { DesktopConnection } from '../state/machine';
import { useTokens } from '../theme';
import { EmptyState, PrimaryButton, Screen, SectionHeader, radius, space, typography } from '../ui';
import { AGENTS } from './agents/usage';
import { AgentUsageSheet, AgentUsageSummary } from './home/AgentUsage';
import { ComputerCarousel, ComputerMenu } from './home/Computers';
import { AddFavoritesCard, FavoritesSheet, ProjectFolderCard, ProjectSheet, ProjectSkeleton, type ProjectItem } from './home/Projects';
import { QuickActions } from './home/QuickActions';

// Pedido que o Início faz ao abrir o terminal; o App acrescenta o id.
export type IntentRequest = ShellIntent extends infer I ? I extends ShellIntent ? Omit<I, 'id'> : never : never;

type Props = {
  store: DesktopStore;
  describe: (desktopId: string) => DesktopConnection;
  // Computador cujo proxy ficou aberto ao sair do terminal; o card oferece desconectar.
  keptDesktopId: string | null;
  onContinue: (desktop: DesktopEntry) => void;
  onIntent: (desktop: DesktopEntry, intent: IntentRequest) => void;
  onDisconnect: () => void;
  onDesktops: () => void;
  onPair: () => void;
  onTerminal: () => void;
  onProjects: () => void;
};

const GRID_SIZE = 4;

// Marcas de terceiro, geradas por `tools/brand/build-community-glyphs.mjs` a
// partir do traçado oficial, o mesmo que o site usa. São pretas sobre
// transparente e a cor vem de `tintColor`, então servem aos dois temas.
const COMMUNITY_GLYPHS = {
  discord: require('../assets/discord.png'),
  whatsapp: require('../assets/whatsapp.png'),
};
// O rótulo visível é o nome da marca, curto como no site; o leitor de tela
// ouve a ação inteira. A cor de cada botão segue os botões suaves do site.
const COMMUNITY_LABELS = {
  discord: { visible: 'Discord', spoken: 'mobile.home.discord' },
  whatsapp: { visible: 'WhatsApp', spoken: 'mobile.home.whatsapp' },
} as const;
// Logo do cabeçalho, o mesmo do site: símbolo e nome numa arte só, recortada
// de brand/logo/cialai-lockup-1-4k.png.
const LOCKUP = require('../assets/cialai-lockup.png');
const LOCKUP_HEIGHT = 40;
const LOCKUP_WIDTH = Math.round(LOCKUP_HEIGHT * 238 / 120);

// Início: logo fixo no topo, uso dos agentes, computadores, projetos e atalhos. Os
// dados do computador vêm do último retrato que a página mandou; cada parte
// cai no próprio estado vazio sem bloquear as outras.
export function Home({ store, describe, keptDesktopId, onContinue, onIntent, onDisconnect, onDesktops, onPair, onTerminal, onProjects }: Props) {
  const { colors } = useTokens();
  const { locale, t } = useI18n();
  const dashboard = useDashboard();
  const now = useNow();
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [agentSheet, setAgentSheet] = useState<AgentId | null>(null);
  const [menuFor, setMenuFor] = useState<DesktopEntry | null>(null);
  const [projectSheet, setProjectSheet] = useState<ProjectItem | null>(null);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  useEffect(() => { void loadDashboard(); }, []);

  const desktops = orderDesktops(store.desktops, store.lastDesktopId, describe);
  const focused = desktops.find(desktop => desktop.id === focusedId) ?? desktops[0] ?? null;
  const entry = focused ? dashboard.desktops[focused.id] : undefined;
  const snapshot = entry?.snapshot ?? null;
  const favorites = entry?.favorites ?? [];
  const projects = orderProjects(snapshot?.projects ?? [], favorites);
  const favoriteProjects = projects.filter(project => project.favorite);
  const loading = !dashboard.loaded;
  const intent = (request: IntentRequest) => { if (focused) onIntent(focused, request); };

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

  let projectGrid: ReactNode;
  if (loading) {
    projectGrid = <View style={styles.grid}>{[0, 1].map(index => <ProjectSkeleton key={index} />)}</View>;
  } else if (!snapshot) {
    projectGrid = <Text style={[typography.callout, styles.note, { color: colors.textSecondary }]}>{t('mobile.home.projects.noSnapshot')}</Text>;
  } else if (!projects.length) {
    projectGrid = <Text style={[typography.callout, styles.note, { color: colors.textSecondary }]}>{t('mobile.home.projects.none')}</Text>;
  } else {
    const cells: ReactNode[] = favoriteProjects.length
      ? favoriteProjects.slice(0, GRID_SIZE).map(project => <ProjectFolderCard key={project.path} onOpen={setProjectSheet} project={project} />)
      : [<AddFavoritesCard key="add" onPress={() => setFavoritesOpen(true)} />,
        ...projects.slice(0, GRID_SIZE - 1).map(project => <ProjectFolderCard key={project.path} onOpen={setProjectSheet} project={project} />)];
    const rows: ReactNode[][] = [];
    for (let index = 0; index < cells.length; index += 2) rows.push(cells.slice(index, index + 2));
    projectGrid = rows.map((row, index) => (
      <View key={index} style={styles.grid}>{row}{row.length === 1 ? <View style={styles.spacer} /> : null}</View>
    ));
  }

  return (
    <Screen>
      {/* O cabeçalho fica fora da rolagem, como nas outras telas. */}
      <View style={styles.brand}>
        <Image accessibilityIgnoresInvertColors accessibilityLabel="Cialai" accessibilityRole="header" accessible resizeMode="contain"
          source={LOCKUP} style={styles.lockup} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>

        {!desktops.length ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <EmptyState action={{ label: t('mobile.home.quick.pair'), onPress: onPair, icon: 'qr-code' }}
              detail={t('mobile.home.empty.detail')} icon="laptop" title={t('mobile.home.empty.title')} />
          </View>
        ) : <>
          <View style={styles.agents}>
            {AGENTS.map(agent => (
              <AgentUsageSummary agent={agent} chosenId={entry?.accounts[agent]} key={agent} loading={loading} now={now}
                onOpen={setAgentSheet} snapshot={snapshot} />
            ))}
          </View>
          {snapshot ? (
            <Text style={[typography.caption, styles.updated, { color: colors.textTertiary }]}>
              {t('mobile.home.agent.updated', { age: formatAge(snapshot.at, now, locale, t) })}
            </Text>
          ) : null}

          <SectionHeader actionAccessibilityLabel={t('mobile.home.openDesktops')} actionLabel={t('mobile.common.seeAll')} onAction={onDesktops}
            title={t('mobile.home.desktops')} />
          <ComputerCarousel describe={describe} desktops={desktops} keptDesktopId={keptDesktopId} onDisconnect={onDisconnect}
            onFocus={setFocusedId} onMenu={setMenuFor} onOpen={onContinue} />

          <SectionHeader actionAccessibilityLabel={t('mobile.home.projects.seeAll')} actionLabel={t('mobile.common.seeAll')} onAction={onProjects}
            title={t('mobile.home.projects')} />
          {projectGrid}
          {snapshot && favoriteProjects.length ? (
            <PrimaryButton accessibilityLabel={t('mobile.home.projects.manage')} icon="star" label={t('mobile.home.projects.manage')}
              onPress={() => setFavoritesOpen(true)} style={styles.manage} />
          ) : null}
        </>}

        <SectionHeader title={t('mobile.home.quick.title')} />
        <QuickActions actions={[
          { icon: 'plus', label: t('mobile.home.quick.short.newSession'), accessibilityLabel: t('mobile.home.quick.newSession'),
            onPress: () => intent({ kind: 'new-session' }), disabled: !focused },
          { icon: 'qr-code', label: t('mobile.home.quick.short.pair'), accessibilityLabel: t('mobile.home.quick.pair'), onPress: onPair },
          { icon: 'terminal', label: t('mobile.home.quick.short.terminals'), accessibilityLabel: t('mobile.home.quick.terminals'),
            onPress: onTerminal, disabled: !focused },
          { icon: 'bot', label: t('mobile.home.quick.short.agents'), accessibilityLabel: t('mobile.home.quick.agents'),
            onPress: () => intent({ kind: 'profiles' }), disabled: !focused }
        ]} />

        <View style={styles.community}>
          <Text accessibilityRole="header" style={[typography.headline, { color: colors.text }]}>{t('mobile.home.community')}</Text>
          <Text style={[typography.footnote, { color: colors.textSecondary }]}>{t('mobile.home.communityHint')}</Text>
          <View style={styles.communityRow}>
            {COMMUNITIES.map(space => {
              const label = COMMUNITY_LABELS[space.id];
              return (
                <Pressable accessibilityLabel={t(label.spoken)} accessibilityRole="link" key={space.id} onPress={() => openCommunity(space.url)}
                  style={({ pressed }) => [styles.communityButton, { backgroundColor: pressed ? colors.primarySoftPressed : colors.primarySoft }]}>
                  <Image accessibilityIgnoresInvertColors resizeMode="contain" source={COMMUNITY_GLYPHS[space.id]}
                    style={[styles.communityGlyph, { tintColor: colors.text }]} />
                  <Text numberOfLines={1} style={[typography.callout, styles.communityLabel, { color: colors.text }]}>{label.visible}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </ScrollView>

      <AgentUsageSheet agent={agentSheet} chosenId={agentSheet ? entry?.accounts[agentSheet] : undefined} now={now} onClose={() => setAgentSheet(null)}
        onChoose={(agent, accountId) => { if (focused) chooseAccount(focused.id, agent, accountId); }}
        onManage={() => { setAgentSheet(null); intent({ kind: 'profiles' }); }} snapshot={snapshot} />
      <ComputerMenu desktop={menuFor} kept={!!menuFor && keptDesktopId === menuFor.id} onClose={() => setMenuFor(null)}
        onDesktops={onDesktops} onDisconnect={onDisconnect} onOpen={onContinue} />
      <ProjectSheet onClose={() => setProjectSheet(null)}
        onContinue={sessionId => intent({ kind: 'session', sessionId })} onNewSession={cwd => intent({ kind: 'new-session', cwd })}
        onToggleFavorite={path => {
          if (!focused) return;
          toggleFavorite(focused.id, path);
          setProjectSheet(current => current && current.path === path ? { ...current, favorite: !current.favorite } : current);
        }}
        project={projectSheet} snapshot={snapshot} />
      <FavoritesSheet onClose={() => setFavoritesOpen(false)} onToggle={path => { if (focused) toggleFavorite(focused.id, path); }}
        projects={projects} visible={favoritesOpen} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg, paddingTop: space.xxs, paddingBottom: space.xl, gap: space.sm },
  brand: { minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg },
  lockup: { width: LOCKUP_WIDTH, height: LOCKUP_HEIGHT },
  agents: { flexDirection: 'row', gap: space.sm, alignItems: 'stretch' },
  updated: { textAlign: 'right', marginTop: -4 },
  grid: { flexDirection: 'row', gap: space.sm },
  spacer: { flex: 1 },
  note: { paddingVertical: space.xs },
  manage: { minHeight: 44 },
  emptyCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg },
  community: { marginTop: space.xs, gap: 2 },
  communityRow: { marginTop: space.xs, flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  // Botão suave do site: fundo rosa claro, texto e marca escuros, raio dos botões.
  communityButton: { flexGrow: 1, flexBasis: '46%', minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs,
    paddingHorizontal: space.md, borderRadius: radius.control },
  communityGlyph: { width: 18, height: 18 },
  communityLabel: { fontWeight: '600' }
});
