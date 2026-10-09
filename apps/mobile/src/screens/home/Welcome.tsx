import { StyleSheet, Text, View } from 'react-native';

import { useI18n } from '../../i18n';
import { useTokens } from '../../theme';
import { EmptyState, PrimaryButton, SkeletonLoader, radius, space, typography } from '../../ui';
import { WelcomeIllustration } from '../../ui/Illustrations';

const STEPS = ['mobile.home.empty.step1', 'mobile.home.empty.step2', 'mobile.home.empty.step3'] as const;

// Primeiro acesso: o início sem nenhum computador vinculado. Ilustração,
// convite e os três passos do vínculo, no lugar do painel.
export function FirstComputer({ onPair }: { onPair: () => void }) {
  const { colors } = useTokens();
  const { t } = useI18n();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.hero}>
        <WelcomeIllustration width={232} />
        <Text accessibilityRole="header" style={[typography.largeTitle, styles.center, { color: colors.text }]}>{t('mobile.home.empty.title')}</Text>
        <Text style={[typography.body, styles.center, { color: colors.textSecondary }]}>{t('mobile.home.empty.detail')}</Text>
      </View>
      <PrimaryButton icon="qr-code" label={t('mobile.home.empty.action')} onPress={onPair} style={styles.action} />
      <View style={[styles.steps, { borderTopColor: colors.border }]}>
        <Text accessibilityRole="header" style={[typography.footnote, styles.stepsTitle, { color: colors.textSecondary }]}>{t('mobile.home.empty.steps')}</Text>
        {STEPS.map((key, index) => (
          <View accessible key={key} style={styles.step}>
            <View style={[styles.number, { backgroundColor: colors.primarySoft }]}>
              <Text style={[typography.footnote, styles.numberText, { color: colors.primary }]}>{index + 1}</Text>
            </View>
            <Text style={[typography.callout, styles.flex, { color: colors.text }]}>{t(key)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// Os computadores guardados não puderam ser lidos. Não é primeiro acesso: o
// vínculo não é oferecido, para um novo não sobrescrever os que já existem.
export function StoreError({ onRetry }: { onRetry: () => void }) {
  const { colors } = useTokens();
  const { t } = useI18n();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <EmptyState action={{ label: t('mobile.home.storeError.retry'), onPress: onRetry, icon: 'refresh' }}
        detail={t('mobile.home.storeError.detail')} icon="laptop" title={t('mobile.error.storeLoad')} tone="error" />
    </View>
  );
}

// Esqueleto do painel enquanto a loja de computadores é lida, para o primeiro
// acesso nunca aparecer antes da confirmação de que não há vínculos.
export function HomeSkeleton() {
  const { t } = useI18n();
  return (
    <View accessibilityLabel={t('mobile.loading.detail')} accessibilityRole="progressbar" accessible style={styles.skeleton}>
      <View style={styles.row}>
        <SkeletonLoader height={104} style={[styles.flex, styles.block]} />
        <SkeletonLoader height={104} style={[styles.flex, styles.block]} />
      </View>
      <SkeletonLoader height={18} width="40%" />
      <SkeletonLoader height={148} style={styles.block} />
      <SkeletonLoader height={18} width="36%" />
      <View style={styles.row}>
        <SkeletonLoader height={132} style={[styles.flex, styles.block]} />
        <SkeletonLoader height={132} style={[styles.flex, styles.block]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.lg, gap: space.md },
  hero: { alignItems: 'center', gap: space.xs },
  center: { textAlign: 'center' },
  action: { alignSelf: 'stretch' },
  steps: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.md, gap: space.sm },
  stepsTitle: { fontWeight: '600' },
  step: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  number: { width: 28, height: 28, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  numberText: { fontWeight: '700' },
  flex: { flex: 1, minWidth: 0 },
  skeleton: { gap: space.md, paddingTop: space.xxs },
  row: { flexDirection: 'row', gap: space.sm },
  block: { borderRadius: radius.lg }
});
