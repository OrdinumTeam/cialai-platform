import { StyleSheet, View } from 'react-native';
import { SvgXml } from 'react-native-svg';

import type { AgentId } from '../bridge/messages';
import { useTokens } from '../theme';
import { CLAUDE_GLYPH, OPENAI_GLYPH } from './agent-glyphs';
import { radius } from './tokens';

// Marca do agente sobre uma placa clara, na tinta de texto para os dois: sem
// cor de marca, a mesma regra vale para qualquer agente e nos dois temas.
export function AgentGlyph({ agent, size = 36 }: { agent: AgentId; size?: number }) {
  const { colors } = useTokens();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={[styles.plate, { width: size, height: size, borderRadius: Math.min(radius.md, size / 2.6), backgroundColor: colors.surfaceMuted }]}>
      <SvgXml color={colors.text} height={size * 0.62} width={size * 0.62} xml={agent === 'claude' ? CLAUDE_GLYPH : OPENAI_GLYPH} />
    </View>
  );
}

const styles = StyleSheet.create({ plate: { alignItems: 'center', justifyContent: 'center' } });
