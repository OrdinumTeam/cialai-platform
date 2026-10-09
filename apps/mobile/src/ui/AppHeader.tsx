import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTokens } from '../theme';
import { IconButton } from './IconButton';
import type { IconName } from './icons';
import { space, typography } from './tokens';

// Botões do cabeçalho: rosa forte com ícone branco, como o voltar.
export type HeaderAction = { icon: IconName; accessibilityLabel: string; onPress: () => void };

type Props = {
  title: string;
  subtitle?: string;
  // Sem `onBack` a tela é raiz e o título fica à esquerda, como no início.
  onBack?: () => void;
  backLabel?: string;
  actions?: readonly HeaderAction[];
  // Conteúdo antes do título, como a bolinha de estado do terminal.
  leading?: ReactNode;
  align?: 'center' | 'start';
};

// Cabeçalho das telas: voltar circular, título e ações à direita.
export function AppHeader({ title, subtitle, onBack, backLabel, actions = [], leading, align }: Props) {
  const { colors } = useTokens();
  const centered = (align ?? (onBack ? 'center' : 'start')) === 'center';
  const actionRow = (
    <View style={styles.actions}>
      {actions.map(action => (
        <IconButton accessibilityLabel={action.accessibilityLabel} icon={action.icon} key={action.accessibilityLabel}
          onPress={action.onPress} variant="header" />
      ))}
    </View>
  );
  return (
    <View style={styles.bar}>
      <View style={[styles.side, centered && styles.sideBalanced]}>
        {onBack ? <IconButton accessibilityLabel={backLabel ?? title} icon="chevron-left" onPress={onBack} variant="header" /> : null}
      </View>
      <View style={[styles.titleBlock, centered ? styles.titleCentered : styles.titleStart]}>
        <View style={styles.titleRow}>
          {leading}
          <Text accessibilityRole="header" numberOfLines={1}
            style={[centered ? typography.title : typography.largeTitle, styles.title, { color: colors.text }]}>{title}</Text>
        </View>
        {subtitle ? <Text numberOfLines={1} style={[typography.footnote, { color: colors.textSecondary }]}>{subtitle}</Text> : null}
      </View>
      <View style={[styles.side, styles.sideEnd, centered && styles.sideBalanced]}>{actions.length ? actionRow : null}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.xs, gap: space.xs },
  side: { flexDirection: 'row', alignItems: 'center' },
  // Os dois lados com a mesma largura mínima deixam o título no centro real.
  sideBalanced: { minWidth: 88 },
  sideEnd: { justifyContent: 'flex-end' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.xxs },
  titleBlock: { flex: 1, minWidth: 0 },
  titleCentered: { alignItems: 'center' },
  titleStart: { alignItems: 'flex-start' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, maxWidth: '100%' },
  title: { flexShrink: 1 }
});
