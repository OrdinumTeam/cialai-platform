import { StyleSheet, Text, View } from 'react-native';

import type { AgentAccount } from '../../bridge/messages';
import { accountLevel, accountWindows, weeklyView, type UsageLevel } from '../../dashboard/model';
import { useI18n } from '../../i18n';
import { useTokens } from '../../theme';
import { AgentGlyph } from '../../ui/AgentGlyph';
import { Card, Icon, SkeletonLoader, StatusBadge, radius, space, typography } from '../../ui';
import { AGENT_NAME_KEYS, ReadingState, WeeklyLine, WindowRow, levelTone, readingKey } from './usage';

type Props = {
  account: AgentAccount;
  now: number;
  // Abre a folha de detalhes da conta, com todas as janelas e a renovação.
  onPress: () => void;
};

// Selo de quem está perto do fim: de 80% em diante, no vermelho; a faixa de
// atenção, de 60% a 79%, só pinta a borda de âmbar.
const ALERT_KEYS: Partial<Record<UsageLevel, string>> = {
  critical: 'mobile.agents.near',
  exhausted: 'mobile.home.usage.exhausted'
};

// Linha de uma conta na lista plana da aba Agentes: glifo solto, rótulo da
// conta, legenda com o agente, o plano e os selos, a janela principal com
// percentual e barra e, embaixo, o semanal nos três estados da Barra de IA:
// a janela semanal compacta quando há número, ou a frase de conta sem limite
// semanal ou sem leitura. A linha inteira abre os detalhes. Um limite na faixa
// de atenção pinta a borda, e perto do fim ganha selo também, para ser notado
// sem ler o número.
export function AccountRow({ account, now, onPress }: Props) {
  const { colors } = useTokens();
  const { t } = useI18n();
  const agent = t(AGENT_NAME_KEYS[account.agent]);
  const windows = accountWindows(account);
  const headline = windows[0];
  // A semanal sozinha já é a principal da linha; não se repete embaixo.
  const weekly = headline && !headline.weekly ? weeklyView(account) : null;
  const level = accountLevel(account);
  const alertKey = ALERT_KEYS[level];
  const border = level === 'near' ? colors.warning : alertKey ? colors.danger : null;
  return (
    <Card accessibilityHint={t('mobile.home.agent.details', { agent })} accessibilityLabel={t('mobile.agents.settingsFor', { agent, account: account.label })}
      onPress={onPress} style={[styles.card, border && { borderColor: border, borderWidth: 1 }]}>
      <AgentGlyph agent={account.agent} size={GLYPH} />
      <View style={styles.body}>
        <Text numberOfLines={1} style={[typography.headline, { color: colors.text }]}>{account.label}</Text>
        <View style={styles.caption}>
          <Text numberOfLines={1} style={[typography.footnote, styles.shrink, { color: colors.textSecondary }]}>{agent}</Text>
          {account.plan ? <StatusBadge label={account.plan} tone="primary" variant="pill" /> : null}
          {account.active ? <StatusBadge label={t('mobile.agents.inUse')} tone="success" variant="pill" /> : null}
          {alertKey ? <StatusBadge label={t(alertKey)} tone={levelTone(level)} variant="pill" /> : null}
          {account.state === 'stale' ? <StatusBadge label={t('mobile.home.usage.stale')} tone="warning" variant="pill" /> : null}
        </View>
        <View style={styles.usage}>
          {headline ? <WindowRow now={now} variant="regular" window={headline} /> : <ReadingState label={t(readingKey(account, true))} />}
          {weekly?.kind === 'available' ? <WindowRow now={now} variant="compact" window={weekly.window} />
            : weekly ? <WeeklyLine weekly={weekly} /> : null}
        </View>
      </View>
      <Icon color={colors.textTertiary} name="chevron-right" size={18} />
    </Card>
  );
}

// Linha fantasma no formato da linha de conta, enquanto o retrato é lido.
export function AccountRowSkeleton() {
  return (
    <Card style={styles.card}>
      <SkeletonLoader height={GLYPH} style={styles.glyph} width={GLYPH} />
      <View style={styles.body}>
        <SkeletonLoader width="50%" />
        <SkeletonLoader height={12} width="70%" />
        <SkeletonLoader height={6} rounded style={styles.skeletonBar} />
      </View>
    </Card>
  );
}

// Glifo solto, sem placa, na altura da linha do rótulo.
const GLYPH = 22;

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, padding: space.sm },
  body: { flex: 1, minWidth: 0, gap: space.xxs },
  caption: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.xs },
  shrink: { flexShrink: 1 },
  usage: { gap: space.xs, marginTop: space.xxs },
  glyph: { borderRadius: radius.sm },
  skeletonBar: { marginTop: space.xs }
});
