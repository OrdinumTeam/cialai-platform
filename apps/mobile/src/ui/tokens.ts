import { Platform, type TextStyle, type ViewStyle } from 'react-native';

// Tokens visuais do app. As cores são semânticas: os componentes pedem
// `primary` ou `border`, nunca um hexadecimal. O acento segue o contrato de
// marca em docs/produto/08-design-e-marca.md; os neutros seguem as referências
// em docs/design-references, com fundo levemente azulado e cartões brancos.
export const lightColors = {
  primary: '#E23B84',
  primaryPressed: '#C9317A',
  onPrimary: '#FFFFFF',
  primarySoft: '#FCE7F1',
  primarySoftPressed: '#F9D6E7',
  background: '#F8FAFF',
  surface: '#FFFFFF',
  surfaceMuted: '#F2F4F9',
  surfacePressed: '#EEF1F7',
  border: '#E7EAF2',
  borderStrong: '#D9DEE9',
  text: '#20232C',
  textSecondary: '#747B8B',
  textTertiary: '#9CA2B0',
  success: '#18A66A',
  successSoft: '#E3F5EC',
  warning: '#D38B17',
  warningSoft: '#FBF0DC',
  danger: '#E5484D',
  dangerSoft: '#FDE8E9',
  onDanger: '#FFFFFF',
  neutral: '#A9AFBC',
  terminal: '#202127',
  onTerminal: '#E9EAF0',
  scrim: 'rgba(20, 23, 33, 0.38)',
  overlay: 'rgba(255, 255, 255, 0.92)',
  shadow: '#1B2340'
} as const;

export const darkColors = {
  primary: '#FF7AB2',
  primaryPressed: '#FF8FC0',
  onPrimary: '#3A1B33',
  primarySoft: 'rgba(255, 122, 178, 0.16)',
  primarySoftPressed: 'rgba(255, 122, 178, 0.24)',
  background: '#000000',
  surface: '#1C1C1E',
  surfaceMuted: '#26262A',
  surfacePressed: '#2E2E33',
  border: 'rgba(84, 84, 88, 0.65)',
  borderStrong: 'rgba(120, 120, 128, 0.7)',
  text: '#F5F5F7',
  textSecondary: '#AEAEB2',
  textTertiary: '#8E8E93',
  success: '#3CCF76',
  successSoft: 'rgba(60, 207, 118, 0.16)',
  warning: '#F0A629',
  warningSoft: 'rgba(240, 166, 41, 0.16)',
  danger: '#FF5C5C',
  dangerSoft: 'rgba(255, 92, 92, 0.16)',
  onDanger: '#FFFFFF',
  neutral: '#6C6C72',
  terminal: '#202127',
  onTerminal: '#E9EAF0',
  scrim: 'rgba(0, 0, 0, 0.55)',
  overlay: 'rgba(28, 28, 30, 0.92)',
  shadow: '#000000'
} as const;

export type ColorTokens = { readonly [K in keyof typeof lightColors]: string };

export const space = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 20, xl: 24, xxl: 32 } as const;

// Raios do site cialai.com.br: 12 nos botões, segmentados, campos e blocos de
// ícone, 20 nos cards e 8 nos detalhes pequenos. `pill` fica só para selos e
// pontos.
export const radius = { sm: 8, md: 12, control: 12, lg: 20, xl: 24, pill: 999 } as const;

// A fonte do site cialai.com.br, Outfit, embutida no app pelo plugin do
// expo-font com um arquivo por peso, de 400 a 800, em src/assets/fonts. O
// `fontWeight` de cada estilo escolhe o arquivo nos dois sistemas.
export const FONT_FAMILY = 'Outfit';

// Tamanhos sem altura fixa de caixa: o texto cresce com o tamanho de fonte do
// sistema e o layout acompanha.
export const typography = {
  largeTitle: { fontFamily: FONT_FAMILY, fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: 0.2 },
  title: { fontFamily: FONT_FAMILY, fontSize: 20, lineHeight: 26, fontWeight: '700' },
  headline: { fontFamily: FONT_FAMILY, fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontFamily: FONT_FAMILY, fontSize: 16, lineHeight: 22, fontWeight: '400' },
  callout: { fontFamily: FONT_FAMILY, fontSize: 15, lineHeight: 20, fontWeight: '500' },
  footnote: { fontFamily: FONT_FAMILY, fontSize: 13, lineHeight: 18, fontWeight: '400' },
  caption: { fontFamily: FONT_FAMILY, fontSize: 11, lineHeight: 14, fontWeight: '500' }
} as const satisfies Record<string, TextStyle>;

// Sombra quase imperceptível, como nas referências; no escuro a borda basta.
export function cardShadow(scheme: 'light' | 'dark'): ViewStyle {
  if (scheme === 'dark') return {};
  return Platform.select<ViewStyle>({
    ios: { shadowColor: lightColors.shadow, shadowOpacity: 0.06, shadowRadius: 14, shadowOffset: { width: 0, height: 4 } },
    android: { elevation: 1 },
    default: {}
  });
}

// Área mínima de toque das diretrizes do iOS e do Android.
export const TOUCH_TARGET = 44;

// Capas dos projetos: um tom pastel por projeto, como nas referências. `paper`
// é a folha dos documentos; `back` e `front` são as duas abas da pasta.
export const projectTints = {
  light: {
    pink: { cover: '#FDEFF5', back: '#F7B3CF', front: '#EF7FAE' },
    blue: { cover: '#EEF3FF', back: '#AFC3F7', front: '#7E9DEE' },
    green: { cover: '#EAF7F0', back: '#9ADBB7', front: '#4DB883' },
    orange: { cover: '#FFF3E6', back: '#FFCB8E', front: '#FFA44A' },
    violet: { cover: '#F3EEFF', back: '#C6B4F6', front: '#9C82EE' },
    paper: '#FFFFFF',
    ink: '#DCE1EC'
  },
  dark: {
    pink: { cover: 'rgba(255, 122, 178, 0.14)', back: '#A8577C', front: '#E0679C' },
    blue: { cover: 'rgba(126, 157, 238, 0.14)', back: '#55689E', front: '#7E9DEE' },
    green: { cover: 'rgba(77, 184, 131, 0.14)', back: '#3F7D5E', front: '#4DB883' },
    orange: { cover: 'rgba(255, 164, 74, 0.14)', back: '#99683A', front: '#E99545' },
    violet: { cover: 'rgba(156, 130, 238, 0.14)', back: '#66589C', front: '#9C82EE' },
    paper: '#3A3A40',
    ink: '#55555C'
  }
} as const;

// Cor da marca de cada agente no card de uso.
export const agentColors = { claude: '#D97757' } as const;
