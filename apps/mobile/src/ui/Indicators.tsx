import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useI18n } from '../i18n';
import { useTokens, type Palette } from '../theme';
import { Icon } from './icons';
import { radius, space, typography } from './tokens';

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'primary';

export function toneColors(colors: Palette, tone: Tone): { fg: string; bg: string } {
  switch (tone) {
    case 'success': return { fg: colors.success, bg: colors.successSoft };
    case 'warning': return { fg: colors.warning, bg: colors.warningSoft };
    case 'danger': return { fg: colors.danger, bg: colors.dangerSoft };
    case 'primary': return { fg: colors.primary, bg: colors.primarySoft };
    default: return { fg: colors.neutral, bg: colors.surfaceMuted };
  }
}

type BadgeProps = {
  label: string;
  tone?: Tone;
  // `dot` é a bolinha com texto, como "Conectado"; `pill` tem fundo, como "Reserva".
  variant?: 'dot' | 'pill';
  accessibilityLabel?: string;
};

export function StatusBadge({ label, tone = 'neutral', variant = 'dot', accessibilityLabel }: BadgeProps) {
  const { colors } = useTokens();
  const { fg, bg } = toneColors(colors, tone);
  return (
    <View accessibilityLabel={accessibilityLabel} accessible={!!accessibilityLabel}
      style={[styles.badge, variant === 'pill' && [styles.pill, { backgroundColor: bg }]]}>
      <View style={[styles.dot, { backgroundColor: fg }]} />
      <Text numberOfLines={1} style={[variant === 'pill' ? styles.pillText : styles.dotText,
        { color: variant === 'pill' ? fg : colors.textSecondary }]}>{label}</Text>
    </View>
  );
}

type ProgressProps = {
  // De 0 a 1; valores fora do intervalo são limitados.
  value: number;
  tone?: Tone;
  label?: string;
  detail?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

export function ProgressIndicator({ value, tone = 'primary', label, detail, accessibilityLabel, style }: ProgressProps) {
  const { colors } = useTokens();
  const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const { fg } = toneColors(colors, tone);
  return (
    <View accessibilityLabel={accessibilityLabel ?? label} accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }} style={[styles.progress, style]}>
      {label || detail ? (
        <View style={styles.progressHead}>
          {label ? <Text style={[typography.headline, { color: colors.text }]}>{label}</Text> : <View />}
          {detail ? <Text style={[typography.footnote, { color: colors.textSecondary }]}>{detail}</Text> : null}
        </View>
      ) : null}
      <View style={[styles.track, { backgroundColor: colors.surfaceMuted }]}>
        <View style={[styles.fill, { width: `${clamped * 100}%`, backgroundColor: fg }]} />
      </View>
    </View>
  );
}

type SectionProps = { title: string; actionLabel?: string; actionAccessibilityLabel?: string; onAction?: () => void };

// Título de seção com o link "Ver todos" à direita.
export function SectionHeader({ title, actionLabel, actionAccessibilityLabel, onAction }: SectionProps) {
  const { colors } = useTokens();
  const { t } = useI18n();
  const label = actionLabel ?? t('mobile.common.seeAll');
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" numberOfLines={1} style={[typography.headline, styles.sectionTitle, { color: colors.text }]}>{title}</Text>
      {onAction ? (
        <Pressable accessibilityLabel={actionAccessibilityLabel ?? label} accessibilityRole="button" hitSlop={8} onPress={onAction} style={({ pressed }) => [styles.sectionAction, pressed && styles.pressed]}>
          <Text style={[typography.footnote, { color: colors.primary, fontWeight: '600' }]}>{label}</Text>
          <Icon color={colors.primary} name="chevron-right" size={16} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  pill: { borderRadius: radius.pill, paddingHorizontal: space.xs, paddingVertical: 3 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotText: { ...typography.footnote, flexShrink: 1 },
  pillText: { ...typography.caption, fontWeight: '600', flexShrink: 1 },
  progress: { gap: space.xs },
  progressHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: space.sm },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
  section: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  sectionTitle: { flexShrink: 1 },
  sectionAction: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 44 },
  pressed: { opacity: 0.6 }
});
