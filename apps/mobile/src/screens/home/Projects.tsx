import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { DashboardMessage, DashboardProject } from '../../bridge/messages';
import { projectTint, sessionsIn, shortPath } from '../../dashboard/model';
import { useI18n } from '../../i18n';
import { useTokens } from '../../theme';
import { BottomSheet, ChoiceRow, Icon, IconButton, PrimaryButton, SearchInput, SecondaryButton, SkeletonLoader, radius, space, typography } from '../../ui';
import { FolderIllustration, tintCover } from '../../ui/Illustrations';

export type ProjectItem = DashboardProject & { favorite: boolean };

type CardProps = {
  project: ProjectItem;
  onOpen: (project: ProjectItem) => void;
  // Computador da pasta, quando a tela mistura mais de um.
  computerName?: string;
  // Sessões abertas na pasta segundo o último retrato.
  sessionCount?: number;
};

// Cartão de pasta das referências: capa com a pasta e as folhas num tom
// próprio do projeto, nome embaixo, estrela de favorito, botão rosa e menu.
// Embaixo do nome vão só dados reais: caminho curto, computador e sessões.
export function ProjectFolderCard({ project, onOpen, computerName, sessionCount = 0 }: CardProps) {
  const { colors, scheme, shadow } = useTokens();
  const { t } = useI18n();
  const tint = projectTint(project.name);
  const details = [computerName, sessionCount ? t(sessionCount === 1 ? 'mobile.projects.sessions.one' : 'mobile.projects.sessions.many', { count: sessionCount }) : '']
    .filter(Boolean).join(' · ');
  return (
    <View style={[styles.card, shadow.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Pressable accessibilityLabel={t('mobile.home.projects.open', { name: project.name })} accessibilityRole="button"
        onPress={() => onOpen(project)} style={({ pressed }) => [styles.cover, { backgroundColor: tintCover(scheme, tint) }, pressed && styles.pressed]}>
        <FolderIllustration tint={tint} width={112} />
        {project.favorite ? (
          <View accessibilityLabel={t('mobile.home.projects.favoritesTitle')} accessible style={[styles.star, { backgroundColor: colors.surface }]}>
            <Icon color={colors.warning} filled name="star" size={14} />
          </View>
        ) : null}
        <View style={[styles.go, { backgroundColor: colors.primary }]}>
          <Icon color={colors.onPrimary} name="arrow-right" size={16} strokeWidth={2.2} />
        </View>
      </Pressable>
      <View style={styles.foot}>
        <View style={styles.flex}>
          <Text numberOfLines={1} style={[typography.headline, { color: colors.text }]}>{project.name}</Text>
          <Text numberOfLines={1} style={[typography.caption, { color: colors.textSecondary }]}>{shortPath(project.path)}</Text>
          {details ? <Text numberOfLines={1} style={[typography.caption, { color: colors.textSecondary }]}>{details}</Text> : null}
        </View>
        <IconButton accessibilityLabel={t('mobile.desktops.optionsFor', { name: project.name })} icon="ellipsis-vertical"
          onPress={() => onOpen(project)} tint={colors.textSecondary} />
      </View>
    </View>
  );
}

export function AddFavoritesCard({ onPress }: { onPress: () => void }) {
  const { colors } = useTokens();
  const { t } = useI18n();
  return (
    <Pressable accessibilityRole="button" onPress={onPress}
      style={({ pressed }) => [styles.card, styles.add, { borderColor: colors.primary, backgroundColor: pressed ? colors.primarySoftPressed : colors.primarySoft }]}>
      <View style={[styles.addIcon, { backgroundColor: colors.surface }]}><Icon color={colors.primary} name="star" size={22} /></View>
      <Text numberOfLines={2} style={[typography.headline, styles.center, { color: colors.primary }]}>{t('mobile.home.projects.addFavorites')}</Text>
      <Text numberOfLines={3} style={[typography.caption, styles.center, { color: colors.textSecondary }]}>{t('mobile.home.projects.addHint')}</Text>
    </Pressable>
  );
}

export function ProjectSkeleton() {
  const { colors } = useTokens();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <SkeletonLoader height={92} style={styles.skeletonCover} />
      <View style={styles.foot}><SkeletonLoader width="70%" /></View>
    </View>
  );
}

type SheetProps = {
  project: ProjectItem | null;
  snapshot: DashboardMessage | null;
  computerName?: string;
  onContinue: (sessionId: string) => void;
  onNewSession: (cwd: string) => void;
  onToggleFavorite: (path: string) => void;
  // Só na tela Projetos: reordenar e remover o atalho de um favorito.
  onMove?: (path: string, delta: -1 | 1) => void;
  canMove?: { up: boolean; down: boolean };
  onRemove?: (path: string) => void;
  onClose: () => void;
};

// Ao tocar num projeto: retomar uma sessão aberta naquela pasta ou abrir outra.
// Nada começa sozinho: cada sessão nova sai de um toque aqui e da página.
export function ProjectSheet({ project, snapshot, computerName, onContinue, onNewSession, onToggleFavorite, onMove, canMove, onRemove, onClose }: SheetProps) {
  const { colors } = useTokens();
  const { t } = useI18n();
  const sessions = project ? sessionsIn(snapshot, project.path) : [];
  const run = (action: () => void) => () => { onClose(); action(); };
  return (
    <BottomSheet onClose={onClose} title={project?.name ?? ''} visible={!!project}>
      {project ? <>
        {computerName ? <Text numberOfLines={1} style={[typography.callout, { color: colors.text }]}>{computerName}</Text> : null}
        <Text numberOfLines={2} selectable style={[typography.footnote, { color: colors.textSecondary }]}>{project.path}</Text>
        {sessions.length ? sessions.map(session => (
          <SecondaryButton icon="terminal" key={session.id} label={t('mobile.home.projects.continue', { name: session.name || project.name })}
            onPress={run(() => onContinue(session.id))} variant="soft" />
        )) : <Text style={[typography.callout, { color: colors.textSecondary }]}>{t('mobile.home.projects.noSessions')}</Text>}
        <PrimaryButton icon="plus" label={t('mobile.home.projects.newSession')} onPress={run(() => onNewSession(project.path))} />
        {project.favorite && onRemove ? <>
          {onMove ? (
            <View style={styles.moveRow}>
              <SecondaryButton disabled={!canMove?.up} icon="arrow-up" label={t('mobile.projects.moveUp')}
                onPress={() => onMove(project.path, -1)} style={styles.flex} variant="neutral" />
              <SecondaryButton disabled={!canMove?.down} icon="arrow-down" label={t('mobile.projects.moveDown')}
                onPress={() => onMove(project.path, 1)} style={styles.flex} variant="neutral" />
            </View>
          ) : null}
          <SecondaryButton icon="trash" label={t('mobile.projects.remove')} onPress={run(() => onRemove(project.path))} variant="neutral" />
          <Text style={[typography.caption, { color: colors.textSecondary }]}>{t('mobile.projects.removeHint')}</Text>
        </> : (
          <SecondaryButton icon="star" label={t(project.favorite ? 'mobile.home.projects.unfavorite' : 'mobile.home.projects.favorite', { name: project.name })}
            onPress={() => onToggleFavorite(project.path)} variant="neutral" />
        )}
      </> : null}
    </BottomSheet>
  );
}

type FavoritesProps = {
  visible: boolean;
  projects: readonly ProjectItem[];
  onToggle: (path: string) => void;
  onClose: () => void;
};

// Escolha dos favoritos entre as pastas que o computador listou.
export function FavoritesSheet({ visible, projects, onToggle, onClose }: FavoritesProps) {
  const { colors, scheme } = useTokens();
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const term = query.trim().toLocaleLowerCase();
  const shown = term ? projects.filter(project => `${project.name} ${project.path}`.toLocaleLowerCase().includes(term)) : projects;
  return (
    <BottomSheet onClose={onClose} title={t('mobile.home.projects.favoritesTitle')} visible={visible}>
      <SearchInput onChangeText={setQuery} placeholder={t('mobile.home.projects.searchPlaceholder')} value={query} />
      {shown.map(project => (
        <ChoiceRow accessibilityLabel={t(project.favorite ? 'mobile.home.projects.unfavorite' : 'mobile.home.projects.favorite', { name: project.name })}
          accessibilityRole="checkbox" checked={project.favorite} detail={project.root || undefined} key={project.path}
          leading={(
            <View style={[styles.rowIcon, { backgroundColor: tintCover(scheme, projectTint(project.name)) }]}>
              <Icon color={colors.primary} name="folder" size={18} />
            </View>
          )}
          onPress={() => onToggle(project.path)} title={project.name}
          trailing={<Icon color={project.favorite ? colors.warning : colors.textTertiary} filled={project.favorite} name="star" size={22} />} />
      ))}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, minWidth: 0, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.xs, gap: space.xs },
  cover: { height: 104, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  pressed: { opacity: 0.8 },
  star: { position: 'absolute', top: space.xs, left: space.xs, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  go: { position: 'absolute', right: space.xs, bottom: space.xs, width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  foot: { flexDirection: 'row', alignItems: 'center', paddingLeft: space.xxs, minHeight: 44 },
  flex: { flex: 1, minWidth: 0 },
  add: { borderWidth: 1, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', minHeight: 164, padding: space.sm },
  addIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center' },
  skeletonCover: { borderRadius: radius.md },
  moveRow: { flexDirection: 'row', gap: space.sm },
  rowIcon: { width: 34, height: 34, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' }
});
