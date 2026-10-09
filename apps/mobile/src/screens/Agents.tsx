import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgentId } from '../bridge/messages';
import { agentAccounts, orderDesktops } from '../dashboard/model';
import { chooseAccount, loadDashboard, useDashboard } from '../dashboard/store';
import { useNow } from '../dashboard/useNow';
import { formatAge } from '../desktops/format';
import type { DesktopEntry, DesktopStore } from '../desktops/store';
import { useI18n } from '../i18n';
import type { DesktopConnection } from '../state/machine';
import { useTokens } from '../theme';
import { AgentGlyph } from '../ui/AgentGlyph';
import { AppHeader, Card, EmptyState, Notice, Screen, SecondaryButton, SegmentedControl, space, typography } from '../ui';
import { AccountCard, AccountCardSkeleton } from './agents/AccountCard';
import { AGENT_NAME_KEYS, AGENTS } from './agents/usage';
import type { IntentRequest } from './Home';
import { AgentUsageSheet } from './home/AgentUsage';

type Props = {
  store: DesktopStore;
  describe: (desktopId: string) => DesktopConnection;
  onBack: () => void;
  onPair: () => void;
  onIntent: (desktop: DesktopEntry, intent: IntentRequest) => void;
};

// Aba de agentes: as contas do Codex e do Claude Code de um computador, com o
// uso de cada uma, a partir do último retrato que a página mandou. A troca de
// conta acontece no computador, pela folha de contas da página; aqui nada é
// trocado por conta própria e nenhum número é inventado.
export function Agents({ store, describe, onBack, onPair, onIntent }: Props) {
  const { colors } = useTokens();
  const { locale, t } = useI18n();
  const dashboard = useDashboard();
  const now = useNow();
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ agent: AgentId; accountId: string } | null>(null);
  useEffect(() => { void loadDashboard(); }, []);

  const desktops = orderDesktops(store.desktops, store.lastDesktopId, describe);
  const desktop = desktops.find(item => item.id === chosenId) ?? desktops[0] ?? null;
  const snapshot = desktop ? dashboard.desktops[desktop.id]?.snapshot ?? null : null;
  const profiles = () => { if (desktop) onIntent(desktop, { kind: 'profiles' }); };

  let body;
  if (!desktop) {
    body = <EmptyState action={{ label: t('mobile.home.quick.pair'), onPress: onPair, icon: 'qr-code' }}
      detail={t('mobile.agents.emptyDetail')} icon="bot" title={t('mobile.agents.emptyTitle')} />;
  } else if (!dashboard.loaded) {
    body = <View style={styles.list}><AccountCardSkeleton /><AccountCardSkeleton /></View>;
  } else if (!snapshot) {
    body = <EmptyState action={{ label: t('mobile.agents.read'), onPress: profiles, icon: 'terminal' }}
      detail={t('mobile.agents.noSnapshotDetail', { computer: desktop.name })} icon="bot" title={t('mobile.agents.noSnapshotTitle')} />;
  } else {
    body = (
      <>
        {AGENTS.map(agent => {
          const accounts = agentAccounts(snapshot, agent);
          const name = t(AGENT_NAME_KEYS[agent]);
          return (
            <View key={agent} style={styles.section}>
              <View style={styles.sectionHead}>
                <Text accessibilityRole="header" numberOfLines={1} style={[typography.headline, styles.flex, { color: colors.text }]}>{name}</Text>
                {accounts.length > 1 ? (
                  <Text style={[typography.footnote, { color: colors.textSecondary }]}>{t('mobile.agents.count', { count: accounts.length })}</Text>
                ) : null}
              </View>
              {!accounts.length ? (
                <Card style={styles.emptyAgent}>
                  <View style={styles.emptyHead}>
                    <AgentGlyph agent={agent} size={40} />
                    <Text style={[typography.callout, styles.flex, { color: colors.textSecondary }]}>{t('mobile.home.usage.noAccount')}</Text>
                  </View>
                  <SecondaryButton icon="plus" label={t('mobile.agents.add')} onPress={profiles} variant="soft" />
                </Card>
              ) : accounts.map(account => (
                <AccountCard account={account} key={account.id} now={now}
                  onSettings={() => setSheet({ agent, accountId: account.id })} onSwitch={profiles} />
              ))}
            </View>
          );
        })}
        <Notice detail={t('mobile.agents.switchNote.detail')} icon="refresh" title={t('mobile.agents.switchNote.title')} />
        <Text style={[typography.caption, styles.updated, { color: colors.textTertiary }]}>
          {t('mobile.agents.snapshot', { computer: desktop.name, age: formatAge(snapshot.at, now, locale, t) })}
        </Text>
      </>
    );
  }

  return (
    <Screen>
      <AppHeader actions={desktop ? [{ icon: 'plus', accessibilityLabel: t('mobile.agents.add'), onPress: profiles }] : []}
        backLabel={t('mobile.home.open')} onBack={onBack} title={t('mobile.agents.title')} />
      <ScrollView contentContainerStyle={styles.content}>
        {desktops.length > 1 ? (
          <SegmentedControl onChange={setChosenId} value={desktop?.id ?? ''} scrollable variant="separate"
            options={desktops.map(item => ({ value: item.id, label: item.name }))} />
        ) : null}
        {body}
      </ScrollView>
      <AgentUsageSheet agent={sheet?.agent ?? null} chosenId={sheet?.accountId} now={now} onClose={() => setSheet(null)}
        onChoose={(agent, accountId) => {
          if (!desktop) return;
          chooseAccount(desktop.id, agent, accountId);
          setSheet({ agent, accountId });
        }}
        onManage={() => { setSheet(null); profiles(); }} snapshot={snapshot} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, paddingHorizontal: space.lg, paddingBottom: space.xl, gap: space.md },
  list: { gap: space.sm },
  section: { gap: space.sm },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xxs },
  flex: { flex: 1, minWidth: 0 },
  emptyAgent: { gap: space.sm },
  emptyHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  updated: { textAlign: 'center' }
});
