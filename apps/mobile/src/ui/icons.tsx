import type { LucideIcon } from 'lucide-react-native';
import ArrowDown from 'lucide-react-native/icons/arrow-down';
import ArrowRight from 'lucide-react-native/icons/arrow-right';
import ArrowUp from 'lucide-react-native/icons/arrow-up';
import Bell from 'lucide-react-native/icons/bell';
import BellRing from 'lucide-react-native/icons/bell-ring';
import Bot from 'lucide-react-native/icons/bot';
import Check from 'lucide-react-native/icons/check';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import Clock from 'lucide-react-native/icons/clock';
import Cpu from 'lucide-react-native/icons/cpu';
import Ellipsis from 'lucide-react-native/icons/ellipsis';
import EllipsisVertical from 'lucide-react-native/icons/ellipsis-vertical';
import FileText from 'lucide-react-native/icons/file-text';
import Folder from 'lucide-react-native/icons/folder';
import FolderOpen from 'lucide-react-native/icons/folder-open';
import FolderPlus from 'lucide-react-native/icons/folder-plus';
import Gauge from 'lucide-react-native/icons/gauge';
import House from 'lucide-react-native/icons/house';
import Info from 'lucide-react-native/icons/info';
import Keyboard from 'lucide-react-native/icons/keyboard';
import Laptop from 'lucide-react-native/icons/laptop';
import List from 'lucide-react-native/icons/list';
import MemoryStick from 'lucide-react-native/icons/memory-stick';
import Monitor from 'lucide-react-native/icons/monitor';
import Moon from 'lucide-react-native/icons/moon';
import Pencil from 'lucide-react-native/icons/pencil';
import Plus from 'lucide-react-native/icons/plus';
import QrCode from 'lucide-react-native/icons/qr-code';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import ScrollText from 'lucide-react-native/icons/scroll-text';
import Search from 'lucide-react-native/icons/search';
import Send from 'lucide-react-native/icons/send';
import Settings from 'lucide-react-native/icons/settings';
import Shield from 'lucide-react-native/icons/shield';
import Sparkles from 'lucide-react-native/icons/sparkles';
import SquareTerminal from 'lucide-react-native/icons/square-terminal';
import Star from 'lucide-react-native/icons/star';
import Sun from 'lucide-react-native/icons/sun';
import SunMoon from 'lucide-react-native/icons/sun-moon';
import Trash from 'lucide-react-native/icons/trash';
import Unplug from 'lucide-react-native/icons/unplug';
import UserRound from 'lucide-react-native/icons/user-round';
import X from 'lucide-react-native/icons/x';
import Zap from 'lucide-react-native/icons/zap';

import { useTokens } from '../theme';

// Ícones de linha da mesma família lucide que a página do computador usa.
// Cada ícone é importado pelo próprio caminho para o pacote não levar o
// catálogo inteiro; um ícone novo entra aqui antes de ser usado.
export const ICONS = {
  'arrow-down': ArrowDown,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  bell: Bell,
  'bell-ring': BellRing,
  bot: Bot,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'circle-alert': CircleAlert,
  'circle-check': CircleCheck,
  clock: Clock,
  cpu: Cpu,
  ellipsis: Ellipsis,
  'ellipsis-vertical': EllipsisVertical,
  'file-text': FileText,
  folder: Folder,
  'folder-open': FolderOpen,
  'folder-plus': FolderPlus,
  gauge: Gauge,
  house: House,
  info: Info,
  keyboard: Keyboard,
  laptop: Laptop,
  list: List,
  memory: MemoryStick,
  monitor: Monitor,
  moon: Moon,
  pencil: Pencil,
  plus: Plus,
  'qr-code': QrCode,
  refresh: RefreshCw,
  'scroll-text': ScrollText,
  search: Search,
  send: Send,
  settings: Settings,
  shield: Shield,
  sparkles: Sparkles,
  star: Star,
  sun: Sun,
  'sun-moon': SunMoon,
  terminal: SquareTerminal,
  trash: Trash,
  unplug: Unplug,
  user: UserRound,
  x: X,
  zap: Zap
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

type Props = {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  // Preenche o desenho, como a estrela de um favorito.
  filled?: boolean;
};

// Decorativo por padrão: quem descreve a ação é o botão que contém o ícone.
export function Icon({ name, size = 22, color, strokeWidth = 1.8, filled }: Props) {
  const { colors } = useTokens();
  const Component = ICONS[name];
  const tint = color ?? colors.text;
  return <Component accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    color={tint} fill={filled ? tint : 'none'} size={size} strokeWidth={strokeWidth} />;
}
