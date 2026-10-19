import { Image, StyleSheet } from 'react-native';

// A cabeça do louva-a-deus nas cores da marca, de
// brand/logo/cialai-mantis-v4-1-head-4k.png, recortada justo, centrada num
// quadrado e reduzida a 192 px pela mesma média de área de
// tools/brand/png.mjs. O símbolo vazado de uma cor só saiu da interface com
// o desktop em 18/10/2026.
const MARK = require('../assets/cialai-head.png');

// Símbolo do Cialai para tamanhos pequenos, como em Sobre. Nunca tingido: a
// marca oficial tem cor própria, e ela serve aos dois temas.
export function BrandMark({ size = 32 }: { size?: number }) {
  return <Image accessibilityIgnoresInvertColors resizeMode="contain" source={MARK}
    style={[styles.mark, { width: size, height: size }]} />;
}

const styles = StyleSheet.create({ mark: { flexShrink: 0 } });
