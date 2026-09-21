import { DEFAULT_LOCALE, SUPPORTED_LOCALES, dictionaries, type Locale } from '@cialai/i18n';
import type { ConfigContext, ExpoConfig } from 'expo/config';

type AppEnvironment = 'development' | 'preview' | 'production';

// Versão do Tor.framework fixada em modules/cialai-tunnel/ios/CialaiTunnel.podspec.
const IOS_TOR_POD_VERSION = '409.11.2';
// Serviço DNS-SD anunciado pelo computador e procurado pelo NWBrowser do iOS.
const LAN_DISCOVERY_SERVICE = '_cialai._udp';

function resolveAppEnvironment(): AppEnvironment {
  const value = process.env.APP_ENV?.trim() || 'development';
  if (value === 'development' || value === 'preview' || value === 'production') return value;
  throw new Error(`APP_ENV inválido: ${value}`);
}

function resolveAndroidVersionCode(): number {
  const value = process.env.PROJECT_BUILD_NUMBER?.trim();
  if (!value) return 1;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error('project_build_number_invalid');
  const versionCode = Number(value);
  if (!Number.isSafeInteger(versionCode) || versionCode > 2_100_000_000) {
    throw new Error('project_build_number_invalid');
  }
  return versionCode;
}

// Textos dos pedidos de permissão do iOS vindos do mesmo dicionário da interface.
function permissionTexts(locale: Locale) {
  const text = dictionaries[locale];
  return {
    NSCameraUsageDescription: text['mobile.permission.camera'],
    NSLocalNetworkUsageDescription: text['mobile.permission.localNetwork'],
    NSFaceIDUsageDescription: text['mobile.permission.faceId']
  };
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const appEnv = resolveAppEnvironment();
  const permissions = permissionTexts(DEFAULT_LOCALE);

  return {
    ...config,
    name: 'Cialai',
    slug: 'cialai',
    version: '0.2.8',
    userInterfaceStyle: 'automatic',
    platforms: ['ios', 'android'],
    scheme: 'cialai',
    icon: '../desktop/design/app-icon-1024.png',
    locales: Object.fromEntries(SUPPORTED_LOCALES.map(locale => [locale, { ios: permissionTexts(locale) }])),
    ios: {
      bundleIdentifier: 'br.com.ordinum.cialai',
      buildNumber: '1',
      supportsTablet: false,
      // Algoritmos padrão fora da App Store da França dispensam documentação na Apple; ver a decisão 014.
      config: { usesNonExemptEncryption: false },
      entitlements: {
        'com.apple.developer.default-data-protection':
          'NSFileProtectionCompleteUntilFirstUserAuthentication'
      },
      infoPlist: {
        CFBundleDevelopmentRegion: DEFAULT_LOCALE,
        CFBundleLocalizations: [...SUPPORTED_LOCALES],
        // Sem o tipo declarado o iOS 14 ou mais novo recusa a busca do NWBrowser.
        NSBonjourServices: [LAN_DISCOVERY_SERVICE],
        ...permissions
      }
    },
    android: {
      package: 'br.com.ordinum.cialai',
      versionCode: resolveAndroidVersionCode(),
      adaptiveIcon: {
        foregroundImage: '../desktop/design/android-foreground-1024.png',
        // Magenta orquídea da marca. O primeiro plano é o símbolo em branco,
        // então um fundo branco aqui faria o ícone sumir.
        backgroundColor: '#E23B84'
      },
      allowBackup: false,
      softwareKeyboardLayoutMode: 'resize',
      permissions: ['android.permission.CAMERA', 'android.permission.INTERNET', 'android.permission.USE_BIOMETRIC'],
      blockedPermissions: [
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.SYSTEM_ALERT_WINDOW',
        'android.permission.USE_FINGERPRINT',
        'android.permission.VIBRATE',
        'android.permission.WRITE_EXTERNAL_STORAGE'
      ]
    },
    plugins: [
      'expo-dev-client',
      ['expo-camera', {
        cameraPermission: permissions.NSCameraUsageDescription,
        recordAudioAndroid: false,
        barcodeScannerEnabled: true
      }],
      ['expo-secure-store', { configureAndroidBackup: false }],
      ['expo-local-authentication', { faceIDPermission: permissions.NSFaceIDUsageDescription }],
      ['./plugins/with-loopback-network-security.cjs'],
      ['./plugins/with-android-release-signing.cjs'],
      ['./plugins/with-android-data-extraction.cjs'],
      ['./plugins/with-android-locales.cjs', { locales: [...SUPPORTED_LOCALES] }],
      ['./plugins/with-android-compile-sdk-minor.cjs'],
      ['expo-build-properties', {
        android: {
          // O tor-android publica AAR com minCompileSdk 37; o comportamento segue o targetSdk 36.
          // A API 37 só existe com versão menor, e o plugin acima aponta o alvo android-37.0.
          compileSdkVersion: 37,
          targetSdkVersion: 36,
          minSdkVersion: 26,
          // Mesmas ABIs do tunnelcore.aar gerado pelo gomobile; outra ABI instalaria o app sem o núcleo do túnel.
          buildArchs: ['arm64-v8a', 'x86_64']
        },
        ios: {
          deploymentTarget: '16.4',
          // O módulo Swift importa o Tor, um pod Objective-C sem módulo; sem cabeçalhos
          // modulares o CocoaPods recusa a dependência em bibliotecas estáticas.
          extraPods: [{ name: 'Tor', version: IOS_TOR_POD_VERSION, modular_headers: true }]
        }
      }]
    ],
    extra: { appEnv }
  };
};
