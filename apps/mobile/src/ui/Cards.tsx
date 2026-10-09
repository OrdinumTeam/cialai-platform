import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useI18n } from '../i18n';
import { useTokens } from '../theme';
import { IconButton } from './IconButton';
import { Icon, type IconName } from './icons';
import { LaptopIllustration } from './Illustrations';
import { StatusBadge, type Tone } from './Indicators';
import { radius, space, typography } from './tokens';

type CardProps = {
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  selected?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  // O que o toque faz, quando o rótulo já descreve o conteúdo.
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
};

// Superfície branca com borda discreta e sombra quase invisível. Selecionada,
// ganha borda e fundo rosa claro, como o computador ativo nas referências.
export function Card({ children, onPress, onLongPress, selected, disabled, accessibilityLabel, accessibilityHint, style }: CardProps) {
  const { colors, shadow } = useTokens();
  const surface = [styles.card, shadow.card, {
    backgroundColor: selected ? colors.primarySoft : colors.surface,
    borderColor: selected ? colors.primary : colors.border
  }, disabled && styles.disabled, style];
  if (!onPress && !onLongPress) return <View style={surface}>{children}</View>;
  return (
    <Pressable accessibilityHint={accessibilityHint} accessibilityLabel={accessibilityLabel} accessibilityRole="button" accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled} onLongPress={onLongPress} onPress={onPress}
      style={({ pressed }) => [surface, pressed && { backgroundColor: selected ? colors.primarySoftPressed : colors.surfacePressed }]}>
      {children}
    </Pressable>
  );
}

export type Meta = { icon: IconName; label: string };

function MetaRow({ items }: { items: readonly Meta[] }) {
  const { colors } = useTokens();
  if (!items.length) return null;
  return (
    <View style={styles.metaRow}>
      {items.map(item => (
        <View key={`${item.icon}:${item.label}`} style={styles.meta}>
          <Icon color={colors.textTertiary} name={item.icon} size={14} />
          <Text numberOfLines={1} style={[typography.footnote, { color: colors.textSecondary }]}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

function MoreButton({ label, onPress }: { label: string; onPress?: () => void }) {
  const { colors } = useTokens();
  if (!onPress) return null;
  return <IconButton accessibilityLabel={label} icon="ellipsis-vertical" onPress={onPress} tint={colors.textSecondary} />;
}

type ComputerCardProps = {
  name: string;
  status: { label: string; tone: Tone };
  // Selo extra ao lado do estado, como "Reserva".
  badge?: { label: string; tone: Tone; accessibilityLabel?: string };
  meta?: readonly Meta[];
  selected?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  onMore?: () => void;
  moreLabel?: string;
  accessibilityLabel?: string;
};

export function ComputerCard({ name, status, badge, meta = [], selected, disabled, onPress, onMore, moreLabel, accessibilityLabel }: ComputerCardProps) {
  const { colors } = useTokens();
  const { t } = useI18n();
  const offline = status.tone === 'neutral' || status.tone === 'danger';
  // O leitor de tela ouve o mesmo que os olhos veem: nome, estado, selo e detalhes.
  const spoken = [accessibilityLabel ?? name, status.label, badge?.accessibilityLabel ?? badge?.label, ...meta.map(item => item.label)]
    .filter(Boolean).join(', ');
  return (
    <Card accessibilityLabel={spoken} disabled={disabled} onPress={onPress} selected={selected} style={styles.row}>
      <View style={[styles.illustration, { backgroundColor: offline ? colors.surfaceMuted : colors.primarySoft }]}>
        <LaptopIllustration online={!offline} width={68} />
      </View>
      <View style={styles.body}>
        <Text numberOfLines={1} style={[typography.headline, { color: colors.text }]}>{name}</Text>
        <View style={styles.badges}>
          <StatusBadge label={status.label} tone={status.tone} />
          {badge ? <StatusBadge accessibilityLabel={badge.accessibilityLabel} label={badge.label} tone={badge.tone} variant="pill" /> : null}
        </View>
        <MetaRow items={meta} />
      </View>
      <MoreButton label={moreLabel ?? t('mobile.common.more')} onPress={onMore} />
    </Card>
  );
}

type ProjectCardProps = {
  name: string;
  detail?: string;
  selected?: boolean;
  onPress?: () => void;
  onMore?: () => void;
  moreLabel?: string;
};

export function ProjectCard({ name, detail, selected, onPress, onMore, moreLabel }: ProjectCardProps) {
  const { colors } = useTokens();
  const { t } = useI18n();
  return (
    <Card onPress={onPress} selected={selected} style={styles.project}>
      <View style={[styles.cover, { backgroundColor: selected ? colors.surface : colors.primarySoft }]}>
        <Icon color={colors.primary} name="folder" size={36} strokeWidth={1.5} />
        {selected ? (
          <View accessibilityLabel={t('mobile.common.selected')} accessible style={[styles.check, { backgroundColor: colors.primary }]}>
            <Icon color={colors.onPrimary} name="check" size={14} strokeWidth={2.4} />
          </View>
        ) : null}
      </View>
      <View style={styles.projectFoot}>
        <View style={styles.body}>
          <Text numberOfLines={1} style={[typography.headline, { color: colors.text }]}>{name}</Text>
          {detail ? <Text numberOfLines={1} style={[typography.footnote, { color: colors.textSecondary }]}>{detail}</Text> : null}
        </View>
        <MoreButton label={moreLabel ?? t('mobile.common.more')} onPress={onMore} />
      </View>
    </Card>
  );
}

type SessionCardProps = {
  name: string;
  agent?: string;
  state: { label: string; tone: Tone };
  elapsed?: string;
  meta?: readonly Meta[];
  onPress?: () => void;
  onMore?: () => void;
  moreLabel?: string;
};

export function SessionCard({ name, agent, state, elapsed, meta = [], onPress, onMore, moreLabel }: SessionCardProps) {
  const { colors } = useTokens();
  const { t } = useI18n();
  return (
    <Card onPress={onPress} style={styles.session}>
      <View style={styles.sessionHead}>
        <StatusBadge label="" tone={state.tone} />
        <Text numberOfLines={1} style={[typography.headline, styles.body, { color: colors.text }]}>{name}</Text>
        <MoreButton label={moreLabel ?? t('mobile.common.more')} onPress={onMore} />
      </View>
      {agent ? <Text numberOfLines={1} style={[typography.callout, { color: colors.text }]}>{agent}</Text> : null}
      <View style={styles.sessionState}>
        <Text numberOfLines={1} style={[typography.footnote, styles.body, { color: colors.textSecondary }]}>{state.label}</Text>
        {elapsed ? <Text style={[typography.footnote, { color: colors.textSecondary }]}>{elapsed}</Text> : null}
      </View>
      <MetaRow items={meta} />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.md },
  disabled: { opacity: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  illustration: { width: 84, height: 64, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0, gap: 2 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.xs, marginTop: 4 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  project: { padding: space.xs, gap: space.xs },
  cover: { aspectRatio: 1.45, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  check: { position: 'absolute', top: space.xs, right: space.xs, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  projectFoot: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.xxs, paddingBottom: space.xxs },
  session: { gap: 2 },
  sessionHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  sessionState: { flexDirection: 'row', alignItems: 'center', gap: space.sm }
});
