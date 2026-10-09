import { createContext, useContext } from 'react';
import { useColorScheme } from 'react-native';

import { cardShadow, darkColors, lightColors, radius, space, typography, type ColorTokens } from './ui/tokens';

// Aparência do app: segue o sistema por padrão, com escolha clara ou escura
// nos ajustes. A mesma escolha vai para a página do computador pela casca.
//
// Os neutros são os mesmos da página que o computador serve no telefone, para a
// barra nativa e a página formarem uma tela só. O acento continua sendo o rosa
// do Cialai. Os valores ficam em ./ui/tokens.ts.
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

export type Palette = ColorTokens;

export const ThemeModeContext = createContext<ThemeMode>('system');

export function useThemeMode(): ThemeMode {
  return useContext(ThemeModeContext);
}

export function useColorSchemeResolved(): ColorScheme {
  const mode = useThemeMode();
  const system = useColorScheme();
  return resolveScheme(mode, system);
}

export type Tokens = {
  scheme: ColorScheme;
  colors: Palette;
  space: typeof space;
  radius: typeof radius;
  typography: typeof typography;
  shadow: { card: ReturnType<typeof cardShadow> };
};

const lightTokens: Tokens = { scheme: 'light', colors: lightColors, space, radius, typography, shadow: { card: cardShadow('light') } };
const darkTokens: Tokens = { scheme: 'dark', colors: darkColors, space, radius, typography, shadow: { card: cardShadow('dark') } };

export function useTokens(): Tokens {
  return useColorSchemeResolved() === 'dark' ? darkTokens : lightTokens;
}
