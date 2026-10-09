import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { retryDelay } from '../state/connection';
import type { OfflineReason } from '../state/machine';
import { useI18n } from '../i18n';
import { RequestGate } from '../network/request-gate';
import { useTokens } from '../theme';
import { Card, PrimaryButton, ProgressIndicator, SecondaryButton, StatusBadge, space, typography } from '../ui';

const reasonKeys: Record<OfflineReason, { title: string; detail: string }> = {
  reconnecting: { title: 'mobile.offline.reconnecting.title', detail: 'mobile.offline.reconnecting.detail' },
  'reserve-preparing': { title: 'mobile.offline.reservePreparing.title', detail: 'mobile.offline.reservePreparing.detail' },
  'reserve-unavailable': { title: 'mobile.offline.reserveUnavailable.title', detail: 'mobile.offline.reserveUnavailable.detail' },
  'no-path': { title: 'mobile.offline.noPath.title', detail: 'mobile.offline.noPath.detail' },
  tunnel: { title: 'mobile.offline.tunnel.title', detail: 'mobile.offline.tunnel.detail' },
  removed: { title: 'mobile.offline.removed.title', detail: 'mobile.offline.removed.detail' }
};

type Props = {
  desktopId: string;
  reason: OfflineReason;
  // Progresso da conexão de reserva enquanto ela prepara; nulo quando não se aplica.
  reserveProgress: number | null;
  onRetry: () => Promise<boolean>;
  onHome: () => void;
  onDesktops: () => void;
  onSettings: () => void;
  onPair: () => void;
  onPairAgain: () => void;
};

export function Offline({ desktopId, reason, reserveProgress, onRetry, onHome, onDesktops, onSettings, onPair, onPairAgain }: Props) {
  const { colors } = useTokens();
  const { t } = useI18n();
  const [checking, setChecking] = useState(false);
  const [gate] = useState(() => new RequestGate());
  // A escada é do computador, não do motivo: o motivo alterna entre túnel, sem
  // caminho e reserva preparando enquanto o núcleo procura, e zerar a cada troca
  // prendia as tentativas em 2 s.
  const attempt = useRef({ desktopId, count: 0 });
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

  // Outro computador recomeça em 2 s; a revogação nunca agenda outra tentativa.
  // O app também tenta na hora quando o núcleo anuncia um caminho ou a reserva pronta.
  useEffect(() => {
    if (attempt.current.desktopId !== desktopId) attempt.current = { desktopId, count: 0 };
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // O degrau só avança quando a tentativa dispara: trocar de motivo reagenda
    // o mesmo degrau em vez de pular um.
    const schedule = () => {
      const delay = retryDelay(reason, attempt.current.count);
      if (delay === null) return;
      timer = setTimeout(async () => {
        if (cancelled || leaving.current) return;
        attempt.current.count += 1;
        if (!(await onRetry()) && !cancelled) schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [desktopId, onRetry, reason]);

  useEffect(() => () => gate.invalidate(), [gate]);
  const copy = reasonKeys[reason];
  const leave = (action: () => void) => {
    leaving.current = true;
    gate.invalidate();
    action();
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Tudo num card só; as ações em coluna, cada uma na linha inteira. */}
        <Card style={styles.card}>
          <View style={styles.status}>
            <StatusBadge label={t(connecting ? 'mobile.offline.statusConnecting' : 'mobile.offline.status')}
              tone={connecting ? 'warning' : 'danger'} variant="pill" />
          </View>
          <Text accessibilityRole="header" style={[typography.largeTitle, { color: colors.text }]}>{t(copy.title)}</Text>
          <Text style={[typography.body, styles.body, { color: colors.textSecondary }]}>{t(copy.detail)}</Text>
          {reason === 'reserve-preparing' && reserveProgress !== null ? (
            <View accessibilityLiveRegion="polite" style={styles.progress}>
              <ProgressIndicator detail={t('mobile.reserve.progress', { progress: reserveProgress })}
                label={t('mobile.transport.torDescription')} tone="warning" value={reserveProgress / 100} />
            </View>
          ) : null}
          <View style={styles.actions}>
            {removed
              ? <PrimaryButton label={t('mobile.offline.pairAgain')} onPress={() => leave(onPairAgain)} size="lg" />
              : <PrimaryButton label={t('mobile.offline.retry')} loading={checking} onPress={() => void retry()} size="lg" />}
            <SecondaryButton accessibilityLabel={t('mobile.home.open')} icon="house" label={t('mobile.home.back')}
              onPress={() => leave(onHome)} size="lg" variant="bordered" />
            <SecondaryButton accessibilityLabel={t('mobile.home.openDesktops')} icon="monitor" label={t('mobile.home.desktops')}
              onPress={() => leave(onDesktops)} size="lg" variant="bordered" />
            <SecondaryButton accessibilityLabel={t('mobile.desktops.openSettings')} icon="settings" label={t('mobile.home.settings')}
              onPress={() => leave(onSettings)} size="lg" variant="bordered" />
            {removed ? null : (
              <SecondaryButton accessibilityLabel={t('mobile.home.openPair')} icon="qr-code" label={t('mobile.home.pair')}
                onPress={() => leave(onPair)} size="lg" variant="bordered" />
            )}
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: space.lg, paddingVertical: space.xxl },
  card: { padding: space.lg },
  status: { flexDirection: 'row', marginBottom: space.lg },
  body: { marginTop: space.sm },
  progress: { marginTop: space.lg },
  actions: { marginTop: space.xl, gap: space.sm }
});
