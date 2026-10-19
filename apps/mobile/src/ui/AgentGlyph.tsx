import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';

import type { AgentId } from '../bridge/messages';
import { useTokens } from '../theme';
import { CLAUDE_GLYPH, OPENAI_GLYPH } from './agent-glyphs';

type Props = {
  agent: AgentId;
  // Lado do desenho; o glifo ocupa o quadro inteiro, sem placa em volta.
  size?: number;
  // Tinta do glifo. Sem ela, a de texto; no ícone de uma sessão, o tom dela.
  color?: string;
};

// Marca do agente solta, sem placa nem fundo, como no desktop. Na tinta de
// texto para os dois: sem cor de marca, a mesma regra vale para qualquer
// agente e nos dois temas.
export function AgentGlyph({ agent, size = 22, color }: Props) {
  const { colors } = useTokens();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
      <SvgXml color={color ?? colors.text} height={size} width={size} xml={agent === 'claude' ? CLAUDE_GLYPH : OPENAI_GLYPH} />
    </View>
  );
}
