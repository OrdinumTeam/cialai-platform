import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { useTokens } from '../theme';
import { Icon, type IconName } from './icons';
import { lightColors, radius, TOUCH_TARGET } from './tokens';

// `plain` é só o ícone; `surface` tem fundo do card e borda; `soft` é rosa
// claro; `primary` segue o acento do tema; `header` é o botão do cabeçalho das
// telas, rosa forte com ícone branco nos dois temas, para o branco ter contraste.
export type IconButtonVariant = 'plain' | 'surface' | 'soft' | 'primary' | 'header';

type Props = {
  icon: IconName;
  // Obrigatório: o botão só tem ícone, então o leitor de tela precisa do nome.
  accessibilityLabel: string;
  onPress?: () => void;
  variant?: IconButtonVariant;
  size?: 'md' | 'lg';
  disabled?: boolean;
  selected?: boolean;
  tint?: string;
  style?: StyleProp<ViewStyle>;
};

const HEADER = { background: lightColors.primary, pressed: lightColors.primaryPressed, icon: '#FFFFFF' } as const;

export function IconButton({ icon, accessibilityLabel, onPress, variant = 'plain', size = 'md', disabled, selected, tint, style }: Props) {
  const { colors } = useTokens();
  const box = size === 'lg' ? 52 : 40;
  const background = variant === 'surface' ? colors.surface
    : variant === 'soft' ? colors.primarySoft
      : variant === 'primary' ? colors.primary
        : variant === 'header' ? HEADER.background : 'transparent';
  const pressedBackground = variant === 'surface' ? colors.surfacePressed
    : variant === 'soft' ? colors.primarySoftPressed
      : variant === 'primary' ? colors.primaryPressed
        : variant === 'header' ? HEADER.pressed : colors.surfacePressed;
  const color = tint ?? (variant === 'header' ? HEADER.icon : variant === 'primary' ? colors.onPrimary
    : variant === 'soft' || selected ? colors.primary : colors.text);
  return (
    <Pressable accessibilityLabel={accessibilityLabel} accessibilityRole="button" accessibilityState={{ disabled: !!disabled, selected }}
      disabled={disabled} hitSlop={(TOUCH_TARGET - box) / 2 > 0 ? (TOUCH_TARGET - box) / 2 : undefined} onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        // Com fundo, o botão segue o raio dos botões do site; só o ícone solto fica redondo ao toque.
        { width: box, height: box, borderRadius: variant === 'plain' ? box / 2 : radius.control, backgroundColor: pressed ? pressedBackground : background },
        variant === 'surface' && { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
        disabled && styles.disabled,
        style
      ]}>
      <Icon color={color} name={icon} size={size === 'lg' ? 24 : 20} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.4 }
});
