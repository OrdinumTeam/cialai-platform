import type { DashboardSession } from '../bridge/messages';
import { AgentGlyph } from './AgentGlyph';
import { resolveSessionIcon } from './session-icons';

type Props = {
  session: Pick<DashboardSession, 'icon' | 'agent'>;
  // O tom da sessão já resolvido para o tema, a versão legível dele.
  color: string;
  size?: number;
};

// Ícone da sessão, solto antes do nome, sem placa, sempre no tom dela, como
// no card do desktop e da página. Decorativo: o nome ao lado identifica a
// sessão.
export function SessionIcon({ session, color, size = 20 }: Props) {
  const icon = resolveSessionIcon(session);
  if (icon.kind === 'agent') return <AgentGlyph agent={icon.agent} color={color} size={size} />;
  const { Icon } = icon;
  return <Icon accessibilityElementsHidden importantForAccessibility="no-hide-descendants" color={color} size={size} strokeWidth={1.9} />;
}
