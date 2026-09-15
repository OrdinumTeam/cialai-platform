import { createContext, useContext } from 'react';
import { useColorScheme } from 'react-native';

// Aparência do app: segue o sistema por padrão, com escolha clara ou escura
// nos ajustes. A mesma escolha vai para a página do computador pela casca.
export type ThemeMode = 'system' | 'light' | 'dark';
export type ColorScheme = 'light' | 'dark';

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];
export const THEME_STORAGE_KEY = 'cialai.theme';

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system';
}

// `system` aceita o ColorSchemeName do React Native, que inclui 'unspecified'.
export function resolveScheme(mode: ThemeMode, system: string | null | undefined): ColorScheme {
  if (mode === 'light' || mode === 'dark') return mode;
  return system === 'dark' ? 'dark' : 'light';
}

const light = {
  background: '#F7F5F6',
  surface: '#FFFFFF',
  label: '#171114',
  secondaryLabel: '#6B6065',
  tertiaryLabel: '#91868B',
  separator: 'rgba(73, 43, 57, 0.18)',
  field: '#FFFFFF',
  accent: '#B71867',
  accentPressed: '#8F124F',
  accentText: '#FFFFFF',
  danger: '#D92D20',
  success: '#248A3D',
  warning: '#B25F00',
  overlay: 'rgba(255, 255, 255, 0.94)',
  shadow: '#000000'
} as const;

const dark = {
  background: '#100B0E',
  surface: '#21171C',
  label: '#FFFFFF',
  secondaryLabel: '#C8BBC1',
  tertiaryLabel: '#998C92',
  separator: 'rgba(224, 190, 205, 0.22)',
  field: '#21171C',
  accent: '#FF7AB2',
  accentPressed: '#FF9AC5',
  accentText: '#32101F',
  danger: '#FF6961',
  success: '#30D158',
  warning: '#FFB340',
  overlay: 'rgba(33, 23, 28, 0.94)',
  shadow: '#000000'
} as const;

export type Palette = typeof light | typeof dark;

export const ThemeModeContext = createContext<ThemeMode>('system');

export function useThemeMode(): ThemeMode {
  return useContext(ThemeModeContext);
}

export function useColorSchemeResolved(): ColorScheme {
  const mode = useThemeMode();
  const system = useColorScheme();
  return resolveScheme(mode, system);
}

export function usePalette(): Palette {
  return useColorSchemeResolved() === 'dark' ? dark : light;
}
