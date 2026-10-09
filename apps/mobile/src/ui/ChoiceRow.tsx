import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTokens } from '../theme';
import { Icon, type IconName } from './icons';
import { radius, space, typography } from './tokens';

type Props = {
  title: string;
  // Linha de apoio: texto curto ou selos.
  detail?: ReactNode;
  icon?: IconName;
  // Elemento no lugar do ícone, como a capa de um projeto ou a marca de um agente.
  leading?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
  accessibilityRole?: 'button' | 'radio' | 'checkbox';
  accessibilityLabel?: string;
  checked?: boolean;
};

// Linha de escolha das folhas: computador, conta ou projeto. A escolhida ganha
// borda e fundo rosa claro, como o computador ativo nas referências.
export function ChoiceRow({ title, detail, icon, leading, trailing, selected, disabled, onPress, accessibilityRole = 'button',
  accessibilityLabel, checked }: Props) {
  const { colors } = useTokens();
  return (
    <Pressable accessibilityLabel={accessibilityLabel} accessibilityRole={accessibilityRole}
      accessibilityState={{ selected: !!selected, disabled: !!disabled, ...(checked === undefined ? {} : { checked }) }}
      disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.row, {
        borderColor: selected ? colors.primary : colors.border,
        backgroundColor: selected ? colors.primarySoft : pressed ? colors.surfacePressed : colors.surface
      }]}>
      {leading ?? (icon ? <Icon color={selected ? colors.primary : colors.textSecondary} name={icon} size={22} /> : null)}
      <View style={styles.body}>
        <Text numberOfLines={1} style={[typography.callout, styles.title, { color: colors.text }]}>{title}</Text>
        {typeof detail === 'string'
          ? <Text numberOfLines={1} style={[typography.footnote, { color: colors.textSecondary }]}>{detail}</Text>
          : detail}
      </View>
      {trailing}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 1, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.xs },
  body: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontWeight: '600' }
});
