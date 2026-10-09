import { Image, StyleSheet } from 'react-native';

import { useTokens } from '../theme';

const MARK = require('../assets/cialai-mark.png');

// Símbolo do Cialai tingido com o acento, no cabeçalho do Início e em Sobre.
export function BrandMark({ size = 32 }: { size?: number }) {
  const { colors } = useTokens();
  return <Image accessibilityIgnoresInvertColors resizeMode="contain" source={MARK}
    style={[styles.mark, { width: size, height: size, tintColor: colors.primary }]} />;
}

const styles = StyleSheet.create({ mark: { flexShrink: 0 } });
