import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { OfflineReason } from '../state/machine';
import { RequestGate } from '../network/request-gate';
import { usePalette } from '../theme';

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000] as const;

const reasonText: Record<OfflineReason, { title: string; detail: string }> = {
  tunnel: { title: 'A rede segura está indisponível', detail: 'Confira sua conexão e tente novamente.' },
  desktop: { title: 'O computador está fora de alcance', detail: 'Deixe o Cialai aberto no computador.' },
  server: { title: 'O servidor está indisponível', detail: 'Conexões existentes podem continuar. Novas conexões precisam do servidor.' },
  reconnecting: { title: 'Reconectando', detail: 'Restaurando a conexão segura com o computador.' },
  removed: { title: 'Este celular foi removido', detail: 'Vincule novamente para acessar este computador.' }
};

type Props = {
  reason: OfflineReason;
  onRetry: () => Promise<boolean>;
  onDesktops: () => void;
};

export function Offline({ reason, onRetry, onDesktops }: Props) {
  const palette = usePalette();
  const [checking, setChecking] = useState(false);
  const [gate] = useState(() => new RequestGate());
  const attempt = useRef(0);
  const leaving = useRef(false);

  async function retry() {
    const epoch = gate.begin();
    setChecking(true);
    const healthy = await onRetry();
    if (!leaving.current && gate.isCurrent(epoch)) setChecking(false);
    return healthy;
  }

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const delay = RETRY_DELAYS_MS[Math.min(attempt.current, RETRY_DELAYS_MS.length - 1)]!;
      attempt.current += 1;
      timer = setTimeout(async () => {
        if (cancelled || leaving.current) return;
        if (!(await onRetry())) schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [onRetry]);

  useEffect(() => () => gate.invalidate(), [gate]);
  const copy = reasonText[reason];

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: palette.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.status, { backgroundColor: palette.surface, borderColor: palette.separator }]}>
          <View style={[styles.statusDot, { backgroundColor: palette.danger }]} />
          <Text style={[styles.statusText, { color: palette.secondaryLabel }]}>Sem conexão</Text>
        </View>
        <Text accessibilityRole="header" style={[styles.title, { color: palette.label }]}>{copy.title}</Text>
        <Text style={[styles.body, { color: palette.secondaryLabel }]}>{copy.detail}</Text>
        <Pressable accessibilityRole="button" disabled={checking} onPress={() => void retry()}
          style={({ pressed }) => [styles.primary, { backgroundColor: pressed ? palette.accentPressed : palette.accent }, checking && styles.disabled]}>
          {checking ? <ActivityIndicator color={palette.accentText} />
            : <Text style={[styles.primaryText, { color: palette.accentText }]}>Tentar agora</Text>}
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => {
          leaving.current = true;
          gate.invalidate();
          onDesktops();
        }} style={styles.secondary}>
          <Text style={[styles.secondaryText, { color: palette.accent }]}>Trocar de computador</Text>
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
  primary: { minHeight: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', marginTop: 32 },
  primaryText: { fontSize: 17, fontWeight: '600' },
  secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  secondaryText: { fontSize: 17, fontWeight: '600' },
  disabled: { opacity: 0.62 }
});
