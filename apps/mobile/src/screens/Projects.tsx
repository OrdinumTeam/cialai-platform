import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { projectSections, sessionsIn, type ProjectEntry } from '../dashboard/model';
import { loadDashboard, moveFavorite, removeFavorite, toggleFavorite, useDashboard } from '../dashboard/store';
import type { DesktopEntry } from '../desktops/store';
import { useI18n } from '../i18n';
import { useTokens } from '../theme';
import { AppHeader, BottomSheet, ChoiceRow, EmptyState, Icon, Screen, SearchInput, SectionHeader, SegmentedControl, space, typography } from '../ui';
import type { IntentRequest } from './Home';
import { ProjectFolderCard, ProjectSheet } from './home/Projects';

type Props = {
  desktops: readonly DesktopEntry[];
  onBack: () => void;
  onTerminal: () => void;
  onIntent: (desktop: DesktopEntry, intent: IntentRequest) => void;
};

const ALL = 'all';

// Aba de projetos: atalhos das pastas de cada computador, a partir do último
// retrato que a página mandou. Favoritos na ordem do usuário, depois as pastas
// recentes e o restante. Remover um atalho só mexe neste celular.
export function Projects({ desktops, onBack, onTerminal, onIntent }: Props) {
  const { colors } = useTokens();
  const { t } = useI18n();
  const dashboard = useDashboard();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<string>(ALL);
  const [selected, setSelected] = useState<{ project: ProjectEntry; desktop: DesktopEntry } | null>(null);
  const [choosingDesktop, setChoosingDesktop] = useState(false);
  useEffect(() => { void loadDashboard(); }, []);

  const known = desktops.filter(desktop => dashboard.desktops[desktop.id]?.snapshot);
  const shown = filter === ALL ? known : desktops.filter(desktop => desktop.id === filter);
  const grouped = filter === ALL && known.length > 1;
  const current = selected ? dashboard.desktops[selected.desktop.id] : undefined;
  const favorites = current?.favorites ?? [];
  const position = selected ? favorites.indexOf(selected.project.path) : -1;

  const addProject = () => {
    const target = filter === ALL ? (desktops.length === 1 ? desktops[0] : null) : desktops.find(desktop => desktop.id === filter);
    if (target) onIntent(target, { kind: 'pick-project' });
    else setChoosingDesktop(true);
  };

  const grid = (desktop: DesktopEntry, items: readonly ProjectEntry[]) => {
    const snapshot = dashboard.desktops[desktop.id]?.snapshot ?? null;
    const rows: ProjectEntry[][] = [];
    for (let index = 0; index < items.length; index += 2) rows.push(items.slice(index, index + 2));
    return rows.map(row => (
      <View key={row[0]!.path} style={styles.row}>
        {row.map(project => (
          <ProjectFolderCard computerName={desktop.name} key={project.path} onOpen={item => setSelected({ project: item, desktop })}
            project={project} sessionCount={sessionsIn(snapshot, project.path).length} />
        ))}
        {row.length === 1 ? <View style={styles.spacer} /> : null}
      </View>
    ));
  };

  const body = shown.map(desktop => {
    const entry = dashboard.desktops[desktop.id];
    const snapshot = entry?.snapshot ?? null;
    const sections = projectSections(snapshot, entry?.favorites ?? [], query);
    const empty = !sections.favorites.length && !sections.recent.length && !sections.all.length;
    return (
      <View key={desktop.id} style={styles.group}>
        {grouped ? <Text accessibilityRole="header" numberOfLines={1} style={[typography.title, { color: colors.text }]}>{desktop.name}</Text> : null}
        {!snapshot ? <Text style={[typography.callout, { color: colors.textSecondary }]}>{t('mobile.home.projects.noSnapshot')}</Text>
          : empty ? <Text style={[typography.callout, { color: colors.textSecondary }]}>
            {t(query.trim() ? 'mobile.projects.noMatch' : 'mobile.home.projects.none')}</Text>
            : <>
              {sections.favorites.length ? <><SectionHeader title={t('mobile.projects.favorites')} />{grid(desktop, sections.favorites)}</> : null}
              {sections.recent.length ? <><SectionHeader title={t('mobile.projects.recent')} />{grid(desktop, sections.recent)}</> : null}
              {sections.all.length ? <><SectionHeader title={t('mobile.projects.all')} />{grid(desktop, sections.all)}</> : null}
            </>}
      </View>
    );
  });

  return (
    <Screen>
      <AppHeader actions={desktops.length ? [{ icon: 'plus', accessibilityLabel: t('mobile.projects.add'), onPress: addProject }] : []}
        backLabel={t('mobile.home.open')} onBack={onBack} title={t('mobile.projects.title')} />
      {!known.length ? (
        <ScrollView contentContainerStyle={styles.empty}>
          <EmptyState action={{ label: t('mobile.home.openTerminal'), onPress: onTerminal, icon: 'terminal' }}
            detail={t('mobile.projects.emptyDetail')} icon="folder" title={t('mobile.projects.emptyTitle')} />
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <SearchInput onChangeText={setQuery} placeholder={t('mobile.home.projects.searchPlaceholder')} value={query} />
          {desktops.length > 1 ? (
            <SegmentedControl onChange={setFilter} value={filter} scrollable variant="separate"
              options={[{ value: ALL, label: t('mobile.projects.allComputers') }, ...desktops.map(desktop => ({ value: desktop.id, label: desktop.name }))]} />
          ) : null}
          {body}
        </ScrollView>
      )}
      <ProjectSheet canMove={{ up: position > 0, down: position >= 0 && position < favorites.length - 1 }}
        computerName={selected?.desktop.name} onClose={() => setSelected(null)}
        onContinue={sessionId => { if (selected) onIntent(selected.desktop, { kind: 'session', sessionId }); }}
        onMove={(path, delta) => { if (selected) moveFavorite(selected.desktop.id, path, delta); }}
        onNewSession={cwd => { if (selected) onIntent(selected.desktop, { kind: 'new-session', cwd }); }}
        onRemove={path => { if (selected) removeFavorite(selected.desktop.id, path); }}
        onToggleFavorite={path => {
          if (!selected) return;
          toggleFavorite(selected.desktop.id, path);
          setSelected(value => value && value.project.path === path ? { ...value, project: { ...value.project, favorite: !value.project.favorite } } : value);
        }}
        project={selected?.project ?? null} snapshot={current?.snapshot ?? null} />
      <BottomSheet onClose={() => setChoosingDesktop(false)} title={t('mobile.projects.addOn')} visible={choosingDesktop}>
        {desktops.map(desktop => (
          <ChoiceRow icon="laptop" key={desktop.id} onPress={() => { setChoosingDesktop(false); onIntent(desktop, { kind: 'pick-project' }); }}
            title={desktop.name} trailing={<Icon color={colors.textTertiary} name="chevron-right" size={18} />} />
        ))}
      </BottomSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  empty: { flexGrow: 1 },
  content: { paddingHorizontal: space.lg, paddingBottom: space.xl, gap: space.sm },
  group: { gap: space.sm },
  row: { flexDirection: 'row', gap: space.sm },
  spacer: { flex: 1 },
  flex: { flex: 1, minWidth: 0 }
});
