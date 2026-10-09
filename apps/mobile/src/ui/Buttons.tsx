import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTokens } from '../theme';
import { Icon, type IconName } from './icons';
import { radius, space, typography } from './tokens';

type BaseProps = {
  label: string;
  onPress?: () => void;
  icon?: IconName;
  // Ícone depois do rótulo, como a seta de "Continuar".
  trailingIcon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  size?: 'md' | 'lg';
  style?: StyleProp<ViewStyle>;
};

// `link` e `link-danger` são ações de texto, sem fundo, como "Outro código".
// `bordered` é o botão branco com borda fina, ao lado de uma ação principal.
export type SecondaryVariant = 'soft' | 'neutral' | 'outline' | 'bordered' | 'danger' | 'link' | 'link-danger';

type Visual = { background: string; pressed: string; text: string; border?: string };

function ButtonBase({ label, onPress, icon, trailingIcon, loading, disabled, accessibilityLabel, size = 'md', style, visual }: BaseProps & { visual: Visual }) {
  const inactive = disabled || loading;
  return (
    <Pressable accessibilityLabel={accessibilityLabel} accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!loading }} disabled={inactive} onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        size === 'lg' && styles.large,
        { backgroundColor: pressed ? visual.pressed : visual.background },
        visual.border ? { borderWidth: 1, borderColor: visual.border } : null,
        disabled && !loading && styles.disabled,
        style
      ]}>
      {loading ? <ActivityIndicator color={visual.text} size="small" /> : (
        <View style={styles.content}>
          {icon ? <Icon color={visual.text} name={icon} size={20} /> : null}
          <Text numberOfLines={1} style={[styles.label, { color: visual.text }]}>{label}</Text>
          {trailingIcon ? <Icon color={visual.text} name={trailingIcon} size={20} /> : null}
        </View>
      )}
    </Pressable>
  );
}

// Ação principal da tela: pílula rosa preenchida.
export function PrimaryButton(props: BaseProps) {
  const { colors } = useTokens();
  return <ButtonBase {...props} visual={{ background: colors.primary, pressed: colors.primaryPressed, text: colors.onPrimary }} />;
}

// Ações de apoio: rosa claro, cinza, contorno rosa ou destrutiva.
export function SecondaryButton({ variant = 'soft', ...props }: BaseProps & { variant?: SecondaryVariant }) {
  const { colors } = useTokens();
  const visual: Visual = variant === 'neutral' ? { background: colors.surfaceMuted, pressed: colors.surfacePressed, text: colors.text }
    : variant === 'outline' ? { background: colors.surface, pressed: colors.primarySoft, text: colors.primary, border: colors.primary }
    : variant === 'bordered' ? { background: colors.surface, pressed: colors.surfacePressed, text: colors.text, border: colors.border }
      : variant === 'danger' ? { background: colors.danger, pressed: colors.danger, text: colors.onDanger }
        : variant === 'link' ? { background: 'transparent', pressed: colors.primarySoft, text: colors.primary }
          : variant === 'link-danger' ? { background: 'transparent', pressed: colors.dangerSoft, text: colors.danger }
            : { background: colors.primarySoft, pressed: colors.primarySoftPressed, text: colors.primary };
  return <ButtonBase {...props} visual={visual} />;
}

const styles = StyleSheet.create({
  base: { minHeight: 48, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg },
  large: { minHeight: 54 },
  content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs, maxWidth: '100%' },
  label: { ...typography.headline, flexShrink: 1 },
  disabled: { opacity: 0.45 }
});
