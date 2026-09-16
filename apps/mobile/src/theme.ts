import { createContext, useContext } from 'react';
import { useColorScheme } from 'react-native';

// Aparência do app: segue o sistema por padrão, com escolha clara ou escura
// nos ajustes. A mesma escolha vai para a página do computador pela casca.
//
// Os neutros são os do iOS e os da página que o computador serve, para a
// barra nativa e a página formarem uma tela só, como no telefone do Ordinum
// Control. O acento continua sendo o rosa do Cialai.
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
  background: '#F2F2F7',
  surface: '#FFFFFF',
  chip: '#F5F6F8',
  label: '#1D1D1F',
  secondaryLabel: '#6E6E73',
  tertiaryLabel: '#8E8E93',
  separator: 'rgba(60, 60, 67, 0.22)',
  field: '#FFFFFF',
  accent: '#E23B84',
  accentPressed: '#C9317A',
  accentText: '#FFFFFF',
  danger: '#D83A3A',
  success: '#1F9D5B',
  warning: '#C27A00',
  overlay: 'rgba(255, 255, 255, 0.92)',
  shadow: '#000000'
} as const;

const dark = {
  background: '#000000',
  surface: '#1C1C1E',
  chip: '#26262A',
  label: '#F5F5F7',
  secondaryLabel: '#AEAEB2',
  tertiaryLabel: '#8E8E93',
  separator: 'rgba(84, 84, 88, 0.65)',
  field: '#1C1C1E',
  accent: '#FF7AB2',
  accentPressed: '#FF8FC0',
  accentText: '#3A1B33',
  danger: '#FF5C5C',
  success: '#3CCF76',
  warning: '#F0A629',
  overlay: 'rgba(28, 28, 30, 0.92)',
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
