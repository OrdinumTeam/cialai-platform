import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTokens } from '../../theme';
import { Icon, radius, space, typography, type IconName } from '../../ui';

// `label` é curto, de uma palavra ou duas, para os quatro cards terem o mesmo
// tamanho; `accessibilityLabel` diz a ação inteira.
export type QuickAction = { icon: IconName; label: string; accessibilityLabel?: string; onPress: () => void; disabled?: boolean };

// Quatro atalhos compactos numa linha, do mesmo tamanho: ícone centrado num
// bloco rosa claro e rótulo de uma linha.
export function QuickActions({ actions }: { actions: readonly QuickAction[] }) {
  const { colors } = useTokens();
  return (
    <View style={styles.row}>
      {actions.map(action => (
        <Pressable accessibilityLabel={action.accessibilityLabel ?? action.label} accessibilityRole="button" accessibilityState={{ disabled: !!action.disabled }}
          disabled={action.disabled} key={action.label} onPress={action.onPress}
          style={({ pressed }) => [styles.tile, { backgroundColor: pressed ? colors.surfacePressed : colors.surface, borderColor: colors.border },
            action.disabled && styles.disabled]}>
          <View style={[styles.icon, { backgroundColor: colors.primarySoft }]}>
            <Icon color={colors.primary} name={action.icon} size={20} />
          </View>
          <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={[typography.caption, styles.label, { color: colors.text }]}>{action.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.xs },
  tile: { flex: 1, minWidth: 0, height: 88, alignItems: 'center', justifyContent: 'center', gap: space.xs, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg, paddingHorizontal: space.xxs },
  // Bloco de ícone do site: 40 por 40 com o raio dos botões.
  icon: { width: 40, height: 40, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' },
  label: { alignSelf: 'stretch', textAlign: 'center', fontSize: 12, lineHeight: 15 },
  disabled: { opacity: 0.45 }
});
