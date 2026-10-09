import { useEffect, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';

import { useI18n } from '../i18n';
import { useTokens } from '../theme';
import { IconButton } from './IconButton';
import { Icon, type IconName } from './icons';
import { radius, space, TOUCH_TARGET, typography } from './tokens';

export type SegmentOption<T extends string> = { value: T; label: string; count?: number; accessibilityLabel?: string; disabled?: boolean };

type SegmentedProps<T extends string> = {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  // `filled` é a faixa cinza com o item em rosa; `separate` deixa cada opção como pílula própria.
  variant?: 'filled' | 'separate';
  // Opções de largura livre numa faixa que rola, como os nomes dos computadores.
  scrollable?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function SegmentedControl<T extends string>({ options, value, onChange, variant = 'filled', scrollable, style }: SegmentedProps<T>) {
  const { colors } = useTokens();
  const control = (
    <View accessibilityRole="tablist"
      style={[styles.segment, variant === 'filled' ? { backgroundColor: colors.surface, borderColor: colors.border } : styles.segmentSeparate, style]}>
      {options.map(option => {
        const selected = option.value === value;
        return (
          <Pressable accessibilityLabel={option.accessibilityLabel ?? option.label} accessibilityRole="tab"
            accessibilityState={{ selected, disabled: !!option.disabled }} disabled={option.disabled} key={option.value}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.segmentItem,
              scrollable && styles.segmentItemFree,
              variant === 'separate' && [styles.segmentItemSeparate, { backgroundColor: colors.surfaceMuted }],
              selected && { backgroundColor: colors.primary },
              pressed && !selected && { backgroundColor: colors.surfacePressed },
              option.disabled && styles.disabled
            ]}>
            <Text numberOfLines={1} style={[styles.segmentText, scrollable && styles.segmentTextFree, { color: selected ? colors.onPrimary : colors.text }]}>{option.label}</Text>
            {option.count !== undefined ? (
              <View style={[styles.count, { backgroundColor: selected ? colors.onPrimary : colors.surfaceMuted }]}>
                <Text style={[styles.countText, { color: selected ? colors.primary : colors.textSecondary }]}>{option.count}</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
  if (!scrollable) return control;
  return <ScrollView horizontal showsHorizontalScrollIndicator={false}>{control}</ScrollView>;
}

export type TileOption<T extends string> = { value: T; label: string; icon: IconName };

type TilesProps<T extends string> = {
  options: readonly TileOption<T>[];
  value: T;
  onChange: (value: T) => void;
};

// Cartões lado a lado com ícone e rótulo, como a escolha de aparência das
// referências. O escolhido ganha borda e fundo rosa claro.
export function OptionTiles<T extends string>({ options, value, onChange }: TilesProps<T>) {
  const { colors } = useTokens();
  return (
    <View accessibilityRole="radiogroup" style={styles.tiles}>
      {options.map(option => {
        const selected = option.value === value;
        return (
          <Pressable accessibilityLabel={option.label} accessibilityRole="radio" accessibilityState={{ selected, checked: selected }}
            key={option.value} onPress={() => onChange(option.value)}
            style={({ pressed }) => [styles.tile, {
              borderColor: selected ? colors.primary : colors.border,
              backgroundColor: selected ? colors.primarySoft : pressed ? colors.surfacePressed : colors.surface
            }]}>
            <Icon color={selected ? colors.primary : colors.text} name={option.icon} size={24} />
            <Text numberOfLines={1} style={[typography.footnote, styles.tileText, { color: selected ? colors.primary : colors.text }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

type ToggleProps = {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  icon?: IconName;
  detail?: string;
  disabled?: boolean;
};

// Linha com ícone, rótulo e interruptor. A linha inteira é o alvo de toque.
export function Toggle({ label, value, onChange, icon, detail, disabled }: ToggleProps) {
  const { colors } = useTokens();
  return (
    <Pressable accessibilityLabel={label} accessibilityRole="switch" accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled} onPress={() => onChange(!value)} style={[styles.toggle, disabled && styles.disabled]}>
      {icon ? <Icon color={colors.textSecondary} name={icon} size={20} /> : null}
      <View style={styles.toggleBody}>
        <Text style={[typography.callout, { color: colors.text }]}>{label}</Text>
        {detail ? <Text style={[typography.footnote, { color: colors.textSecondary }]}>{detail}</Text> : null}
      </View>
      <SwitchTrack value={value} />
    </Pressable>
  );
}

const TRACK = { width: 48, height: 28, inset: 3 } as const;
// O botão do interruptor é branco nos dois temas, como o do sistema.
const KNOB_COLOR = '#FFFFFF';

// Trilho do interruptor com o raio dos controles, no lugar do Switch do
// sistema, que não aceita outro formato. A linha inteira recebe o toque.
function SwitchTrack({ value }: { value: boolean }) {
  const { colors } = useTokens();
  const [position] = useState(() => new Animated.Value(value ? 1 : 0));
  useEffect(() => {
    Animated.timing(position, { toValue: value ? 1 : 0, duration: 160, useNativeDriver: true }).start();
  }, [position, value]);
  const knob = TRACK.height - TRACK.inset * 2;
  const travel = TRACK.width - knob - TRACK.inset * 2;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={[styles.track, { backgroundColor: value ? colors.primary : colors.borderStrong }]}>
      <Animated.View style={[styles.knob, { width: knob, height: knob, backgroundColor: KNOB_COLOR,
        transform: [{ translateX: position.interpolate({ inputRange: [0, 1], outputRange: [0, travel] }) }] }]} />
    </View>
  );
}

type SearchProps = {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

export function SearchInput({ value, onChangeText, placeholder, accessibilityLabel, style }: SearchProps) {
  const { colors } = useTokens();
  const { t } = useI18n();
  return (
    <View style={[styles.search, { backgroundColor: colors.surfaceMuted }, style]}>
      <Icon color={colors.textSecondary} name="search" size={18} />
      <TextInput accessibilityLabel={accessibilityLabel ?? placeholder} autoCapitalize="none" autoCorrect={false}
        clearButtonMode="never" onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.textTertiary}
        returnKeyType="search" style={[styles.searchInput, { color: colors.text }]} value={value} />
      {value ? <IconButton accessibilityLabel={t('mobile.common.clearSearch')} icon="x" onPress={() => onChangeText('')}
        tint={colors.textSecondary} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  segment: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.control, padding: 3, gap: 2 },
  segmentSeparate: { padding: 0, borderWidth: 0, gap: space.xs },
  segmentItemSeparate: { borderRadius: radius.control },
  segmentItem: { flex: 1, minHeight: TOUCH_TARGET, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: radius.control - 3, paddingHorizontal: space.xs },
  // Na faixa que rola nada encolhe: cada opção tem a largura do nome, até um
  // limite, e o nome longo termina em reticências.
  segmentItemFree: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', paddingHorizontal: space.md },
  segmentTextFree: { flexShrink: 0, maxWidth: 190 },
  // Letra das referências: três opções como "Desconectados" cabem inteiras no telefone.
  segmentText: { ...typography.footnote, fontWeight: '600', flexShrink: 1 },
  count: { minWidth: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  countText: { ...typography.caption, fontSize: 12, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  tiles: { flexDirection: 'row', gap: space.xs },
  tile: { flex: 1, minHeight: 76, alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: space.xxs },
  tileText: { fontWeight: '600' },
  toggle: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  toggleBody: { flex: 1, minWidth: 0, gap: 2 },
  track: { width: TRACK.width, height: TRACK.height, borderRadius: radius.sm + 1, padding: TRACK.inset },
  knob: { borderRadius: radius.sm - 2 },
  search: { minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: space.xs, borderRadius: radius.control, paddingLeft: space.sm, paddingRight: space.xxs },
  searchInput: { ...typography.body, flex: 1, minHeight: 44, paddingVertical: 0 }
});
