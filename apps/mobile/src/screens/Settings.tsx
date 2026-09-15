import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Locale } from '@cialai/i18n';

import type { LogLevel, TunnelStatus } from 'cialai-tunnel';

import { useI18n } from '../i18n';
import { THEME_MODES, usePalette, type ThemeMode } from '../theme';
import { PATH_KEYS, TOR_STATE_KEYS, TRANSPORT_KEYS } from './TransportBadge';

const LANGUAGE_OPTIONS: readonly { value: Locale; key: string }[] = [
  { value: 'pt-BR', key: 'language.portuguese' },
  { value: 'en', key: 'language.english' },
  { value: 'es', key: 'language.spanish' },
];

const CORE_STATE_KEYS: Readonly<Record<TunnelStatus['state'], string>> = {
  idle: 'mobile.settings.coreState.idle',
  connecting: 'mobile.settings.coreState.connecting',
  connected: 'mobile.settings.coreState.connected',
  offline: 'mobile.settings.coreState.offline'
};

// Redes públicas das quais a conexão depende, sem nomes de servidores.
const PUBLIC_NETWORKS: readonly { name: string; detail: string }[] = [
  { name: 'mobile.settings.network.tor', detail: 'mobile.settings.network.torDetail' },
  { name: 'mobile.settings.network.stun', detail: 'mobile.settings.network.stunDetail' },
  { name: 'mobile.settings.network.dnssd', detail: 'mobile.settings.network.dnssdDetail' }
];

type Props = {
  desktopCount: number;
  tunnelStatus: TunnelStatus | null;
  appVersion: string;
  coreVersion: string;
  logLevel: LogLevel;
  themeMode?: ThemeMode;
  onBack: () => void;
  onLogLevel: (level: LogLevel) => void;
  onThemeMode?: (mode: ThemeMode) => void;
  onRefreshStatus: () => void;
};

export function Settings({
  desktopCount, tunnelStatus, appVersion, coreVersion, logLevel, themeMode = 'system', onBack, onLogLevel, onThemeMode, onRefreshStatus
}: Props) {
  const palette = usePalette();
  const { locale, setLocale, t } = useI18n();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const active = tunnelStatus?.active ?? null;
  const tor = tunnelStatus?.tor ?? null;
  const none = t('mobile.settings.diagnostics.none');
  const unavailable = t('mobile.settings.coreState.unavailable');

  const rows: { label: string; value: string }[] = [
    { label: 'mobile.settings.diagnostics.core', value: tunnelStatus ? t(CORE_STATE_KEYS[tunnelStatus.state]) : unavailable },
    { label: 'mobile.settings.diagnostics.transport', value: active ? t(TRANSPORT_KEYS[active.transport]) : none },
    { label: 'mobile.settings.diagnostics.path', value: active ? t(PATH_KEYS[active.path]) : none },
    { label: 'mobile.settings.diagnostics.tor', value: !tor ? unavailable
      : tor.state === 'bootstrapping' ? t('mobile.reserve.progress', { progress: tor.progress }) : t(TOR_STATE_KEYS[tor.state]) },
    { label: 'mobile.settings.diagnostics.desktops', value: String(tunnelStatus?.desktops ?? desktopCount) },
    { label: 'mobile.settings.diagnostics.coreVersion', value: coreVersion }
  ];

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: palette.background }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.back}>
          <Text style={[styles.backText, { color: palette.accent }]}>{t('mobile.desktops.title')}</Text>
        </Pressable>
        <Text accessibilityRole="header" style={[styles.title, { color: palette.label }]}>{t('mobile.settings.title')}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.section, { color: palette.secondaryLabel }]}>{t('language.label')}</Text>
        <View style={[styles.segment, { backgroundColor: palette.surface, borderColor: palette.separator }]}>
          {LANGUAGE_OPTIONS.map(option => (
            <Pressable accessibilityLabel={t(option.key)} accessibilityRole="button"
              accessibilityState={{ selected: option.value === locale }} key={option.value}
              onPress={() => setLocale(option.value)}
              style={[styles.segmentItem, option.value === locale && { backgroundColor: palette.accent }]}>
              <Text style={{ color: option.value === locale ? palette.accentText : palette.label, fontWeight: '600' }}>
                {t(option.key)}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={[styles.section, { color: palette.secondaryLabel }]}>{t('mobile.settings.appearance')}</Text>
        <View style={[styles.segment, { backgroundColor: palette.surface, borderColor: palette.separator }]}>
          {THEME_MODES.map(mode => (
            <Pressable accessibilityLabel={t(`mobile.settings.appearance.${mode}`)} accessibilityRole="button"
              accessibilityState={{ selected: mode === themeMode }} key={mode} onPress={() => onThemeMode?.(mode)}
              style={[styles.segmentItem, mode === themeMode && { backgroundColor: palette.accent }]}>
              <Text style={{ color: mode === themeMode ? palette.accentText : palette.label, fontWeight: '600' }}>
                {t(`mobile.settings.appearance.${mode}`)}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={[styles.section, { color: palette.secondaryLabel }]}>{t('mobile.settings.logLevel')}</Text>
        <View style={[styles.segment, { backgroundColor: palette.surface, borderColor: palette.separator }]}>
          {(['error', 'info', 'debug'] as const).map(level => (
            <Pressable accessibilityRole="button" key={level} onPress={() => onLogLevel(level)}
              style={[styles.segmentItem, level === logLevel && { backgroundColor: palette.accent }]}>
              <Text style={{ color: level === logLevel ? palette.accentText : palette.label, fontWeight: '600' }}>
                {t(`mobile.settings.log.${level}`)}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={[styles.section, { color: palette.secondaryLabel }]}>{t('mobile.settings.diagnostics.title')}</Text>
        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.separator }]}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: diagnosticsOpen }}
            onPress={() => {
              if (!diagnosticsOpen) onRefreshStatus();
              setDiagnosticsOpen(open => !open);
            }} style={styles.rowButton}>
            <Text style={[styles.rowButtonText, { color: palette.accent }]}>
              {t(diagnosticsOpen ? 'mobile.settings.diagnostics.hide' : 'mobile.settings.diagnostics.show')}
            </Text>
          </Pressable>
          {diagnosticsOpen ? (
            <>
              {rows.map(row => (
                <View key={row.label} style={[styles.row, { borderTopColor: palette.separator }]}>
                  <Text style={[styles.rowLabel, { color: palette.secondaryLabel }]}>{t(row.label)}</Text>
                  <Text selectable style={[styles.rowValue, { color: palette.label }]}>{row.value}</Text>
                </View>
              ))}
              <View style={[styles.row, styles.rowStacked, { borderTopColor: palette.separator }]}>
                <Text style={[styles.rowLabel, { color: palette.secondaryLabel }]}>{t('mobile.settings.diagnostics.networks')}</Text>
                {PUBLIC_NETWORKS.map(network => (
                  <View key={network.name} style={styles.network}>
                    <Text style={[styles.networkName, { color: palette.label }]}>{t(network.name)}</Text>
                    <Text style={[styles.networkDetail, { color: palette.secondaryLabel }]}>{t(network.detail)}</Text>
                  </View>
                ))}
              </View>
              <Pressable accessibilityRole="button" onPress={onRefreshStatus} style={[styles.rowButton, styles.refresh, { borderTopColor: palette.separator }]}>
                <Text style={[styles.rowButtonText, { color: palette.accent }]}>{t('mobile.settings.diagnostics.refresh')}</Text>
              </Pressable>
            </>
          ) : null}
        </View>

        <Text style={[styles.section, { color: palette.secondaryLabel }]}>{t('mobile.settings.about')}</Text>
        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.separator }]}>
          <Text style={[styles.cardDetail, { color: palette.label }]}>{t('mobile.settings.appVersion', { version: appVersion })}</Text>
          <Text style={[styles.cardDetail, { color: palette.secondaryLabel }]}>{t('mobile.settings.licenses')}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  header: { minHeight: 56, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 16 },
  back: { position: 'absolute', left: 8, minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  backText: { fontSize: 16, fontWeight: '600' },
  title: { fontSize: 18, fontWeight: '700' },
  content: { padding: 18, gap: 12 },
  section: { marginTop: 10, marginLeft: 4, fontSize: 13, fontWeight: '600', textTransform: 'uppercase' },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 6 },
  cardDetail: { marginVertical: 5, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  rowStacked: { flexDirection: 'column', alignItems: 'stretch', gap: 8 },
  rowLabel: { flexShrink: 1, fontSize: 14, lineHeight: 20 },
  rowValue: { flexShrink: 1, textAlign: 'right', fontSize: 15, lineHeight: 20, fontWeight: '600' },
  network: { gap: 2 },
  networkName: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  networkDetail: { fontSize: 13, lineHeight: 18 },
  rowButton: { minHeight: 44, justifyContent: 'center' },
  refresh: { borderTopWidth: StyleSheet.hairlineWidth },
  rowButtonText: { fontSize: 15, fontWeight: '600' },
  segment: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 3 },
  segmentItem: { flex: 1, minHeight: 38, justifyContent: 'center', alignItems: 'center', borderRadius: 9 }
});
