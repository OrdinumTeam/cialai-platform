import { StyleSheet, Text, View } from 'react-native';

import type { AgentAccount } from '../../bridge/messages';
import { accountLevel, accountWindows } from '../../dashboard/model';
import { useI18n } from '../../i18n';
import { useTokens } from '../../theme';
import { AgentGlyph } from '../../ui/AgentGlyph';
import { Card, IconButton, SecondaryButton, SkeletonLoader, StatusBadge, radius, space, typography } from '../../ui';
import { AGENT_NAME_KEYS, ReadingState, WindowRow, levelTone, readingKey } from './usage';

type Props = {
  account: AgentAccount;
  now: number;
  onSwitch?: () => void;
  onSettings?: () => void;
};

// Card de uma conta de agente: marca, nome do agente e da conta, plano, selo
// da conta padrão, uso por janela e as ações. Um limite perto do fim pinta a
// borda e ganha selo, para ser notado sem ler o número.
export function AccountCard({ account, now, onSwitch, onSettings }: Props) {
  const { colors } = useTokens();
  const { t } = useI18n();
  const agent = t(AGENT_NAME_KEYS[account.agent]);
  const windows = accountWindows(account);
  const level = accountLevel(account);
  const alert = level === 'near' || level === 'exhausted';
  return (
    <Card style={[styles.card, alert && { borderColor: level === 'exhausted' ? colors.danger : colors.warning, borderWidth: 1 }]}>
      <View style={styles.head}>
        <AgentGlyph agent={account.agent} size={44} />
        <View style={styles.identity}>
          <View style={styles.titleRow}>
            <Text numberOfLines={1} style={[typography.title, styles.shrink, { color: colors.text }]}>{agent}</Text>
            {account.plan ? <StatusBadge label={account.plan} tone="primary" variant="pill" /> : null}
          </View>
          <Text numberOfLines={2} style={[typography.footnote, { color: colors.textSecondary }]}>{account.label}</Text>
        </View>
      </View>
      {account.active || alert || account.state === 'stale' ? (
        <View style={styles.badges}>
          {account.active ? <StatusBadge label={t('mobile.agents.default')} tone="success" variant="pill" /> : null}
          {alert ? <StatusBadge label={t(level === 'exhausted' ? 'mobile.home.usage.exhausted' : 'mobile.agents.near')} tone={levelTone(level)} variant="pill" /> : null}
          {account.state === 'stale' ? <StatusBadge label={t('mobile.home.usage.stale')} tone="warning" variant="pill" /> : null}
        </View>
      ) : null}
      <View style={[styles.usage, { backgroundColor: colors.background }]}>
        {windows.length
          ? windows.map(window => <WindowRow key={window.id} now={now} variant="regular" window={window} />)
          : <ReadingState label={t(readingKey(account, true))} />}
      </View>
      {onSwitch || onSettings ? (
        <View style={styles.actions}>
          {onSwitch ? (
            <SecondaryButton accessibilityLabel={t('mobile.agents.switchFor', { agent, account: account.label })}
              label={t('mobile.agents.switch')} onPress={onSwitch} style={styles.switch} variant="soft" />
          ) : null}
          {onSettings ? (
            <IconButton accessibilityLabel={t('mobile.agents.settingsFor', { agent, account: account.label })} icon="settings"
              onPress={onSettings} variant="surface" />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

// Card fantasma no formato do card de conta, enquanto o retrato é lido.
export function AccountCardSkeleton() {
  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <SkeletonLoader height={44} style={styles.glyph} width={44} />
        <View style={styles.identity}><SkeletonLoader width="50%" /><SkeletonLoader height={12} width="70%" /></View>
      </View>
      <SkeletonLoader height={72} style={styles.glyph} />
      <SkeletonLoader height={46} rounded />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  identity: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  shrink: { flexShrink: 1 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  usage: { borderRadius: radius.md, padding: space.sm, gap: space.sm },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  switch: { flex: 1 },
  glyph: { borderRadius: radius.md }
});
