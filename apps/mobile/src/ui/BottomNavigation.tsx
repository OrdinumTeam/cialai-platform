import { useEffect, useState } from 'react';
import { Keyboard, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '../i18n';
import { useTokens } from '../theme';
import { Icon, type IconName } from './icons';
import { space, typography } from './tokens';

export type TabId = 'home' | 'terminals' | 'projects' | 'agents' | 'settings';

export const TABS: readonly { id: TabId; icon: IconName; label: string }[] = [
  { id: 'home', icon: 'house', label: 'mobile.tabs.home' },
  { id: 'terminals', icon: 'terminal', label: 'mobile.tabs.terminals' },
  { id: 'projects', icon: 'folder', label: 'mobile.tabs.projects' },
  { id: 'agents', icon: 'bot', label: 'mobile.tabs.agents' },
  { id: 'settings', icon: 'settings', label: 'mobile.tabs.settings' }
];

type Props = { active: TabId | null; onSelect: (tab: TabId) => void };

// Esconde a barra enquanto o teclado está aberto: o espaço vai para o campo.
function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setVisible(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return visible;
}

// Barra inferior das telas nativas. Em paisagem o rótulo fica ao lado do ícone
// para a barra ocupar menos altura.
export function BottomNavigation({ active, onSelect }: Props) {
  const { colors } = useTokens();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const keyboardVisible = useKeyboardVisible();
  if (keyboardVisible) return null;
  const landscape = width > height;
  return (
    <View accessibilityLabel={t('mobile.tabs.label')} accessibilityRole="tablist"
      style={[styles.bar, { backgroundColor: colors.surface, borderTopColor: colors.border,
        paddingBottom: Math.max(insets.bottom, space.xs), paddingLeft: insets.left, paddingRight: insets.right }]}>
      {TABS.map(tab => {
        const selected = tab.id === active;
        const color = selected ? colors.primary : colors.textSecondary;
        return (
          <Pressable accessibilityLabel={t(tab.label)} accessibilityRole="tab" accessibilityState={{ selected }} key={tab.id}
            onPress={() => onSelect(tab.id)} style={({ pressed }) => [styles.tab, landscape && styles.tabLandscape, pressed && styles.pressed]}>
            <Icon color={color} name={tab.icon} size={landscape ? 20 : 22} strokeWidth={selected ? 2.1 : 1.8} />
            <Text maxFontSizeMultiplier={1.3} numberOfLines={1}
              style={[styles.label, { color, fontWeight: selected ? '600' : '500' }]}>{t(tab.label)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.xxs },
  tab: { flex: 1, minHeight: 50, alignItems: 'center', justifyContent: 'center', gap: 3, paddingHorizontal: 2 },
  tabLandscape: { minHeight: 44, flexDirection: 'row', gap: space.xs },
  label: { ...typography.caption, fontSize: 11 },
  pressed: { opacity: 0.6 }
});
