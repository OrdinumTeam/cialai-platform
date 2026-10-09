import { useState, type ReactNode } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Locale } from '@cialai/i18n';

import type { LogLevel, TunnelStatus } from 'cialai-tunnel';

import { BIOMETRIC_POLICIES, type BiometricPolicy } from '../auth/biometrics';
import { APP_LICENSE, licensesFor } from '../config/licenses';
import { useI18n } from '../i18n';
import type { NotificationPermission } from '../notifications/notify';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from '../notifications/watch';
import { formatDiagnosticTime, useDiagnosticLog } from '../state/diagnostics';
import { THEME_MODES, useTokens, type ThemeMode } from '../theme';
import { AppHeader, BottomSheet, BrandMark, Card, Icon, Notice, OptionTiles, Screen, SecondaryButton, SegmentedControl, Toggle,
  space, typography, type IconName } from '../ui';
import { PATH_KEYS, TOR_STATE_KEYS, TRANSPORT_KEYS } from './TransportBadge';


const LANGUAGE_OPTIONS: readonly { value: Locale; key: string }[] = [
  { value: 'pt-BR', key: 'language.portuguese' },
  { value: 'en', key: 'language.english' },
  { value: 'es', key: 'language.spanish' },
];

const THEME_ICONS: Readonly<Record<ThemeMode, IconName>> = { system: 'sun-moon', light: 'sun', dark: 'moon' };
const LOG_LEVELS: readonly LogLevel[] = ['error', 'info', 'debug'];

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

type Sheet = 'diagnostics' | 'technical' | 'licenses' | null;

type Props = {
  desktopCount: number;
  tunnelStatus: TunnelStatus | null;
  appVersion: string;
  coreVersion: string;
  logLevel: LogLevel;
  themeMode?: ThemeMode;
  biometricPolicy?: BiometricPolicy;
  notificationPrefs?: NotificationPrefs;
  notificationAccess?: NotificationPermission;
  onBack: () => void;
  onLogLevel: (level: LogLevel) => void;
  onThemeMode?: (mode: ThemeMode) => void;
  onBiometricPolicy?: (policy: BiometricPolicy) => void;
  onNotification?: (kind: keyof NotificationPrefs, enabled: boolean) => void;
  onRefreshStatus: () => void;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { colors } = useTokens();
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[typography.headline, { color: colors.text }]}>{title}</Text>
      {children}
    </View>
  );
}

function LinkRow({ icon, label, onPress, first }: { icon: IconName; label: string; onPress: () => void; first?: boolean }) {
  const { colors } = useTokens();
  return (
    <Pressable accessibilityLabel={label} accessibilityRole="button" onPress={onPress}
      style={({ pressed }) => [styles.linkRow, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
        pressed && { opacity: 0.6 }]}>
      <Icon color={colors.textSecondary} name={icon} size={20} />
      <Text style={[typography.callout, styles.flex, { color: colors.text }]}>{label}</Text>
      <Icon color={colors.textTertiary} name="chevron-right" size={18} />
    </Pressable>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  const { colors } = useTokens();
  return (
    <View style={[styles.infoRow, { borderTopColor: colors.border }]}>
      <Text style={[typography.footnote, styles.flex, { color: colors.textSecondary }]}>{label}</Text>
      <Text selectable style={[typography.callout, styles.infoValue, { color: colors.text }]}>{value}</Text>
    </View>
  );
}

export function Settings({
  desktopCount, tunnelStatus, appVersion, coreVersion, logLevel, themeMode = 'system', biometricPolicy = 'always',
  notificationPrefs = DEFAULT_NOTIFICATION_PREFS, notificationAccess = 'undetermined',
  onBack, onLogLevel, onThemeMode, onBiometricPolicy, onNotification, onRefreshStatus
}: Props) {
  const { colors } = useTokens();
  const { locale, setLocale, t } = useI18n();
  const [sheet, setSheet] = useState<Sheet>(null);
  const diagnosticLog = useDiagnosticLog();
  const active = tunnelStatus?.active ?? null;
  const tor = tunnelStatus?.tor ?? null;
  const none = t('mobile.settings.diagnostics.none');
  const unavailable = t('mobile.settings.coreState.unavailable');
  const blocked = notificationAccess === 'denied';

  const rows: { label: string; value: string }[] = [
    { label: 'mobile.settings.diagnostics.core', value: tunnelStatus ? t(CORE_STATE_KEYS[tunnelStatus.state]) : unavailable },
    { label: 'mobile.settings.diagnostics.transport', value: active ? t(TRANSPORT_KEYS[active.transport]) : none },
    { label: 'mobile.settings.diagnostics.path', value: active ? t(PATH_KEYS[active.path]) : none },
    { label: 'mobile.settings.diagnostics.tor', value: !tor ? unavailable
      : tor.state === 'bootstrapping' ? t('mobile.reserve.progress', { progress: tor.progress }) : t(TOR_STATE_KEYS[tor.state]) },
    { label: 'mobile.settings.diagnostics.desktops', value: String(tunnelStatus?.desktops ?? desktopCount) },
    { label: 'mobile.settings.diagnostics.coreVersion', value: coreVersion }
  ];
  const system = `${t(Platform.OS === 'ios' ? 'mobile.settings.technical.ios' : 'mobile.settings.technical.android')} ${String(Platform.Version)}`;

  return (
    <Screen>
      <AppHeader backLabel={t('mobile.home.open')} onBack={onBack} title={t('mobile.settings.title')} />
      <ScrollView contentContainerStyle={styles.content}>
        <Section title={t('mobile.settings.appearance')}>
          <OptionTiles onChange={mode => onThemeMode?.(mode)} value={themeMode}
            options={THEME_MODES.map(mode => ({ value: mode, label: t(`mobile.settings.appearance.${mode}`), icon: THEME_ICONS[mode] }))} />
        </Section>

        <Section title={t('language.label')}>
          <SegmentedControl onChange={value => void setLocale(value)} value={locale}
            options={LANGUAGE_OPTIONS.map(option => ({ value: option.value, label: t(option.key) }))} />
        </Section>

        <Section title={t('mobile.settings.biometrics')}>
          <SegmentedControl onChange={policy => onBiometricPolicy?.(policy)} value={biometricPolicy}
            options={BIOMETRIC_POLICIES.map(policy => ({ value: policy, label: t(`mobile.settings.biometrics.${policy}`) }))} />
          <Text style={[typography.footnote, { color: colors.textSecondary }]}>{t(`mobile.settings.biometricsHint.${biometricPolicy}`)}</Text>
        </Section>

        <Section title={t('mobile.settings.notifications')}>
          <Card style={styles.group}>
            <Toggle icon="circle-check" label={t('mobile.settings.notifications.sessions')} onChange={value => onNotification?.('sessions', value)}
              value={notificationPrefs.sessions && !blocked} />
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <Toggle icon="bell" label={t('mobile.settings.notifications.usage')} onChange={value => onNotification?.('usage', value)}
              value={notificationPrefs.usage && !blocked} />
          </Card>
          {blocked ? (
            <Notice detail={t('mobile.settings.notifications.blocked')} icon="circle-alert" tone="warning">
              <SecondaryButton label={t('mobile.settings.notifications.openSystem')} onPress={() => void Linking.openSettings().catch(() => undefined)}
                variant="neutral" />
            </Notice>
          ) : null}
          <Text style={[typography.footnote, { color: colors.textSecondary }]}>{t('mobile.settings.notifications.hint')}</Text>
        </Section>

        <Section title={t('mobile.settings.diagnostics.section')}>
          <Card style={styles.group}>
            <Text style={[typography.footnote, styles.groupLabel, { color: colors.textSecondary }]}>{t('mobile.settings.logLevel')}</Text>
            <SegmentedControl onChange={onLogLevel} value={logLevel}
              options={LOG_LEVELS.map(level => ({ value: level, label: t(`mobile.settings.log.${level}`) }))} />
            <View style={styles.links}>
              <LinkRow first icon="scroll-text" label={t('mobile.settings.diagnostics.show')}
                onPress={() => { onRefreshStatus(); setSheet('diagnostics'); }} />
              <LinkRow icon="cpu" label={t('mobile.settings.technical.title')} onPress={() => setSheet('technical')} />
            </View>
          </Card>
        </Section>

        <Section title={t('mobile.settings.about')}>
          <Card style={styles.group}>
            <View style={styles.about}>
              <BrandMark size={36} />
              <View style={styles.flex}>
                <Text style={[typography.headline, { color: colors.text }]}>{t('mobile.settings.about.version', { version: appVersion })}</Text>
                <Text style={[typography.footnote, { color: colors.textSecondary }]}>{t('mobile.settings.about.detail')}</Text>
              </View>
            </View>
            <LinkRow icon="file-text" label={t('mobile.settings.licenses.title')} onPress={() => setSheet('licenses')} />
          </Card>
        </Section>
      </ScrollView>

      <BottomSheet onClose={() => setSheet(null)} title={t('mobile.settings.diagnostics.title')} visible={sheet === 'diagnostics'}>
        {rows.map(row => <InfoRow key={row.label} label={t(row.label)} value={row.value} />)}
        <View style={[styles.stacked, { borderTopColor: colors.border }]}>
          <Text style={[typography.footnote, { color: colors.textSecondary }]}>{t('mobile.settings.diagnostics.networks')}</Text>
          {PUBLIC_NETWORKS.map(network => (
            <View key={network.name} style={styles.network}>
              <Text style={[typography.callout, styles.strong, { color: colors.text }]}>{t(network.name)}</Text>
              <Text style={[typography.footnote, { color: colors.textSecondary }]}>{t(network.detail)}</Text>
            </View>
          ))}
        </View>
        <View style={[styles.stacked, { borderTopColor: colors.border }]}>
          <Text style={[typography.footnote, { color: colors.textSecondary }]}>{t('mobile.settings.diagnostics.log')}</Text>
          {diagnosticLog.length ? [...diagnosticLog].reverse().map(line => (
            <Text key={`${line.at}:${line.message}`} selectable style={[styles.logLine, { color: colors.text }]}>
              <Text style={{ color: colors.textTertiary }}>{formatDiagnosticTime(line.at)}</Text>
              {' '}
              {line.message}
            </Text>
          )) : <Text style={[typography.footnote, { color: colors.textSecondary }]}>{t('mobile.settings.diagnostics.logEmpty')}</Text>}
        </View>
        <SecondaryButton icon="refresh" label={t('mobile.settings.diagnostics.refresh')} onPress={onRefreshStatus} variant="soft" />
      </BottomSheet>

      <BottomSheet onClose={() => setSheet(null)} title={t('mobile.settings.technical.title')} visible={sheet === 'technical'}>
        <InfoRow label={t('mobile.settings.technical.system')} value={system} />
        <InfoRow label={t('mobile.settings.technical.app')} value={appVersion} />
        <InfoRow label={t('mobile.settings.diagnostics.coreVersion')} value={coreVersion} />
        <InfoRow label={t('mobile.settings.technical.language')} value={locale} />
        <InfoRow label={t('mobile.settings.logLevel')} value={t(`mobile.settings.log.${logLevel}`)} />
      </BottomSheet>

      <BottomSheet onClose={() => setSheet(null)} title={t('mobile.settings.licenses.title')} visible={sheet === 'licenses'}>
        <Text style={[typography.callout, { color: colors.text }]}>
          {t('mobile.settings.licenses.app', { name: APP_LICENSE.name, license: APP_LICENSE.license })}
        </Text>
        <Text style={[typography.footnote, { color: colors.textSecondary }]}>{APP_LICENSE.copyright}</Text>
        <Text style={[typography.footnote, styles.groupLabel, { color: colors.textSecondary }]}>{t('mobile.settings.licenses.thirdParty')}</Text>
        {licensesFor(Platform.OS).map(item => <InfoRow key={item.name} label={item.name} value={item.license} />)}
        <Text style={[typography.footnote, { color: colors.textTertiary }]}>{t('mobile.settings.licenses.notice')}</Text>
      </BottomSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.xl },
  section: { gap: space.sm },
  group: { gap: space.xs, paddingVertical: space.xs },
  groupLabel: { fontWeight: '600' },
  divider: { height: StyleSheet.hairlineWidth },
  flex: { flex: 1, minWidth: 0 },
  links: { marginTop: space.xs },
  linkRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  about: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
  infoRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.md, paddingVertical: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  infoValue: { flexShrink: 1, textAlign: 'right', fontWeight: '600' },
  stacked: { gap: space.xs, paddingVertical: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  network: { gap: 2 },
  strong: { fontWeight: '600' },
  logLine: { ...typography.footnote, fontSize: 12, lineHeight: 17, fontVariant: ['tabular-nums'] }
});
