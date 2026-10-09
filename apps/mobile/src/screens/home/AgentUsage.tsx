import { StyleSheet, Text, View } from 'react-native';

import type { AgentId, DashboardMessage } from '../../bridge/messages';
import { agentSummary, percentOf, type AgentSummary } from '../../dashboard/model';
import { formatAge } from '../../desktops/format';
import { useI18n } from '../../i18n';
import { useTokens } from '../../theme';
import { AgentGlyph } from '../../ui/AgentGlyph';
import { BottomSheet, Card, ChoiceRow, Icon, PrimaryButton, SecondaryButton, SkeletonLoader, StatusBadge, radius, space, typography } from '../../ui';
import { AGENT_NAME_KEYS, ReadingState, WindowRow, levelTone, readingKey } from '../agents/usage';

// Texto do estado do card do Início quando não há número para mostrar.
function stateKey(summary: AgentSummary, hasSnapshot: boolean): string {
  return readingKey(summary.account, hasSnapshot);
}

type CardProps = {
  agent: AgentId;
  snapshot: DashboardMessage | null;
  chosenId?: string;
  loading: boolean;
  now: number;
  onOpen: (agent: AgentId, accountId?: string) => void;
};

// Card de meia largura do Início: marca, nome, plano e as janelas de uso.
export function AgentUsageSummary({ agent, snapshot, chosenId, loading, now, onOpen }: CardProps) {
  const { colors } = useTokens();
  const { t } = useI18n();
  const name = t(AGENT_NAME_KEYS[agent]);
  if (loading) {
    return (
      <Card style={styles.card}>
        <View style={styles.head}><SkeletonLoader height={36} style={styles.glyphSkeleton} width={36} /><SkeletonLoader width="60%" /></View>
        <SkeletonLoader height={6} rounded style={styles.gap} />
        <SkeletonLoader height={12} width="70%" />
      </Card>
    );
  }
  const summary = agentSummary(snapshot, agent, chosenId);
  const accountLabel = summary.accounts.length > 1 ? summary.account?.label : null;
  return (
    <Card accessibilityHint={t('mobile.home.agent.details', { agent: name })} onPress={() => onOpen(agent, chosenId)} style={styles.card}
      accessibilityLabel={[name, accountLabel, summary.account?.plan,
        ...(summary.readable ? summary.rows.map(window => `${window.label} ${percentOf(window.usedFraction)}%`) : [t(stateKey(summary, !!snapshot))])]
        .filter(Boolean).join(', ')}>
      <View style={styles.head}>
        <AgentGlyph agent={agent} size={34} />
        <View style={styles.flex}>
          <Text numberOfLines={1} style={[typography.headline, { color: colors.text }]}>{name}</Text>
          {accountLabel ? (
            <View style={styles.account}>
              <Text numberOfLines={1} style={[typography.caption, styles.flexShrink, { color: colors.textSecondary }]}>{accountLabel}</Text>
              <Icon color={colors.textSecondary} name="chevron-down" size={12} />
            </View>
          ) : null}
        </View>
      </View>
      {summary.account?.plan ? <View style={styles.plan}><StatusBadge label={summary.account.plan} tone="primary" variant="pill" /></View> : null}
      {summary.readable ? (
        summary.rows.map(window => <WindowRow key={window.id} now={now} variant={summary.rows.length > 1 ? 'compact' : 'regular'} window={window} />)
      ) : (
        <ReadingState label={t(stateKey(summary, !!snapshot))} />
      )}
      {summary.account?.state === 'stale' ? <StatusBadge label={t('mobile.home.usage.stale')} tone="warning" /> : null}
    </Card>
  );
}

type SheetProps = {
  agent: AgentId | null;
  snapshot: DashboardMessage | null;
  chosenId?: string;
  now: number;
  onChoose: (agent: AgentId, accountId: string) => void;
  onManage: () => void;
  onClose: () => void;
};

// Detalhes de uso de uma conta e troca da conta exibida no Início.
export function AgentUsageSheet({ agent, snapshot, chosenId, now, onChoose, onManage, onClose }: SheetProps) {
  const { colors } = useTokens();
  const { locale, t } = useI18n();
  const summary = agent ? agentSummary(snapshot, agent, chosenId) : null;
  const name = agent ? t(AGENT_NAME_KEYS[agent]) : '';
  const account = summary?.account ?? null;
  return (
    <BottomSheet onClose={onClose} title={name} visible={!!agent}>
      {account ? (
        <View style={styles.sheetAccount}>
          <Text numberOfLines={2} style={[typography.headline, styles.flexShrink, { color: colors.text }]}>{account.label}</Text>
          {account.plan ? <StatusBadge label={account.plan} tone="primary" variant="pill" /> : null}
        </View>
      ) : null}
      {summary?.readable && account ? account.windows.map(window => <WindowRow key={window.id} now={now} variant="detailed" window={window} />) : (
        summary ? <Text style={[typography.body, { color: colors.textSecondary }]}>{t(stateKey(summary, !!snapshot))}</Text> : null
      )}
      {account?.fetchedAtMs || snapshot ? (
        <Text style={[typography.footnote, { color: colors.textTertiary }]}>
          {t('mobile.home.agent.updated', { age: formatAge(account?.fetchedAtMs ?? snapshot!.at, now, locale, t) })}
        </Text>
      ) : null}
      {summary && summary.accounts.length > 1 ? (
        <View style={styles.accounts}>
          <Text accessibilityRole="header" style={[typography.footnote, styles.sectionLabel, { color: colors.textSecondary }]}>
            {t('mobile.home.accounts.choose', { agent: name })}
          </Text>
          {summary.accounts.map(item => {
            const selected = item.id === account?.id;
            const level = agentSummary(snapshot, item.agent, item.id).level;
            return (
              <ChoiceRow accessibilityRole="radio" detail={item.active ? t('mobile.home.accounts.active') : undefined} key={item.id}
                onPress={() => onChoose(item.agent, item.id)} selected={selected} title={item.label}
                trailing={<>
                  {item.plan ? <StatusBadge label={item.plan} tone={levelTone(level)} /> : null}
                  {selected ? <Icon color={colors.primary} name="check" size={18} /> : null}
                </>} />
            );
          })}
        </View>
      ) : null}
      <View style={styles.sheetActions}>
        {summary && summary.accounts.length > 1
          ? <SecondaryButton label={t('mobile.home.accounts.manage')} onPress={onManage} variant="soft" />
          : null}
        <PrimaryButton icon="terminal" label={t('mobile.home.agent.manage')} onPress={onManage} />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, minWidth: 0, gap: space.xs, padding: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  glyphSkeleton: { borderRadius: radius.md },
  gap: { marginTop: space.xs },
  flex: { flex: 1, minWidth: 0 },
  flexShrink: { flexShrink: 1 },
  account: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  plan: { flexDirection: 'row' },
  sheetAccount: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  accounts: { gap: space.xs, marginTop: space.xs },
  sectionLabel: { fontWeight: '600', textTransform: 'uppercase' },
  sheetActions: { gap: space.xs, marginTop: space.sm }
});
