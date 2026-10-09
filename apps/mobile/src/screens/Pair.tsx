import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  addListener as addTunnelListener,
  inspectPairPayload,
  pair,
  stop as stopTunnel,
  type DeviceDescription,
  type PairInspection,
  type PairResult
} from 'cialai-tunnel';

import { formatFingerprint } from '../desktops/format';
import { useI18n } from '../i18n';
import {
  advancePairProgress,
  initialPairProgress,
  PAIR_STAGES,
  stageStatus,
  type PairStage
} from '../state/pair-progress';
import { interpretTunnelEvent, reservePercent } from '../state/tunnel-events';
import { useTokens } from '../theme';
import { Card, Icon, PrimaryButton, SecondaryButton, StatusBadge, TOUCH_TARGET, radius, space, typography } from '../ui';
import { pairErrorMessage } from './pair-errors';

type Props = {
  initialError?: string;
  notice?: string;
  device: DeviceDescription;
  onPaired: (result: PairResult) => Promise<void>;
  onCancel?: () => void;
};

const STAGE_KEYS: Readonly<Record<PairStage, string>> = {
  reading: 'mobile.pair.stage.reading',
  lan: 'mobile.pair.stage.lan',
  internet: 'mobile.pair.stage.internet',
  reserve: 'mobile.pair.stage.reserve',
  confirming: 'mobile.pair.stage.confirming'
};

const STAGE_TICK_MS = 250;
// Depois disso na reserva, a tela explica a demora e mostra o tempo.
export const PAIR_SLOW_HINT_MS = 8_000;

export function Pair({ initialError, notice, device, onPaired, onCancel }: Props) {
  const { colors } = useTokens();
  const { t } = useI18n();
  const [permission, requestPermission] = useCameraPermissions();
  const [inspection, setInspection] = useState<PairInspection | null>(null);
  const [rawPayload, setRawPayload] = useState('');
  const [error, setError] = useState(initialError ?? '');
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [progress, dispatchProgress] = useReducer(advancePairProgress, undefined, initialPairProgress);
  const cancelled = useRef(false);

  // Enquanto o pareamento corre, os eventos do núcleo e o relógio avançam a etapa exibida.
  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const ms = Date.now() - startedAt;
      setElapsedMs(ms);
      dispatchProgress({ type: 'elapsed', ms });
    }, STAGE_TICK_MS);
    const subscription = addTunnelListener(event => {
      for (const signal of interpretTunnelEvent(event)) {
        if (signal.type === 'pair-stage') dispatchProgress({ type: 'core-stage', state: signal.state });
        if (signal.type === 'tor') dispatchProgress({ type: 'tor', tor: signal.tor });
      }
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [busy]);

  const inspect = useCallback(async (payload: string) => {
    const clean = payload.trim();
    if (!clean) return;
    setReading(true);
    setError('');
    dispatchProgress({ type: 'reading' });
    try {
      const value = await inspectPairPayload(clean);
      setRawPayload(clean);
      setInspection(value);
    } catch (caught) {
      setError(pairErrorMessage(caught));
    } finally {
      setReading(false);
    }
  }, []);

  async function pasteCode() {
    await inspect(await Clipboard.getStringAsync());
  }

  async function confirm() {
    if (!inspection || !rawPayload) return;
    cancelled.current = false;
    setElapsedMs(0);
    setBusy(true);
    setError('');
    dispatchProgress({ type: 'start' });
    try {
      const result = await pair(rawPayload, device);
      dispatchProgress({ type: 'core-stage', state: 'confirming' });
      await onPaired(result);
    } catch (caught) {
      // Cancelado pela pessoa: o código lido continua na tela para tentar de novo.
      if (!cancelled.current) setError(pairErrorMessage(caught));
      setBusy(false);
      dispatchProgress({ type: 'reading' });
    }
  }

  // Interrompe a tentativa no núcleo; a próxima chamada reabre o que for preciso.
  async function cancelPairing() {
    cancelled.current = true;
    try {
      await stopTunnel?.();
    } catch {
      // Sem núcleo para parar, a tela volta do mesmo jeito.
    }
    setBusy(false);
    dispatchProgress({ type: 'reading' });
  }

  function resetCode() {
    setInspection(null);
    setRawPayload('');
    dispatchProgress({ type: 'reading' });
  }

  if (inspection) {
    const percent = reservePercent(progress.tor);
    const slow = busy && progress.stage === 'reserve' && elapsedMs >= PAIR_SLOW_HINT_MS;
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <ScrollView contentContainerStyle={styles.confirmContent}>
          <Text accessibilityRole="header" style={[typography.largeTitle, { color: colors.text }]}>
            {t('mobile.pair.confirmTitle', { name: inspection.desktop.name })}
          </Text>
          {inspection.known ? (
            <View style={styles.known}>
              <StatusBadge label={t('mobile.pair.known')} tone="primary" variant="pill" />
              <Text style={[typography.callout, { color: colors.textSecondary }]}>{t('mobile.pair.knownDetail')}</Text>
            </View>
          ) : null}
          <Card style={styles.card}>
            <Text style={[typography.footnote, styles.label, { color: colors.textSecondary }]}>{t('mobile.pair.fingerprint')}</Text>
            <Text selectable style={[styles.fingerprint, { color: colors.text }]}>
              {formatFingerprint(inspection.desktop.fingerprint)}
            </Text>
            <Text style={[typography.footnote, { color: colors.textTertiary }]}>{t('mobile.pair.fingerprintHint')}</Text>
            {inspection.approvalCode ? (
              <View style={styles.approval}>
                <Text style={[typography.footnote, styles.label, { color: colors.textSecondary }]}>{t('mobile.pair.approvalCode')}</Text>
                <Text selectable accessibilityLabel={t('mobile.pair.approvalCode')} style={[styles.approvalCode, { color: colors.text }]}>
                  {inspection.approvalCode}
                </Text>
                <Text style={[typography.footnote, { color: colors.textTertiary }]}>{t('mobile.pair.approvalHint')}</Text>
              </View>
            ) : null}
          </Card>
          {busy ? (
            <View accessibilityLiveRegion="polite">
              <Card style={styles.card}>
                {PAIR_STAGES.map(stage => {
                  const status = stageStatus(progress, stage);
                  return (
                    <View key={stage} style={styles.stage}>
                      <View style={styles.stageIndicator}>
                        {status === 'current' ? <ActivityIndicator color={colors.primary} size="small" />
                          : <View style={[styles.stageDot, { backgroundColor: status === 'done' ? colors.success : colors.border }]} />}
                      </View>
                      <View style={styles.stageText}>
                        <Text style={[typography.body, {
                          color: status === 'pending' ? colors.textTertiary : status === 'current' ? colors.text : colors.textSecondary,
                          fontWeight: status === 'current' ? '600' : '400'
                        }]}>{t(STAGE_KEYS[stage])}</Text>
                        {stage === 'reserve' && status === 'current' && percent !== null ? (
                          <Text style={[typography.footnote, { color: colors.textSecondary }]}>
                            {t('mobile.reserve.progress', { progress: percent })}
                          </Text>
                        ) : null}
                        {stage === 'reserve' && status === 'current' && slow ? (
                          <Text style={[typography.footnote, { color: colors.textSecondary }]}>
                            {t('mobile.pair.elapsed', { seconds: Math.floor(elapsedMs / 1000) })}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
                {slow ? <Text style={[typography.footnote, styles.slowHint, { color: colors.textSecondary }]}>{t('mobile.pair.slowHint')}</Text> : null}
              </Card>
            </View>
          ) : (
            <PrimaryButton label={t('mobile.pair.confirm')} onPress={() => void confirm()} size="lg" style={styles.primary} />
          )}
          {busy
            ? <SecondaryButton label={t('mobile.pair.cancel')} onPress={() => void cancelPairing()} variant="link-danger" />
            : <SecondaryButton label={t('mobile.pair.anotherCode')} onPress={resetCode} variant="link" />}
          {error ? <Text accessibilityRole="alert" style={[typography.callout, styles.error, { color: colors.danger }]}>{error}</Text> : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <View style={[styles.safeArea, { backgroundColor: colors.background }]}>
      {permission?.granted ? (
        <CameraView
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={reading ? undefined : event => void inspect(event.data)}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <SafeAreaView style={styles.safeArea}>
        {/* Rola quando o cartão não cabe: na horizontal ou com fonte grande. */}
        <ScrollView bounces={false} contentContainerStyle={styles.cameraOverlay}>
          {onCancel ? (
            <Pressable accessibilityRole="button" onPress={onCancel}
              style={({ pressed }) => [styles.cancel, { backgroundColor: colors.overlay }, pressed && styles.pressed]}>
              <Icon color={colors.primary} name="chevron-left" size={20} />
              <Text style={[typography.headline, { color: colors.primary }]}>{t('mobile.pair.back')}</Text>
            </Pressable>
          ) : null}
          <View style={[styles.instructions, { backgroundColor: colors.overlay }]}>
            <Text accessibilityRole="header" style={[typography.largeTitle, { color: colors.text }]}>{t('mobile.pair.title')}</Text>
            <Text style={[typography.body, { color: colors.textSecondary }]}>{t('mobile.pair.instruction')}</Text>
            {notice ? <Text accessibilityRole="alert" style={[typography.callout, styles.strong, { color: colors.text }]}>{notice}</Text> : null}
            {reading ? (
              <View style={styles.reading}>
                <ActivityIndicator color={colors.primary} size="small" />
                <Text style={[typography.callout, { color: colors.textSecondary }]}>{t('mobile.pair.stage.reading')}</Text>
              </View>
            ) : null}
            {!permission?.granted ? (
              <>
                <Text style={[typography.callout, { color: colors.textSecondary }]}>{t('mobile.pair.cameraUse')}</Text>
                <PrimaryButton icon="qr-code" label={t('mobile.pair.allowCamera')} onPress={() => void requestPermission()} size="lg" />
              </>
            ) : null}
            <SecondaryButton disabled={reading} label={t('mobile.pair.pasteCode')} onPress={() => void pasteCode()} variant="link" />
            {error ? <Text accessibilityRole="alert" style={[typography.callout, styles.error, { color: colors.danger }]}>{error}</Text> : null}
          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  cameraOverlay: { flexGrow: 1, justifyContent: 'flex-end', padding: space.lg, gap: space.md },
  cancel: { alignSelf: 'flex-start', marginBottom: 'auto', minHeight: TOUCH_TARGET, flexDirection: 'row', alignItems: 'center', gap: 2,
    borderRadius: radius.control, paddingLeft: space.xs, paddingRight: space.md },
  pressed: { opacity: 0.7 },
  instructions: { borderRadius: radius.xl, padding: space.lg, gap: space.xs },
  strong: { fontWeight: '600', marginTop: space.xxs },
  reading: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xxs },
  confirmContent: { flexGrow: 1, justifyContent: 'center', padding: space.xl, gap: space.xs },
  known: { marginTop: space.xs, gap: space.xs, alignItems: 'flex-start' },
  card: { marginTop: space.md, gap: space.xxs },
  label: { fontWeight: '600' },
  approval: { marginTop: space.sm, gap: space.xxs },
  approvalCode: { ...typography.largeTitle, fontVariant: ['tabular-nums'], letterSpacing: 6, fontWeight: '600' },
  fingerprint: {
    fontSize: 22, lineHeight: 30, letterSpacing: 1, fontVariant: ['tabular-nums'],
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' })
  },
  stage: { flexDirection: 'row', alignItems: 'flex-start', minHeight: 36, paddingVertical: space.xxs },
  stageIndicator: { width: 28, height: 24, alignItems: 'center', justifyContent: 'center' },
  stageDot: { width: 8, height: 8, borderRadius: 4 },
  stageText: { flex: 1, marginLeft: space.xs },
  slowHint: { marginTop: space.xs },
  primary: { marginTop: space.lg },
  error: { textAlign: 'center', marginTop: space.xs }
});
