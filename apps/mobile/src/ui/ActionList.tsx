import { Fragment } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTokens } from '../theme';
import { Icon, type IconName } from './icons';
import { radius, space, TOUCH_TARGET, typography } from './tokens';

export type ActionItem = {
  key: string;
  icon: IconName;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
};

// Lista de ações para folhas inferiores: uma linha de 48 pt por ação, com
// ícone, e um divisor fino entre os grupos.
export function ActionList({ groups }: { groups: readonly (readonly ActionItem[])[] }) {
  const { colors } = useTokens();
  const visible = groups.filter(group => group.length);
  return (
    <View accessibilityRole="menu" style={styles.list}>
      {visible.map((group, index) => (
        <Fragment key={group[0]?.key ?? index}>
          {index > 0 ? <View style={[styles.divider, { backgroundColor: colors.border }]} /> : null}
          {group.map(item => {
            const tint = item.destructive ? colors.danger : colors.text;
            return (
              <Pressable accessibilityRole="menuitem" accessibilityState={{ disabled: !!item.disabled }} disabled={item.disabled}
                key={item.key} onPress={item.onPress}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfacePressed }, item.disabled && styles.disabled]}>
                <Icon color={item.destructive ? colors.danger : colors.textSecondary} name={item.icon} size={20} />
                <Text numberOfLines={1} style={[typography.body, styles.label, { color: tint }]}>{item.label}</Text>
              </Pressable>
            );
          })}
        </Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { marginHorizontal: -space.xs },
  row: { minHeight: Math.max(TOUCH_TARGET, 48), flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.xs, borderRadius: radius.sm },
  label: { flex: 1 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: space.xxs, marginHorizontal: space.xs },
  disabled: { opacity: 0.4 }
});
