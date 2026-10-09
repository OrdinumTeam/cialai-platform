import { useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View,
  type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '../i18n';
import { useTokens } from '../theme';
import { PrimaryButton } from './Buttons';
import { IconButton } from './IconButton';
import { Icon, type IconName } from './icons';
import { radius, space, typography } from './tokens';

type SheetProps = {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
};

// Folha que sobe de baixo, com alça, título e fechar. Acompanha o teclado e
// respeita a área segura inferior.
export function BottomSheet({ visible, title, onClose, children }: SheetProps) {
  const { colors } = useTokens();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="slide" onRequestClose={onClose} statusBarTranslucent transparent visible={visible}>
      {/* A folha nunca passa da barra de estado nem do recorte da tela, e na
          horizontal fica com largura de leitura, centrada. */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.sheetRoot, { paddingTop: insets.top + space.xl }]}>
        <Pressable accessibilityLabel={t('mobile.common.close')} accessibilityRole="button" onPress={onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]} />
        <View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: Math.max(insets.bottom, space.md),
          paddingLeft: insets.left, paddingRight: insets.right }]}>
          <View style={[styles.handle, { backgroundColor: colors.borderStrong }]} />
          <View style={styles.sheetHead}>
            <Text accessibilityRole="header" numberOfLines={1} style={[typography.title, styles.sheetTitle, { color: colors.text }]}>{title}</Text>
            <IconButton accessibilityLabel={t('mobile.common.close')} icon="x" onPress={onClose} />
          </View>
          <ScrollView bounces={false} contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">{children}</ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

type EmptyProps = {
  icon: IconName;
  title: string;
  detail?: string;
  action?: { label: string; onPress: () => void; icon?: IconName };
  tone?: 'default' | 'error';
};

export function EmptyState({ icon, title, detail, action, tone = 'default' }: EmptyProps) {
  const { colors } = useTokens();
  const error = tone === 'error';
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: error ? colors.dangerSoft : colors.primarySoft }]}>
        <Icon color={error ? colors.danger : colors.primary} name={icon} size={30} strokeWidth={1.6} />
      </View>
      <Text accessibilityRole="header" style={[typography.title, styles.center, { color: colors.text }]}>{title}</Text>
      {detail ? <Text style={[typography.body, styles.center, { color: colors.textSecondary }]}>{detail}</Text> : null}
      {action ? <PrimaryButton icon={action.icon} label={action.label} onPress={action.onPress} style={styles.emptyAction} /> : null}
    </View>
  );
}

// Respeita a opção do sistema de reduzir movimento.
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then(value => { if (alive) setReduced(value); }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { alive = false; subscription.remove(); };
  }, []);
  return reduced;
}

type SkeletonProps = { width?: DimensionValue; height?: number; rounded?: boolean; style?: StyleProp<ViewStyle> };

// Bloco de carregamento que pulsa devagar no lugar do conteúdo.
export function SkeletonLoader({ width = '100%', height = 16, rounded, style }: SkeletonProps) {
  const { colors } = useTokens();
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (reduced) { opacity.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 0.45, duration: 700, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true })
    ]));
    loop.start();
    return () => loop.stop();
  }, [opacity, reduced]);
  return (
    <Animated.View accessibilityLabel={t('mobile.common.loading')} accessibilityRole="progressbar"
      style={[{ width, height, opacity, borderRadius: rounded ? height / 2 : radius.sm, backgroundColor: colors.surfaceMuted }, style]} />
  );
}

const styles = StyleSheet.create({
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheet: { width: '100%', maxWidth: 640, alignSelf: 'center', maxHeight: '100%', borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingTop: space.xs },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, marginBottom: space.xs },
  sheetHead: { flexDirection: 'row', alignItems: 'center', paddingLeft: space.lg, paddingRight: space.xs, minHeight: 48 },
  sheetTitle: { flex: 1 },
  sheetBody: { paddingHorizontal: space.lg, paddingBottom: space.xs, gap: space.sm },
  empty: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingHorizontal: space.xl, paddingVertical: space.xxl },
  emptyIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: space.xs },
  center: { textAlign: 'center' },
  emptyAction: { marginTop: space.sm, alignSelf: 'stretch' }
});
