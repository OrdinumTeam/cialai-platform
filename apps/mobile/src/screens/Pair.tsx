import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';

import { inspectPairPayload, pair, type PairInspection, type PairResult } from 'cialai-tunnel';

import { usePalette } from '../theme';
import { pairErrorMessage } from './pair-errors';

type Props = {
  initialError?: string;
  device: { name: string; model: string; platform: 'ios' | 'android'; app: string };
  onPaired: (inspection: PairInspection, result: PairResult) => Promise<void>;
};

export function Pair({ initialError, device, onPaired }: Props) {
  const palette = usePalette();
  const [permission, requestPermission] = useCameraPermissions();
  const [inspection, setInspection] = useState<PairInspection | null>(null);
  const [rawPayload, setRawPayload] = useState('');
  const [error, setError] = useState(initialError ?? '');
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);

  const inspect = useCallback(async (payload: string) => {
    if (!payload.trim()) return;
    setScanned(true);
    setError('');
    try {
      const value = await inspectPairPayload(payload.trim());
      setRawPayload(payload.trim());
      setInspection(value);
    } catch (caught) {
      setError(pairErrorMessage(caught));
      setScanned(false);
    }
  }, []);

  async function pasteCode() {
    await inspect(await Clipboard.getStringAsync());
  }

  async function confirm() {
    if (!inspection || !rawPayload) return;
    setBusy(true);
    setError('');
    try {
      const result = await pair(rawPayload, device);
      await onPaired(inspection, result);
    } catch (caught) {
      setError(pairErrorMessage(caught));
      setBusy(false);
    }
  }

  if (inspection) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: palette.background }]}>
        <ScrollView contentContainerStyle={styles.confirmContent}>
          <Text accessibilityRole="header" style={[styles.title, { color: palette.label }]}>
            Vincular a {inspection.desktop.name}?
          </Text>
          <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.separator }]}>
            <Text style={[styles.label, { color: palette.secondaryLabel }]}>Servidor</Text>
            <Text selectable style={[styles.value, { color: palette.label }]}>{inspection.control}</Text>
            <Text style={[styles.label, { color: palette.secondaryLabel }]}>Usuário</Text>
            <Text style={[styles.value, { color: palette.label }]}>{inspection.userName}</Text>
          </View>
          {busy ? (
            <View style={styles.progress}>
              <ActivityIndicator color={palette.accent} />
              <Text style={[styles.progressText, { color: palette.secondaryLabel }]}>
                Entrando na rede e procurando o computador
              </Text>
            </View>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => void confirm()}
              style={({ pressed }) => [styles.primary, { backgroundColor: pressed ? palette.accentPressed : palette.accent }]}>
              <Text style={[styles.primaryText, { color: palette.accentText }]}>Vincular</Text>
            </Pressable>
          )}
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => {
            setInspection(null);
            setRawPayload('');
            setScanned(false);
          }} style={styles.secondary}>
            <Text style={[styles.secondaryText, { color: palette.accent }]}>Ler outro código</Text>
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
          onBarcodeScanned={scanned ? undefined : event => void inspect(event.data)}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <SafeAreaView style={styles.cameraOverlay}>
        <View style={[styles.instructions, { backgroundColor: palette.overlay }]}>
          <Text accessibilityRole="header" style={[styles.cameraTitle, { color: palette.label }]}>Vincular celular</Text>
          <Text style={[styles.body, { color: palette.secondaryLabel }]}>Abra Vincular celular no computador</Text>
          {!permission?.granted ? (
            <>
              <Text style={[styles.permissionText, { color: palette.secondaryLabel }]}>A câmera é usada somente para ler o código do Cialai.</Text>
              <Pressable accessibilityRole="button" onPress={() => void requestPermission()}
                style={({ pressed }) => [styles.primary, { backgroundColor: pressed ? palette.accentPressed : palette.accent }]}>
                <Text style={[styles.primaryText, { color: palette.accentText }]}>Permitir câmera</Text>
              </Pressable>
            </>
          ) : null}
          <Pressable accessibilityRole="button" onPress={() => void pasteCode()} style={styles.secondary}>
            <Text style={[styles.secondaryText, { color: palette.accent }]}>Colar código</Text>
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
  instructions: { borderRadius: 24, padding: 22 },
  cameraTitle: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  body: { marginTop: 8, fontSize: 17, lineHeight: 24 },
  permissionText: { marginTop: 14, fontSize: 15, lineHeight: 21 },
  confirmContent: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 18, marginTop: 24 },
  label: { fontSize: 13, fontWeight: '600', marginTop: 10 },
  value: { fontSize: 16, lineHeight: 22, marginTop: 3 },
  primary: { minHeight: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', marginTop: 24 },
  primaryText: { fontSize: 17, fontWeight: '600' },
  secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  secondaryText: { fontSize: 17, fontWeight: '600' },
  progress: { flexDirection: 'row', gap: 12, alignItems: 'center', justifyContent: 'center', marginTop: 28 },
  progressText: { fontSize: 15 },
  error: { textAlign: 'center', marginTop: 12, fontSize: 15, lineHeight: 21 }
});
