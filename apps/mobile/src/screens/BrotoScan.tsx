import { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';

import { isBrotoQrPayload } from '../bridge/messages';
import { useI18n } from '../i18n';
import { useTokens } from '../theme';
import { Icon, PrimaryButton, TOUCH_TARGET, radius, space, typography } from '../ui';
import { QR_SCANNER_SETTINGS } from './Pair';

type Props = {
  visible: boolean;
  // Computador que vai controlar o Broto, o mesmo do menu em que a pessoa tocou.
  desktopName: string;
  onCancel: () => void;
  onScanned: (payload: string) => void;
};

// Ligar um Broto: a câmera lê o QR que a janela do Broto mostra em Ligar pelo
// celular. Só o texto de um Broto segue para a página do computador; outro QR
// vira aviso, sem fechar a câmera. A câmera e a permissão são as do pareamento.
// A leitura monta a cada abertura, então começa sem aviso e sem QR aceito.
export function BrotoScan({ visible, desktopName, onCancel, onScanned }: Props) {
  const { colors } = useTokens();
  return (
    <Modal animationType="slide" onRequestClose={onCancel} presentationStyle="fullScreen" statusBarTranslucent visible={visible}>
      <View style={[styles.fill, { backgroundColor: colors.background }]}>
        {visible ? <Reader desktopName={desktopName} onCancel={onCancel} onScanned={onScanned} /> : null}
      </View>
    </Modal>
  );
}

function Reader({ desktopName, onCancel, onScanned }: Omit<Props, 'visible'>) {
  const { colors } = useTokens();
  const { t } = useI18n();
  const [permission, requestPermission] = useCameraPermissions();
  const [wrong, setWrong] = useState(false);
  // A câmera repete a leitura enquanto o QR fica na frente dela.
  const taken = useRef(false);

  const scanned = (data: string) => {
    if (taken.current) return;
    const payload = data.trim();
    if (!isBrotoQrPayload(payload)) {
      setWrong(true);
      return;
    }
    taken.current = true;
    onScanned(payload);
  };

  return (
    <>
      {permission?.granted ? (
        <CameraView barcodeScannerSettings={QR_SCANNER_SETTINGS} onBarcodeScanned={event => scanned(event.data)}
          style={StyleSheet.absoluteFill} />
      ) : null}
      <SafeAreaView style={styles.fill}>
        {/* Rola quando o cartão não cabe: na horizontal ou com fonte grande. */}
        <ScrollView bounces={false} contentContainerStyle={styles.overlay}>
          <Pressable accessibilityRole="button" onPress={onCancel}
            style={({ pressed }) => [styles.cancel, { backgroundColor: colors.overlay }, pressed && styles.pressed]}>
            <Icon color={colors.primary} name="x" size={20} />
            <Text style={[typography.headline, { color: colors.primary }]}>{t('mobile.common.cancel')}</Text>
          </Pressable>
          <View style={[styles.instructions, { backgroundColor: colors.overlay }]}>
            <Text accessibilityRole="header" style={[typography.largeTitle, { color: colors.text }]}>{t('mobile.brotoScan.title')}</Text>
            <Text style={[typography.body, { color: colors.textSecondary }]}>{t('mobile.brotoScan.instruction')}</Text>
            <Text style={[typography.callout, styles.strong, { color: colors.text }]}>{t('mobile.brotoScan.computer', { name: desktopName })}</Text>
            {!permission?.granted ? (
              <>
                <Text style={[typography.callout, { color: colors.textSecondary }]}>{t('mobile.pair.cameraUse')}</Text>
                <PrimaryButton icon="qr-code" label={t('mobile.pair.allowCamera')} onPress={() => void requestPermission()} size="lg" />
              </>
            ) : null}
            {wrong ? (
              <Text accessibilityRole="alert" style={[typography.callout, styles.error, { color: colors.danger }]}>{t('mobile.brotoScan.notBroto')}</Text>
            ) : null}
          </View>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  overlay: { flexGrow: 1, justifyContent: 'flex-end', padding: space.lg, gap: space.md },
  cancel: { alignSelf: 'flex-start', marginBottom: 'auto', minHeight: TOUCH_TARGET, flexDirection: 'row', alignItems: 'center', gap: space.xxs,
    borderRadius: radius.control, paddingLeft: space.sm, paddingRight: space.md },
  pressed: { opacity: 0.7 },
  instructions: { borderRadius: radius.xl, padding: space.lg, gap: space.xs },
  strong: { fontWeight: '600', marginTop: space.xxs },
  error: { marginTop: space.xs }
});
