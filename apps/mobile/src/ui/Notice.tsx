import { StyleSheet, Text, View } from 'react-native';
import type { ReactNode } from 'react';

import { useTokens } from '../theme';
import { Icon, type IconName } from './icons';
import { toneColors, type Tone } from './Indicators';
import { radius, space, typography } from './tokens';

type Props = {
  title?: string;
  detail?: string;
  icon?: IconName;
  tone?: Tone;
  children?: ReactNode;
};

// Aviso discreto em caixa de fundo suave, como "A troca vale para novas sessões".
export function Notice({ title, detail, icon, tone = 'primary', children }: Props) {
  const { colors } = useTokens();
  const { fg, bg } = toneColors(colors, tone);
  return (
    <View accessible={!children} style={[styles.box, { backgroundColor: bg }]}>
      {icon ? <Icon color={fg} name={icon} size={20} /> : null}
      <View style={styles.body}>
        {title ? <Text style={[typography.callout, styles.title, { color: tone === 'neutral' ? colors.text : fg }]}>{title}</Text> : null}
        {detail ? <Text style={[typography.footnote, { color: tone === 'warning' || tone === 'danger' ? colors.text : colors.textSecondary }]}>{detail}</Text> : null}
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, padding: space.md },
  body: { flex: 1, minWidth: 0, gap: space.xxs },
  title: { fontWeight: '600' }
});
