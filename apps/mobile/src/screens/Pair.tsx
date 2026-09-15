import { useCallback, useEffect, useReducer, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  addListener as addTunnelListener,
  inspectPairPayload,
  pair,
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
import { usePalette } from '../theme';
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

export function Pair({ initialError, notice, device, onPaired, onCancel }: Props) {
  const palette = usePalette();
  const { t } = useI18n();
  const [permission, requestPermission] = useCameraPermissions();
  const [inspection, setInspection] = useState<PairInspection | null>(null);
  const [rawPayload, setRawPayload] = useState('');
  const [error, setError] = useState(initialError ?? '');
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, dispatchProgress] = useReducer(advancePairProgress, undefined, initialPairProgress);

  // Enquanto o pareamento corre, os eventos do núcleo e o relógio avançam a etapa exibida.
  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    const timer = setInterval(() => dispatchProgress({ type: 'elapsed', ms: Date.now() - startedAt }), STAGE_TICK_MS);
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
    setBusy(true);
    setError('');
    dispatchProgress({ type: 'start' });
    try {
      const result = await pair(rawPayload, device);
      dispatchProgress({ type: 'core-stage', state: 'confirming' });
      await onPaired(result);
    } catch (caught) {
      setError(pairErrorMessage(caught));
      setBusy(false);
    }
  }

  function resetCode() {
    setInspection(null);
    setRawPayload('');
    dispatchProgress({ type: 'reading' });
  }

  if (inspection) {
    const percent = reservePercent(progress.tor);
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: palette.background }]}>
        <ScrollView contentContainerStyle={styles.confirmContent}>
          <Text accessibilityRole="header" style={[styles.title, { color: palette.label }]}>
            {t('mobile.pair.confirmTitle', { name: inspection.desktop.name })}
          </Text>
          {inspection.known ? (
            <View style={styles.known}>
              <View style={[styles.chip, { backgroundColor: palette.surface, borderColor: palette.separator }]}>
                <Text style={[styles.chipText, { color: palette.secondaryLabel }]}>{t('mobile.pair.known')}</Text>
              </View>
              <Text style={[styles.knownDetail, { color: palette.secondaryLabel }]}>{t('mobile.pair.knownDetail')}</Text>
            </View>
          ) : null}
          <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.separator }]}>
            <Text style={[styles.label, { color: palette.secondaryLabel }]}>{t('mobile.pair.fingerprint')}</Text>
            <Text selectable style={[styles.fingerprint, { color: palette.label }]}>
              {formatFingerprint(inspection.desktop.fingerprint)}
            </Text>
            <Text style={[styles.hint, { color: palette.tertiaryLabel }]}>{t('mobile.pair.fingerprintHint')}</Text>
          </View>
          {busy ? (
            <View accessibilityLiveRegion="polite" style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.separator }]}>
              {PAIR_STAGES.map(stage => {
                const status = stageStatus(progress, stage);
                return (
                  <View key={stage} style={styles.stage}>
                    <View style={styles.stageIndicator}>
                      {status === 'current' ? <ActivityIndicator color={palette.accent} size="small" />
                        : <View style={[styles.stageDot, { backgroundColor: status === 'done' ? palette.success : palette.separator }]} />}
                    </View>
                    <View style={styles.stageText}>
                      <Text style={[styles.stageLabel, {
                        color: status === 'pending' ? palette.tertiaryLabel : status === 'current' ? palette.label : palette.secondaryLabel,
                        fontWeight: status === 'current' ? '600' : '400'
                      }]}>{t(STAGE_KEYS[stage])}</Text>
                      {stage === 'reserve' && status === 'current' && percent !== null ? (
                        <Text style={[styles.stageDetail, { color: palette.secondaryLabel }]}>
                          {t('mobile.reserve.progress', { progress: percent })}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </View>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => void confirm()}
              style={({ pressed }) => [styles.primary, { backgroundColor: pressed ? palette.accentPressed : palette.accent }]}>
              <Text style={[styles.primaryText, { color: palette.accentText }]}>{t('mobile.pair.confirm')}</Text>
            </Pressable>
          )}
          <Pressable accessibilityRole="button" disabled={busy} onPress={resetCode} style={[styles.secondary, busy && styles.disabled]}>
            <Text style={[styles.secondaryText, { color: palette.accent }]}>{t('mobile.pair.anotherCode')}</Text>
          </Pressable>
          {error ? <Text accessibilityRole="alert" style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <View style={[styles.safeArea, { backgroundColor: palette.background }]}>
      {permission?.granted ? (
        <CameraView
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={reading ? undefined : event => void inspect(event.data)}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <SafeAreaView style={styles.cameraOverlay}>
        {onCancel ? (
          <Pressable accessibilityRole="button" onPress={onCancel}
            style={[styles.cancel, { backgroundColor: palette.overlay }]}>
            <Text style={[styles.cancelText, { color: palette.accent }]}>{t('mobile.pair.back')}</Text>
          </Pressable>
        ) : null}
        <View style={[styles.instructions, { backgroundColor: palette.overlay }]}>
          <Text accessibilityRole="header" style={[styles.cameraTitle, { color: palette.label }]}>{t('mobile.pair.title')}</Text>
          <Text style={[styles.body, { color: palette.secondaryLabel }]}>{t('mobile.pair.instruction')}</Text>
          {notice ? <Text accessibilityRole="alert" style={[styles.notice, { color: palette.label }]}>{notice}</Text> : null}
          {reading ? (
            <View style={styles.reading}>
              <ActivityIndicator color={palette.accent} size="small" />
              <Text style={[styles.readingText, { color: palette.secondaryLabel }]}>{t('mobile.pair.stage.reading')}</Text>
            </View>
          ) : null}
          {!permission?.granted ? (
            <>
              <Text style={[styles.permissionText, { color: palette.secondaryLabel }]}>{t('mobile.pair.cameraUse')}</Text>
              <Pressable accessibilityRole="button" onPress={() => void requestPermission()}
                style={({ pressed }) => [styles.primary, { backgroundColor: pressed ? palette.accentPressed : palette.accent }]}>
                <Text style={[styles.primaryText, { color: palette.accentText }]}>{t('mobile.pair.allowCamera')}</Text>
              </Pressable>
            </>
          ) : null}
          <Pressable accessibilityRole="button" disabled={reading} onPress={() => void pasteCode()} style={styles.secondary}>
            <Text style={[styles.secondaryText, { color: palette.accent }]}>{t('mobile.pair.pasteCode')}</Text>
          </Pressable>
          {error ? <Text accessibilityRole="alert" style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  cameraOverlay: { flex: 1, justifyContent: 'flex-end', padding: 20 },
  cancel: { alignSelf: 'flex-start', marginBottom: 'auto', minHeight: 44, justifyContent: 'center', borderRadius: 22, paddingHorizontal: 16 },
  cancelText: { fontSize: 16, fontWeight: '600' },
  instructions: { borderRadius: 24, padding: 22 },
  cameraTitle: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  body: { marginTop: 8, fontSize: 17, lineHeight: 24 },
  notice: { marginTop: 14, fontSize: 15, lineHeight: 21, fontWeight: '600' },
  reading: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  readingText: { fontSize: 15 },
  permissionText: { marginTop: 14, fontSize: 15, lineHeight: 21 },
  confirmContent: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  known: { marginTop: 14, gap: 8 },
  chip: { alignSelf: 'flex-start', borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  chipText: { fontSize: 13, fontWeight: '600' },
  knownDetail: { fontSize: 15, lineHeight: 21 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 18, marginTop: 20 },
  label: { fontSize: 13, fontWeight: '600' },
  fingerprint: {
    marginTop: 6, fontSize: 22, lineHeight: 30, letterSpacing: 1, fontVariant: ['tabular-nums'],
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' })
  },
  hint: { marginTop: 8, fontSize: 14, lineHeight: 20 },
  stage: { flexDirection: 'row', alignItems: 'flex-start', minHeight: 36, paddingVertical: 4 },
  stageIndicator: { width: 28, height: 24, alignItems: 'center', justifyContent: 'center' },
  stageDot: { width: 8, height: 8, borderRadius: 4 },
  stageText: { flex: 1, marginLeft: 8 },
  stageLabel: { fontSize: 16, lineHeight: 24 },
  stageDetail: { fontSize: 14, lineHeight: 20 },
  primary: { minHeight: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', marginTop: 24 },
  primaryText: { fontSize: 17, fontWeight: '600' },
  secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  secondaryText: { fontSize: 17, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  error: { textAlign: 'center', marginTop: 12, fontSize: 15, lineHeight: 21 }
});
