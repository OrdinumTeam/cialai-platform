import Svg, { Circle, Defs, G, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import { useTokens } from '../theme';
import { projectTints } from './tokens';

type LaptopProps = { width?: number; online?: boolean };

// Notebook visto de frente, com a tela acesa no rosa da marca quando o
// computador responde e apagada quando não.
export function LaptopIllustration({ width = 112, online = true }: LaptopProps) {
  const { scheme } = useTokens();
  const height = Math.round(width * 0.68);
  const body = scheme === 'dark' ? '#4A4B55' : '#2B2D36';
  const base = scheme === 'dark' ? '#6B6E7A' : '#C9CEDA';
  return (
    <Svg accessibilityElementsHidden height={height} importantForAccessibility="no-hide-descendants" viewBox="0 0 112 76" width={width}>
      <Defs>
        <LinearGradient id="screen" x1="0" x2="1" y1="0" y2="1">
          <Stop offset="0" stopColor={online ? '#FF8DC0' : '#8E93A3'} />
          <Stop offset="0.55" stopColor={online ? '#B04DE0' : '#6A6F7E'} />
          <Stop offset="1" stopColor={online ? '#3E2A8C' : '#4A4E5A'} />
        </LinearGradient>
      </Defs>
      <Rect fill={body} height="58" rx="5" width="84" x="14" y="4" />
      <Rect fill="url(#screen)" height="50" rx="2" width="76" x="18" y="8" />
      <Path d={online ? 'M18 46 C 38 30, 58 52, 94 28 L94 58 L18 58 Z' : 'M18 50 L94 50 L94 58 L18 58 Z'} fill="#FFFFFF" opacity={0.18} />
      <Path d="M4 64 L108 64 L102 72 Q101 74 98 74 L14 74 Q11 74 10 72 Z" fill={base} />
      <Rect fill={body} height="2" opacity={0.25} rx="1" width="20" x="46" y="65" />
    </Svg>
  );
}

type WelcomeProps = { width?: number };

// Primeiro acesso: o notebook com o terminal aceso e o celular ao lado, com o
// código de vínculo na tela e um traço pontilhado ligando os dois.
export function WelcomeIllustration({ width = 240 }: WelcomeProps) {
  const { colors, scheme } = useTokens();
  const body = scheme === 'dark' ? '#4A4B55' : '#2B2D36';
  const base = scheme === 'dark' ? '#6B6E7A' : '#C9CEDA';
  const paper = scheme === 'dark' ? '#F4F4F7' : '#FFFFFF';
  return (
    <Svg accessibilityElementsHidden height={Math.round(width * 160 / 240)} importantForAccessibility="no-hide-descendants" viewBox="0 0 240 160" width={width}>
      <Defs>
        <LinearGradient id="welcomeScreen" x1="0" x2="1" y1="0" y2="1">
          <Stop offset="0" stopColor="#FF8DC0" />
          <Stop offset="0.55" stopColor="#B04DE0" />
          <Stop offset="1" stopColor="#3E2A8C" />
        </LinearGradient>
      </Defs>
      <Circle cx="118" cy="84" fill={colors.primarySoft} r="70" />
      <Circle cx="34" cy="38" fill={colors.primary} opacity={0.35} r="4" />
      <Circle cx="216" cy="30" fill={colors.primary} opacity={0.5} r="3" />
      <Circle cx="24" cy="128" fill={colors.primary} opacity={0.25} r="6" />
      <G transform="translate(22 34) scale(1.2)">
        <Rect fill={body} height="58" rx="5" width="84" x="14" y="4" />
        <Rect fill="url(#welcomeScreen)" height="50" rx="2" width="76" x="18" y="8" />
        <Rect fill="#FFFFFF" height="3" opacity={0.9} rx="1.5" width="8" x="24" y="16" />
        <Rect fill="#FFFFFF" height="3" opacity={0.6} rx="1.5" width="30" x="35" y="16" />
        <Rect fill="#FFFFFF" height="3" opacity={0.45} rx="1.5" width="40" x="24" y="24" />
        <Rect fill="#FFFFFF" height="3" opacity={0.45} rx="1.5" width="26" x="24" y="32" />
        <Rect fill="#FFFFFF" height="4" opacity={0.9} rx="1" width="6" x="24" y="40" />
        <Path d="M4 64 L108 64 L102 72 Q101 74 98 74 L14 74 Q11 74 10 72 Z" fill={base} />
        <Rect fill={body} height="2" opacity={0.25} rx="1" width="20" x="46" y="65" />
      </G>
      <Path d="M150 46 Q 186 14 198 64" fill="none" stroke={colors.primary} strokeDasharray="2 6" strokeLinecap="round" strokeWidth="2.5" />
      <Rect fill={body} height="82" rx="10" width="48" x="174" y="66" />
      <Rect fill={paper} height="70" rx="6" width="40" x="178" y="72" />
      <Rect fill="none" height="10" rx="2" stroke={colors.primary} strokeWidth="2.5" width="10" x="184" y="82" />
      <Rect fill="none" height="10" rx="2" stroke={colors.primary} strokeWidth="2.5" width="10" x="202" y="82" />
      <Rect fill="none" height="10" rx="2" stroke={colors.primary} strokeWidth="2.5" width="10" x="184" y="100" />
      <Rect fill={colors.primary} height="4" rx="1" width="4" x="203" y="101" />
      <Rect fill={colors.primary} height="4" rx="1" width="4" x="208" y="106" />
      <Rect fill={colors.primary} height="4" rx="1" width="4" x="203" y="111" />
      <Rect fill={body} height="4" opacity={0.2} rx="2" width="24" x="186" y="126" />
    </Svg>
  );
}

export type Tint = keyof typeof projectTints.light & ('pink' | 'blue' | 'green' | 'orange' | 'violet');

type FolderProps = { tint: Tint; width?: number };

// Pasta aberta com duas folhas saindo, nos tons do projeto.
export function FolderIllustration({ tint, width = 120 }: FolderProps) {
  const { scheme } = useTokens();
  const palette = projectTints[scheme];
  const colors = palette[tint];
  return (
    <Svg accessibilityElementsHidden height={Math.round(width * 0.62)} importantForAccessibility="no-hide-descendants" viewBox="0 0 120 74" width={width}>
      <Path d="M14 18 Q14 12 20 12 L46 12 L54 20 L98 20 Q104 20 104 26 L104 62 L14 62 Z" fill={colors.back} />
      <Rect fill={palette.paper} height="44" rx="4" transform="rotate(-7 52 32)" width="36" x="34" y="10" />
      <Rect fill={palette.paper} height="44" rx="4" transform="rotate(6 70 34)" width="36" x="52" y="12" />
      <Rect fill={palette.ink} height="3" rx="1.5" transform="rotate(6 70 34)" width="22" x="59" y="20" />
      <Rect fill={palette.ink} height="3" rx="1.5" transform="rotate(6 70 34)" width="18" x="59" y="27" />
      <Rect fill={palette.ink} height="3" rx="1.5" transform="rotate(6 70 34)" width="24" x="59" y="34" />
      <Path d="M8 34 Q8 30 12 30 L108 30 Q112 30 111 34 L106 66 Q105 70 101 70 L19 70 Q15 70 14 66 Z" fill={colors.front} />
    </Svg>
  );
}

export function tintCover(scheme: 'light' | 'dark', tint: Tint): string {
  return projectTints[scheme][tint].cover;
}
