import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Locale } from '@cialai/i18n';

import { useI18n } from '../i18n';
import type { ProfileStore } from '../profiles/store';
import { usePalette } from '../theme';

type LogLevel = 'error' | 'info' | 'debug';

const LANGUAGE_OPTIONS: readonly { value: Locale; key: string }[] = [
  { value: 'pt-BR', key: 'language.portuguese' },
  { value: 'en', key: 'language.english' },
  { value: 'es', key: 'language.spanish' },
];

type Props = {
  store: ProfileStore;
  appVersion: string;
  coreVersion: string;
  logLevel: LogLevel;
  onBack: () => void;
  onForgetProfile: (profileId: string) => void;
  onLogLevel: (level: LogLevel) => void;
};

export function Settings({ store, appVersion, coreVersion, logLevel, onBack, onForgetProfile, onLogLevel }: Props) {
  const palette = usePalette();
  const { locale, setLocale, t } = useI18n();
  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: palette.background }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.back}>
          <Text style={[styles.backText, { color: palette.accent }]}>{t('mobile.desktops.title')}</Text>
        </Pressable>
        <Text accessibilityRole="header" style={[styles.title, { color: palette.label }]}>{t('mobile.settings.title')}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.section, { color: palette.secondaryLabel }]}>{t('mobile.settings.profiles')}</Text>
        {store.profiles.map(profile => (
          <View key={profile.id} style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.separator }]}>
            <Text style={[styles.cardTitle, { color: palette.label }]}>{profile.userName}</Text>
            <Text selectable style={[styles.cardDetail, { color: palette.secondaryLabel }]}>{profile.controlUrl}</Text>
            <Pressable accessibilityRole="button" onPress={() => onForgetProfile(profile.id)} style={styles.rowButton}>
              <Text style={[styles.rowButtonText, { color: palette.danger }]}>{t('mobile.settings.forgetProfile')}</Text>
            </Pressable>
          </View>
        ))}
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
        <Text style={[styles.section, { color: palette.secondaryLabel }]}>{t('mobile.settings.about')}</Text>
        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.separator }]}>
          <Text style={[styles.cardDetail, { color: palette.label }]}>{t('mobile.settings.appVersion', { version: appVersion })}</Text>
          <Text style={[styles.cardDetail, { color: palette.label }]}>{t('mobile.settings.coreVersion', { version: coreVersion })}</Text>
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
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 16 },
  cardTitle: { fontSize: 17, fontWeight: '600' },
  cardDetail: { marginTop: 5, fontSize: 14, lineHeight: 20 },
  rowButton: { minHeight: 44, justifyContent: 'center', marginTop: 6 },
  rowButtonText: { fontSize: 15, fontWeight: '600' },
  segment: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 3 },
  segmentItem: { flex: 1, minHeight: 38, justifyContent: 'center', alignItems: 'center', borderRadius: 9 }
});
