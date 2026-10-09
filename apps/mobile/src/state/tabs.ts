import type { TabId } from '../ui';
import type { AppScreen } from './machine';

// Aba destacada em cada tela da casca. A lista de computadores é o caminho
// até o terminal, então destaca Terminais. As telas sem aba, como a página
// do computador, o pareamento e a falta de conexão, não mostram a barra.
export function tabForScreen(screen: AppScreen): TabId | null {
  switch (screen.kind) {
    case 'home': return 'home';
    case 'desktops': return 'terminals';
    case 'projects': return 'projects';
    case 'agents': return 'agents';
    case 'settings': return 'settings';
    default: return null;
  }
}
