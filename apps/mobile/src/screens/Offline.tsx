import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { retryDelay } from '../state/connection';
import type { OfflineReason } from '../state/machine';
import { useI18n } from '../i18n';
import { RequestGate } from '../network/request-gate';
import { usePalette } from '../theme';

const reasonKeys: Record<OfflineReason, { title: string; detail: string }> = {
  reconnecting: { title: 'mobile.offline.reconnecting.title', detail: 'mobile.offline.reconnecting.detail' },
  'reserve-preparing': { title: 'mobile.offline.reservePreparing.title', detail: 'mobile.offline.reservePreparing.detail' },
  'reserve-unavailable': { title: 'mobile.offline.reserveUnavailable.title', detail: 'mobile.offline.reserveUnavailable.detail' },
  'no-path': { title: 'mobile.offline.noPath.title', detail: 'mobile.offline.noPath.detail' },
  tunnel: { title: 'mobile.offline.tunnel.title', detail: 'mobile.offline.tunnel.detail' },
  removed: { title: 'mobile.offline.removed.title', detail: 'mobile.offline.removed.detail' }
};

type Props = {
  reason: OfflineReason;
  // Progresso da conexão de reserva enquanto ela prepara; nulo quando não se aplica.
  reserveProgress: number | null;
  onRetry: () => Promise<boolean>;
  onDesktops: () => void;
  onPairAgain: () => void;
};

export function Offline({ reason, reserveProgress, onRetry, onDesktops, onPairAgain }: Props) {
  const palette = usePalette();
  const { t } = useI18n();
  const [checking, setChecking] = useState(false);
  const [gate] = useState(() => new RequestGate());
  const attempt = useRef(0);
  const attemptReason = useRef(reason);
  const leaving = useRef(false);
  const removed = reason === 'removed';
  const connecting = reason === 'reconnecting' || reason === 'reserve-preparing';

  async function retry() {
    const epoch = gate.begin();
    setChecking(true);
    const healthy = await onRetry();
    if (!leaving.current && gate.isCurrent(epoch)) setChecking(false);
    return healthy;
  }

  // Cada motivo novo recomeça em 2 s; a revogação nunca agenda outra tentativa.
  useEffect(() => {
    if (attemptReason.current !== reason) {
      attemptReason.current = reason;
      attempt.current = 0;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const delay = retryDelay(reason, attempt.current);
      if (delay === null) return;
      attempt.current += 1;
      timer = setTimeout(async () => {
        if (cancelled || leaving.current) return;
        if (!(await onRetry()) && !cancelled) schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [onRetry, reason]);

  useEffect(() => () => gate.invalidate(), [gate]);
  const copy = reasonKeys[reason];
  const leave = (action: () => void) => {
    leaving.current = true;
    gate.invalidate();
    action();
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: palette.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.status, { backgroundColor: palette.surface, borderColor: palette.separator }]}>
          <View style={[styles.statusDot, { backgroundColor: connecting ? palette.warning : palette.danger }]} />
          <Text style={[styles.statusText, { color: palette.secondaryLabel }]}>
            {t(connecting ? 'mobile.offline.statusConnecting' : 'mobile.offline.status')}
          </Text>
        </View>
        <Text accessibilityRole="header" style={[styles.title, { color: palette.label }]}>{t(copy.title)}</Text>
        <Text style={[styles.body, { color: palette.secondaryLabel }]}>{t(copy.detail)}</Text>
        {reason === 'reserve-preparing' && reserveProgress !== null ? (
          <View accessibilityLiveRegion="polite" style={styles.progress}>
            <View style={styles.progressHeader}>
              <Text style={[styles.progressLabel, { color: palette.label }]}>{t('mobile.transport.torDescription')}</Text>
              <Text style={[styles.progressValue, { color: palette.secondaryLabel }]}>
                {t('mobile.reserve.progress', { progress: reserveProgress })}
              </Text>
            </View>
            <View style={[styles.progressTrack, { backgroundColor: palette.separator }]}>
              <View style={[styles.progressFill, { backgroundColor: palette.warning, width: `${reserveProgress}%` }]} />
            </View>
          </View>
        ) : null}
        {removed ? (
          <Pressable accessibilityRole="button" onPress={() => leave(onPairAgain)}
            style={({ pressed }) => [styles.primary, { backgroundColor: pressed ? palette.accentPressed : palette.accent }]}>
            <Text style={[styles.primaryText, { color: palette.accentText }]}>{t('mobile.offline.pairAgain')}</Text>
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" disabled={checking} onPress={() => void retry()}
            style={({ pressed }) => [styles.primary, { backgroundColor: pressed ? palette.accentPressed : palette.accent }, checking && styles.disabled]}>
            {checking ? <ActivityIndicator color={palette.accentText} />
              : <Text style={[styles.primaryText, { color: palette.accentText }]}>{t('mobile.offline.retry')}</Text>}
          </Pressable>
        )}
        <Pressable accessibilityRole="button" onPress={() => leave(onDesktops)} style={styles.secondary}>
          <Text style={[styles.secondaryText, { color: palette.accent }]}>{t('mobile.offline.switchDesktop')}</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 32 },
  status: { minHeight: 32, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, paddingHorizontal: 12, marginBottom: 24 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 13, fontWeight: '600' },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  body: { marginTop: 12, fontSize: 17, lineHeight: 25 },
  progress: { marginTop: 24, gap: 8 },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
  progressLabel: { flexShrink: 1, fontSize: 15, fontWeight: '600' },
  progressValue: { fontSize: 15, fontVariant: ['tabular-nums'] },
  progressTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3 },
  primary: { minHeight: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', marginTop: 32 },
  primaryText: { fontSize: 17, fontWeight: '600' },
  secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  secondaryText: { fontSize: 17, fontWeight: '600' },
  disabled: { opacity: 0.62 }
});
