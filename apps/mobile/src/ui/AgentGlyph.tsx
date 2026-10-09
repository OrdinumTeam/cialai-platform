import { StyleSheet, View } from 'react-native';
import { SvgXml } from 'react-native-svg';

import type { AgentId } from '../bridge/messages';
import { useTokens } from '../theme';
import { CLAUDE_GLYPH, OPENAI_GLYPH } from './agent-glyphs';
import { agentColors, radius } from './tokens';

// Marca do agente sobre uma placa clara, como nas referências: o Codex em
// tinta de texto e o Claude Code na cor da marca dele.
export function AgentGlyph({ agent, size = 36 }: { agent: AgentId; size?: number }) {
  const { colors } = useTokens();
  const color = agent === 'claude' ? agentColors.claude : colors.text;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={[styles.plate, { width: size, height: size, borderRadius: Math.min(radius.md, size / 2.6), backgroundColor: colors.surfaceMuted }]}>
      <SvgXml color={color} height={size * 0.62} width={size * 0.62} xml={agent === 'claude' ? CLAUDE_GLYPH : OPENAI_GLYPH} />
    </View>
  );
}

const styles = StyleSheet.create({ plate: { alignItems: 'center', justifyContent: 'center' } });
