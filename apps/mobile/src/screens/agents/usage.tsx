import { StyleSheet, Text, View } from 'react-native';

import type { AgentAccount, AgentId, UsageWindow } from '../../bridge/messages';
import { percentOf, usageLevel, type UsageLevel, type WeeklyView } from '../../dashboard/model';
import { formatReset, formatResetAt } from '../../desktops/format';
import { useI18n } from '../../i18n';
import { useTokens, type Palette } from '../../theme';
import { ProgressIndicator, space, typography, type Tone } from '../../ui';

// Partes do uso dos agentes que o Início e a aba Agentes dividem.

export const AGENT_NAME_KEYS: Readonly<Record<AgentId, string>> = {
  codex: 'mobile.home.agent.codex',
  claude: 'mobile.home.agent.claude'
};

export const AGENTS: readonly AgentId[] = ['codex', 'claude'];

// Mesmas faixas da Barra de IA do desktop: abaixo de 60% o rosa, a faixa de
// atenção no âmbar e, de 80% em diante, o vermelho.
export function levelTone(level: UsageLevel): Tone {
  switch (level) {
    case 'exhausted':
    case 'critical': return 'danger';
    case 'near': return 'warning';
    case 'unavailable': return 'neutral';
    default: return 'primary';
  }
}

// Cor do percentual: o texto comum abaixo da faixa de atenção.
export function levelColor(colors: Palette, level: UsageLevel): string {
  return level === 'exhausted' || level === 'critical' ? colors.danger : level === 'near' ? colors.warning : colors.text;
}

type Translate = ReturnType<typeof useI18n>['t'];

// O semanal numa frase: o rótulo curto com o percentual, ou, sem número, se a
// conta não tem limite semanal ou se ele ainda não foi lido. Serve à linha e
// ao leitor de tela.
export function weeklyText(weekly: WeeklyView, t: Translate): string {
  if (weekly.kind === 'available') return `${t('mobile.home.usage.weekly')} ${percentOf(weekly.window.usedFraction)}%`;
  return t(weekly.kind === 'none' ? 'mobile.home.usage.weeklyNone' : 'mobile.home.usage.weeklyUnknown');
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
          { color: levelColor(colors, level) }]}>{percent}</Text>
      </View>
      <ProgressIndicator accessibilityLabel={`${window.label} ${percent}`} tone={levelTone(level)} value={window.usedFraction} />
      {level === 'exhausted' || reset ? (
        <View style={styles.caption}>
          {level === 'exhausted' ? (
            <Text style={[typography.caption, styles.exhausted, { color: colors.danger }]}>{t('mobile.home.usage.exhausted')}</Text>
          ) : null}
          {reset ? (
            <Text numberOfLines={1} style={[typography.caption, styles.flexShrink,
              { color: level === 'critical' ? colors.danger : level === 'near' ? colors.warning : colors.textSecondary }]}>
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

// Semanal compacto do card do Início, abaixo da janela principal. Com número,
// o rótulo curto, o percentual na cor da faixa e um trilho fino; sem limite
// semanal ou sem leitura, só a frase apagada, sem barra e sem 0%.
export function WeeklyLine({ weekly }: { weekly: WeeklyView }) {
  const { colors } = useTokens();
  const { t } = useI18n();
  if (weekly.kind !== 'available') {
    return <Text numberOfLines={1} style={[typography.footnote, { color: colors.textTertiary }]}>{weeklyText(weekly, t)}</Text>;
  }
  const label = t('mobile.home.usage.weekly');
  const percent = `${percentOf(weekly.window.usedFraction)}%`;
  return (
    <View style={styles.weekly}>
      <View style={styles.windowHead}>
        <Text numberOfLines={1} style={[typography.footnote, styles.flex, { color: colors.textSecondary }]}>{label}</Text>
        <Text style={[typography.footnote, styles.percent, styles.weeklyPercent, { color: levelColor(colors, weekly.level) }]}>{percent}</Text>
      </View>
      <ProgressIndicator accessibilityLabel={`${label} ${percent}`} thin tone={levelTone(weekly.level)} value={weekly.window.usedFraction} />
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
  weekly: { gap: 3 },
  weeklyPercent: { fontWeight: '600' },
  unavailable: { gap: 6, marginTop: 2 }
});
