import { StyleSheet, Text, View } from 'react-native';

import type { AgentAccount, AgentId, UsageWindow } from '../../bridge/messages';
import { percentOf, usageLevel, type UsageLevel } from '../../dashboard/model';
import { formatReset, formatResetAt } from '../../desktops/format';
import { useI18n } from '../../i18n';
import { useTokens } from '../../theme';
import { ProgressIndicator, space, typography, type Tone } from '../../ui';

// Partes do uso dos agentes que o Início e a aba Agentes dividem.

export const AGENT_NAME_KEYS: Readonly<Record<AgentId, string>> = {
  codex: 'mobile.home.agent.codex',
  claude: 'mobile.home.agent.claude'
};

export const AGENTS: readonly AgentId[] = ['codex', 'claude'];

export function levelTone(level: UsageLevel): Tone {
  return level === 'exhausted' ? 'danger' : level === 'near' ? 'warning' : level === 'unavailable' ? 'neutral' : 'primary';
}

// Texto do estado quando não há número para mostrar. Ausência de leitura
// nunca vira zero por cento.
export function readingKey(account: AgentAccount | null, hasSnapshot: boolean): string {
  if (!hasSnapshot) return 'mobile.home.usage.noSnapshot';
  if (!account) return 'mobile.home.usage.noAccount';
  switch (account.state) {
    case 'needsLogin': return 'mobile.home.usage.needsLogin';
    case 'error': return 'mobile.agents.state.error';
    case 'unmetered': return 'mobile.agents.state.unmetered';
    case 'reading': return 'mobile.agents.state.reading';
    default: return 'mobile.home.usage.unavailable';
  }
}

type RowProps = {
  window: UsageWindow;
  now: number;
  // Compacto no card de meia largura do Início; detalhado mostra a hora exata da renovação.
  variant?: 'compact' | 'regular' | 'detailed';
};

// Uma janela de uso: rótulo, percentual, barra e quando renova.
export function WindowRow({ window, now, variant = 'regular' }: RowProps) {
  const { colors } = useTokens();
  const { locale, t } = useI18n();
  const level = usageLevel(window.usedFraction);
  const reset = formatReset(window.resetsAtMs, now, t);
  const resetAt = variant === 'detailed' ? formatResetAt(window.resetsAtMs, now, locale) : null;
  const percent = `${percentOf(window.usedFraction)}%`;
  return (
    <View style={styles.window}>
      <View style={styles.windowHead}>
        <Text numberOfLines={2} style={[typography.footnote, styles.flex, { color: colors.textSecondary }]}>{window.label}</Text>
        <Text style={[variant === 'compact' ? typography.callout : typography.headline, styles.percent,
          { color: level === 'exhausted' ? colors.danger : level === 'near' ? colors.warning : colors.text }]}>{percent}</Text>
      </View>
      <ProgressIndicator accessibilityLabel={`${window.label} ${percent}`} tone={levelTone(level)} value={window.usedFraction} />
      {level === 'exhausted' || reset ? (
        <View style={styles.caption}>
          {level === 'exhausted' ? (
            <Text style={[typography.caption, styles.exhausted, { color: colors.danger }]}>{t('mobile.home.usage.exhausted')}</Text>
          ) : null}
          {reset ? (
            <Text numberOfLines={1} style={[typography.caption, styles.flexShrink, { color: level === 'near' ? colors.warning : colors.textSecondary }]}>
              {t('mobile.home.usage.renews', { time: reset })}
            </Text>
          ) : null}
          {resetAt ? (
            <Text numberOfLines={1} style={[typography.caption, styles.flexShrink, { color: colors.textTertiary }]}>
              {t('mobile.agents.resetsAt', { when: resetAt })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// Estado sem número: barra neutra vazia e a frase do estado.
export function ReadingState({ label }: { label: string }) {
  const { colors } = useTokens();
  return (
    <View style={styles.unavailable}>
      <ProgressIndicator accessibilityLabel={label} tone="neutral" value={0} />
      <Text numberOfLines={3} style={[typography.footnote, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  flexShrink: { flexShrink: 1 },
  window: { gap: 4 },
  windowHead: { flexDirection: 'row', alignItems: 'baseline', gap: space.xxs },
  percent: { fontVariant: ['tabular-nums'] },
  caption: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6 },
  exhausted: { fontWeight: '700' },
  unavailable: { gap: 6, marginTop: 2 }
});
