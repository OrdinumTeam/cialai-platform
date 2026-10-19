import type { LucideIcon } from 'lucide-react-native';
import BookOpen from 'lucide-react-native/icons/book-open';
import Bot from 'lucide-react-native/icons/bot';
import Brain from 'lucide-react-native/icons/brain';
import Briefcase from 'lucide-react-native/icons/briefcase';
import Bug from 'lucide-react-native/icons/bug';
import ChartLine from 'lucide-react-native/icons/chart-line';
import Cloud from 'lucide-react-native/icons/cloud';
import Code from 'lucide-react-native/icons/code';
import Coffee from 'lucide-react-native/icons/coffee';
import Container from 'lucide-react-native/icons/container';
import Database from 'lucide-react-native/icons/database';
import FileText from 'lucide-react-native/icons/file-text';
import Flame from 'lucide-react-native/icons/flame';
import FlaskConical from 'lucide-react-native/icons/flask-conical';
import GitBranch from 'lucide-react-native/icons/git-branch';
import Globe from 'lucide-react-native/icons/globe';
import Heart from 'lucide-react-native/icons/heart';
import Monitor from 'lucide-react-native/icons/monitor';
import Package from 'lucide-react-native/icons/package';
import Palette from 'lucide-react-native/icons/palette';
import Rocket from 'lucide-react-native/icons/rocket';
import Server from 'lucide-react-native/icons/server';
import Shield from 'lucide-react-native/icons/shield';
import Smartphone from 'lucide-react-native/icons/smartphone';
import Sparkles from 'lucide-react-native/icons/sparkles';
import SquareTerminal from 'lucide-react-native/icons/square-terminal';
import Star from 'lucide-react-native/icons/star';
import Workflow from 'lucide-react-native/icons/workflow';
import Wrench from 'lucide-react-native/icons/wrench';
import Zap from 'lucide-react-native/icons/zap';

import type { AgentId, DashboardSession } from '../bridge/messages';

// Ícones que uma sessão pode receber, espelho de
// packages/ui/src/terminals/session-icons.js: o mesmo id, que é o que fica
// gravado na sessão e chega pelo retrato, e o mesmo desenho lucide. A ordem é
// a da grade do seletor no desktop; ids novos entram lá primeiro e depois
// aqui, no fim. Cada ícone vem pelo próprio caminho, como em ./icons.tsx.
export const SESSION_ICONS = {
  terminal: SquareTerminal,
  code: Code,
  bug: Bug,
  rocket: Rocket,
  database: Database,
  server: Server,
  globe: Globe,
  smartphone: Smartphone,
  monitor: Monitor,
  package: Package,
  'git-branch': GitBranch,
  container: Container,
  flask: FlaskConical,
  wrench: Wrench,
  shield: Shield,
  cloud: Cloud,
  zap: Zap,
  workflow: Workflow,
  book: BookOpen,
  'file-text': FileText,
  palette: Palette,
  sparkles: Sparkles,
  bot: Bot,
  brain: Brain,
  chart: ChartLine,
  briefcase: Briefcase,
  star: Star,
  heart: Heart,
  flame: Flame,
  coffee: Coffee
} as const satisfies Record<string, LucideIcon>;

export type SessionIconId = keyof typeof SESSION_ICONS;

const isSessionIconId = (id: unknown): id is SessionIconId =>
  typeof id === 'string' && Object.prototype.hasOwnProperty.call(SESSION_ICONS, id);

// O desenho de um id do registro; id desconhecido, de uma versão mais nova do
// desktop, ou ausente, é nulo, e quem desenha cai no padrão.
export function sessionIconFor(id: unknown): LucideIcon | null {
  return isSessionIconId(id) ? SESSION_ICONS[id] : null;
}

export type ResolvedSessionIcon =
  | { kind: 'custom'; Icon: LucideIcon }
  | { kind: 'agent'; agent: AgentId }
  | { kind: 'default'; Icon: LucideIcon };

// O que o ícone da sessão desenha, na regra de `resolveSessionIcon` do
// desktop: o escolhido; sem escolha, o glifo do Claude ou do Codex que roda
// nela; sem agente, o terminal.
export function resolveSessionIcon(session: Pick<DashboardSession, 'icon' | 'agent'>): ResolvedSessionIcon {
  const Icon = sessionIconFor(session.icon);
  if (Icon) return { kind: 'custom', Icon };
  if (session.agent === 'claude' || session.agent === 'codex') return { kind: 'agent', agent: session.agent };
  return { kind: 'default', Icon: SquareTerminal };
}
