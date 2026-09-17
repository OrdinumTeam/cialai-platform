import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ActivityIndicator, Alert, BackHandler, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
import { WebView } from 'react-native-webview';
import type { WebViewErrorEvent } from 'react-native-webview/lib/WebViewTypes';

import type { Transport } from 'cialai-tunnel';

import type { BiometricSession } from '../auth/biometrics';
import { pageMessageScript, parsePageMessage, shellMessageScript, type ShellMessage } from '../bridge/messages';
import { shareDownload } from '../bridge/share-download';
import { controlOriginWhitelist, isSafeExternalUrl, isSameControlOrigin } from '../config/url';
import { localizeSensitiveReason, useI18n } from '../i18n';
import { checkControlHealth, HEALTH_FAILURE_STRIKES, HEALTH_POLL_INTERVAL_MS } from '../network/health';
import { logApp } from '../state/diagnostics';
import { usePalette, useThemeMode } from '../theme';
import { TRANSPORT_DESCRIPTION_KEYS, TRANSPORT_KEYS, useTransportColor } from './TransportBadge';

type Props = {
  url: string;
  desktopId: string;
  desktopName: string;
  version: string;
  biometricSession: BiometricSession;
  lockSignal: number;
  // Transporte do caminho ativo; nulo enquanto o núcleo procura outro caminho.
  transport: Transport | null;
  // Faixa nativa acima da página enquanto o caminho volta; o WebView fica montado.
  reconnecting: boolean;
  onConnectionLost: () => void;
  onConnectionRestored: () => void;
  // Volta ao início; a conexão fica aberta por um prazo para a volta ser barata.
  onHome: () => void;
};

export function Shell({
  url, desktopId, desktopName, version, biometricSession, lockSignal, transport, reconnecting,
  onConnectionLost, onConnectionRestored, onHome
}: Props) {
  const palette = usePalette();
  const themeMode = useThemeMode();
  const transportColor = useTransportColor();
  const { locale, t } = useI18n();
  const webView = useRef<WebView>(null);
  const loaded = useRef(false);
  const unlocked = useRef(false);
  const downloadBusy = useRef(false);
  // Falhas seguidas da sondagem e do carregamento da página, zeradas por uma resposta boa.
  const failures = useRef(0);
  const originWhitelist = useMemo(() => controlOriginWhitelist(url), [url]);
  // A mesma URL rende o mesmo objeto: a página não recarrega quando o proxy é reaproveitado.
  const source = useMemo(() => ({ uri: url }), [url]);

  const inject = useCallback((script: string) => {
    if (loaded.current) webView.current?.injectJavaScript(script);
  }, []);
  const emitShellState = useCallback((nextUnlocked: boolean) => {
    unlocked.current = nextUnlocked;
    const message: ShellMessage = {
      type: 'shell',
      platform: Platform.OS === 'android' ? 'android' : 'ios',
      version,
      desktopId,
      unlocked: nextUnlocked,
      theme: themeMode
    };
    inject(shellMessageScript(message));
  }, [desktopId, inject, themeMode, version]);

  useEffect(() => {
    if (lockSignal > 0) emitShellState(false);
  }, [emitShellState, lockSignal]);

  // A aparência muda nos ajustes: a página recebe a escolha sem recarregar.
  useEffect(() => {
    if (loaded.current) emitShellState(unlocked.current);
  }, [emitShellState, themeMode]);

  // Duas falhas seguidas contam como conexão perdida; uma só pode ser a reserva
  // demorando. Uma resposta boa zera a contagem e avisa que a página respondeu.
  // Depois de avisar, a sondagem continua: o app pode confirmar com o núcleo e
  // manter a página, e um aviso seguinte precisa do mesmo par de falhas.
  const strike = useCallback(() => {
    failures.current += 1;
    if (failures.current < HEALTH_FAILURE_STRIKES) return;
    failures.current = 0;
    onConnectionLost();
  }, [onConnectionLost]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    failures.current = 0;
    const probe = async () => {
      if (cancelled) return;
      const healthy = await checkControlHealth(url);
      if (cancelled) return;
      if (healthy) {
        failures.current = 0;
        onConnectionRestored();
      } else {
        strike();
      }
      if (cancelled) return;
      timer = setTimeout(() => void probe(), HEALTH_POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void probe(), HEALTH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [onConnectionRestored, strike, url]);

  // Erro de carregamento conta como uma falha, não como perda: a próxima sondagem decide.
  const handleError = useCallback((event: WebViewErrorEvent) => {
    const { code, description } = event.nativeEvent;
    logApp('info', `webview load error ${String(code)}: ${String(description ?? '')}`.trim());
    strike();
  }, [strike]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      webView.current?.injectJavaScript(pageMessageScript({ type: 'navigate-back' }));
      return true;
    });
    return () => subscription.remove();
  }, []);

  const openExternal = useCallback(async (externalUrl: string) => {
    if (!isSafeExternalUrl(externalUrl)) return;
    try {
      await Linking.openURL(externalUrl);
    } catch {
      Alert.alert(t('mobile.alert.openLink.title'), t('mobile.alert.openLink.detail'));
    }
  }, [t]);

  const allowNavigation = useCallback((request: WebViewNavigation) => {
    if (isSameControlOrigin(url, request.url)) return true;
    void openExternal(request.url);
    return false;
  }, [openExternal, url]);

  const handleMessage = useCallback(async (event: WebViewMessageEvent) => {
    if (!isSameControlOrigin(url, event.nativeEvent.url)) return;
    const message = parsePageMessage(event.nativeEvent.data, __DEV__);
    if (!message) return;
    if (message.type === 'auth') {
      const ok = await biometricSession.authorize(message.level, localizeSensitiveReason(message.reason));
      inject(pageMessageScript({ type: 'auth', id: message.id, ok }));
      if (ok && message.level === 'session') emitShellState(true);
      return;
    }
    if (message.type === 'open-external') return void (await openExternal(message.url));
    if (message.type === 'navigate-back') {
      onHome();
      return;
    }
    if (downloadBusy.current) {
      Alert.alert(t('mobile.alert.downloadBusy.title'), t('mobile.alert.downloadBusy.detail'));
      return;
    }
    downloadBusy.current = true;
    try {
      await shareDownload(message, __DEV__);
    } catch (caught) {
      Alert.alert(t('mobile.alert.downloadFailed.title'), caught instanceof Error ? caught.message : t('mobile.alert.downloadFailed.detail'));
    } finally {
      downloadBusy.current = false;
    }
  }, [biometricSession, emitShellState, inject, onHome, openExternal, t, url]);

  const bootstrapScript = useMemo(() =>
    `window.__CIALAI_SHELL__ = ${JSON.stringify({
      platform: Platform.OS === 'android' ? 'android' : 'ios', version, desktopId, desktopName, locale, theme: themeMode
    })}; true;`, [desktopId, desktopName, locale, themeMode, version]);

  return (
    <View style={[styles.root, { backgroundColor: palette.surface }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: palette.surface }}>
        <View style={[styles.toolbar, { borderBottomColor: palette.separator }]}>
          <View style={styles.toolbarStatus}>
            <View style={[styles.connectedDot, { backgroundColor: reconnecting ? palette.warning : transportColor(transport) }]} />
            <Text numberOfLines={1} style={[styles.toolbarTitle, { color: palette.label }]}>{desktopName}</Text>
            <View style={[styles.transportBadge, { backgroundColor: palette.chip }]}>
              <Text accessibilityLabel={t(transport ? TRANSPORT_DESCRIPTION_KEYS[transport] : 'mobile.transport.searching')}
                numberOfLines={1} style={[styles.transportText, { color: palette.secondaryLabel }]}>
                {t(transport ? TRANSPORT_KEYS[transport] : 'mobile.transport.searching')}
              </Text>
            </View>
          </View>
          <Pressable accessibilityLabel={t('mobile.home.open')} accessibilityRole="button" onPress={onHome}
            style={({ pressed }) => [styles.homeButton, pressed && styles.pressed]}>
            <Text style={[styles.homeText, { color: palette.accent }]}>{t('mobile.home.back')}</Text>
          </Pressable>
        </View>
        {reconnecting ? (
          <View accessibilityLiveRegion="polite" style={[styles.banner, { backgroundColor: palette.chip, borderBottomColor: palette.separator }]}>
            <ActivityIndicator color={palette.warning} size="small" />
            <View style={styles.bannerText}>
              <Text style={[styles.bannerTitle, { color: palette.label }]}>{t('mobile.shell.reconnecting.title')}</Text>
              <Text style={[styles.bannerDetail, { color: palette.secondaryLabel }]}>{t('mobile.shell.reconnecting.detail')}</Text>
            </View>
          </View>
        ) : null}
      </SafeAreaView>
      <WebView
        ref={webView}
        allowsBackForwardNavigationGestures={false}
        allowsLinkPreview={false}
        contentInsetAdjustmentBehavior="never"
        domStorageEnabled
        injectedJavaScriptBeforeContentLoaded={bootstrapScript}
        javaScriptEnabled
        keyboardDisplayRequiresUserAction={false}
        onContentProcessDidTerminate={() => webView.current?.reload()}
        onError={handleError}
        onLoad={() => {
          loaded.current = true;
          biometricSession.lock();
          emitShellState(false);
        }}
        onMessage={event => void handleMessage(event)}
        onOpenWindow={event => void openExternal(event.nativeEvent.targetUrl)}
        onShouldStartLoadWithRequest={allowNavigation}
        originWhitelist={originWhitelist}
        overScrollMode="never"
        // Puxar para atualizar recarregava a página inteira a cada arrasto no
        // topo do terminal, e o conteúdo piscava. A página se restaura sozinha.
        pullToRefreshEnabled={false}
        sharedCookiesEnabled={false}
        source={source}
        style={styles.webView}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  webView: { flex: 1, backgroundColor: 'transparent' },
  toolbar: { minHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 16, paddingRight: 8 },
  toolbarStatus: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  transportBadge: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  transportText: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
  toolbarTitle: { flexShrink: 1, fontSize: 17, lineHeight: 22, fontWeight: '600' },
  homeButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  homeText: { fontSize: 17, lineHeight: 22, fontWeight: '500' },
  pressed: { opacity: 0.55 },
  connectedDot: { width: 8, height: 8, borderRadius: 4 },
  banner: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingVertical: 8 },
  bannerText: { flex: 1, gap: 2 },
  bannerTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  bannerDetail: { fontSize: 13, lineHeight: 18 }
});
