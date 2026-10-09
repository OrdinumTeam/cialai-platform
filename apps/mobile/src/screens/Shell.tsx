import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
import { WebView } from 'react-native-webview';
import type { WebViewErrorEvent } from 'react-native-webview/lib/WebViewTypes';

import type { Transport } from 'cialai-tunnel';

import type { BiometricSession } from '../auth/biometrics';
import { pageMessageScript, parsePageMessage, shellMessageScript, type DashboardMessage, type ShellIntent, type ShellMessage } from '../bridge/messages';
import { shareDownload } from '../bridge/share-download';
import { controlOriginWhitelist, isSafeExternalUrl, isSameControlOrigin } from '../config/url';
import { localizeSensitiveReason, useI18n } from '../i18n';
import { checkControlHealth, HEALTH_FAILURE_STRIKES, HEALTH_POLL_INTERVAL_MS } from '../network/health';
import { logApp } from '../state/diagnostics';
import type { DesktopConnectionState } from '../state/machine';
import { useThemeMode, useTokens } from '../theme';
import { ActionList, BottomSheet, ChoiceRow, Icon, IconButton, StatusBadge, radius, space, typography } from '../ui';
import { STATE_KEYS, STATE_TONES } from './Desktops';
import { TRANSPORT_DESCRIPTION_KEYS, TRANSPORT_KEYS, useTransportColor } from './TransportBadge';

// Um computador vinculado, como o seletor da barra o mostra.
export type ShellDesktop = { id: string; name: string; state: DesktopConnectionState; transport: Transport | null };

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
  // Pedido feito no Início, entregue à página no carregamento.
  intent?: ShellIntent | null;
  // Retrato que a página manda para o Início.
  onDashboard?: (snapshot: DashboardMessage) => void;
  // Pasta escolhida na página para virar atalho em Projetos.
  onProjectPicked?: (path: string) => void;
  // Computadores do seletor da barra; escolher outro abre as sessões dele.
  desktops?: readonly ShellDesktop[];
  onSwitchDesktop?: (desktopId: string) => void;
  onDesktops?: () => void;
};

export function Shell({
  url, desktopId, desktopName, version, biometricSession, lockSignal, transport, reconnecting,
  onConnectionLost, onConnectionRestored, onHome, intent = null, onDashboard, onProjectPicked, desktops = [], onSwitchDesktop, onDesktops
}: Props) {
  const { colors } = useTokens();
  const [picker, setPicker] = useState(false);
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
    if (message.type === 'dashboard') {
      onDashboard?.(message);
      return;
    }
    if (message.type === 'project-picked') {
      onProjectPicked?.(message.path);
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
  }, [biometricSession, emitShellState, inject, onDashboard, onHome, onProjectPicked, openExternal, t, url]);

  const bootstrapScript = useMemo(() =>
    `window.__CIALAI_SHELL__ = ${JSON.stringify({
      platform: Platform.OS === 'android' ? 'android' : 'ios', version, desktopId, desktopName, locale, theme: themeMode,
      ...(intent ? { intent } : {})
    }).replace(/</g, '\\u003c')}; true;`, [desktopId, desktopName, intent, locale, themeMode, version]);

  return (
    <View style={[styles.root, { backgroundColor: colors.surface }]}>
      <SafeAreaView edges={['top', 'left', 'right']} style={{ backgroundColor: colors.surface }}>
        <View style={[styles.toolbar, { borderBottomColor: colors.border }]}>
          <IconButton accessibilityLabel={t('mobile.home.open')} icon="chevron-left" onPress={onHome} variant="header" />
          <Pressable accessibilityLabel={t('mobile.shell.switchDesktop', { name: desktopName })} accessibilityRole="button"
            onPress={() => setPicker(true)}
            style={({ pressed }) => [styles.selector, { backgroundColor: pressed ? colors.surfacePressed : colors.surfaceMuted }]}>
            <Icon color={colors.textSecondary} name="laptop" size={18} />
            <View style={[styles.connectedDot, { backgroundColor: reconnecting ? colors.warning : transportColor(transport) }]} />
            <Text numberOfLines={1} style={[typography.headline, styles.toolbarTitle, { color: colors.text }]}>{desktopName}</Text>
            <View style={[styles.transportBadge, { backgroundColor: colors.surface }]}>
              <Text accessibilityLabel={t(transport ? TRANSPORT_DESCRIPTION_KEYS[transport] : 'mobile.transport.searching')}
                numberOfLines={1} style={[typography.caption, styles.transportText, { color: colors.textSecondary }]}>
                {t(transport ? TRANSPORT_KEYS[transport] : 'mobile.transport.searching')}
              </Text>
            </View>
            <Icon color={colors.textSecondary} name="chevron-down" size={18} />
          </Pressable>
        </View>
        {reconnecting ? (
          <View accessibilityLiveRegion="polite" style={[styles.banner, { backgroundColor: colors.warningSoft, borderBottomColor: colors.border }]}>
            <ActivityIndicator color={colors.warning} size="small" />
            <View style={styles.bannerText}>
              <Text style={[typography.callout, styles.bannerTitle, { color: colors.text }]}>{t('mobile.shell.reconnecting.title')}</Text>
              <Text style={[typography.footnote, { color: colors.textSecondary }]}>{t('mobile.shell.reconnecting.detail')}</Text>
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
      <BottomSheet onClose={() => setPicker(false)} title={t('mobile.desktops.title')} visible={picker}>
        {desktops.map(desktop => {
          const current = desktop.id === desktopId;
          return (
            <ChoiceRow disabled={current} icon="laptop" key={desktop.id} onPress={() => { setPicker(false); onSwitchDesktop?.(desktop.id); }}
              selected={current} title={desktop.name}
              detail={(
                <View style={styles.desktopBadges}>
                  <StatusBadge label={t(STATE_KEYS[desktop.state])} tone={STATE_TONES[desktop.state]} />
                  {desktop.transport === 'tor' ? (
                    <StatusBadge accessibilityLabel={t(TRANSPORT_DESCRIPTION_KEYS.tor)} label={t(TRANSPORT_KEYS.tor)} tone="warning" variant="pill" />
                  ) : null}
                </View>
              )}
              trailing={current ? <Text style={[typography.footnote, styles.current, { color: colors.primary }]}>{t('mobile.shell.current')}</Text> : null} />
          );
        })}
        {onDesktops ? (
          <ActionList groups={[[{ key: 'manage', icon: 'monitor', label: t('mobile.shell.allDesktops'), onPress: () => { setPicker(false); onDesktops(); } }]]} />
        ) : null}
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  webView: { flex: 1, backgroundColor: 'transparent' },
  toolbar: { minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.md, paddingVertical: 6 },
  selector: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space.xs, borderRadius: radius.md, paddingHorizontal: space.sm },
  desktopBadges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.xs },
  current: { fontWeight: '600' },
  // O nome encolhe primeiro; o chip encolhe depois, para um texto traduzido longo não esconder o nome.
  transportBadge: { flexShrink: 1, maxWidth: '40%', borderRadius: radius.pill, paddingHorizontal: space.xs, paddingVertical: 3 },
  transportText: { fontWeight: '600' },
  toolbarTitle: { flexShrink: 2 },
  connectedDot: { width: 10, height: 10, borderRadius: 5 },
  banner: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md, paddingVertical: space.xs },
  bannerText: { flex: 1, gap: 2 },
  bannerTitle: { fontWeight: '600' }
});
