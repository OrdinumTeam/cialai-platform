import type { ConfigContext, ExpoConfig } from 'expo/config';

type AppEnvironment = 'development' | 'preview' | 'production';

function resolveAppEnvironment(): AppEnvironment {
  const value = process.env.APP_ENV?.trim() || 'development';
  if (value === 'development' || value === 'preview' || value === 'production') return value;
  throw new Error(`APP_ENV inválido: ${value}`);
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const appEnv = resolveAppEnvironment();
  const faceIDPermission = 'O Cialai usa o Face ID para autorizar ações sensíveis no computador.';

  return {
    ...config,
    name: 'Cialai',
    slug: 'cialai',
    version: '0.1.0',
    userInterfaceStyle: 'automatic',
    platforms: ['ios', 'android'],
    scheme: 'cialai',
    icon: '../desktop/design/app-icon-1024.png',
    ios: {
      bundleIdentifier: 'br.com.ordinum.cialai',
      buildNumber: '1',
      supportsTablet: false,
      config: { usesNonExemptEncryption: true },
      entitlements: {
        'com.apple.developer.default-data-protection':
          'NSFileProtectionCompleteUntilFirstUserAuthentication'
      },
      infoPlist: {
        CFBundleDevelopmentRegion: 'pt-BR',
        CFBundleLocalizations: ['pt-BR'],
        NSCameraUsageDescription: 'O Cialai usa a câmera somente para ler o código de vínculo exibido no computador.',
        NSLocalNetworkUsageDescription: 'O Cialai procura seu computador na rede local antes de usar o caminho remoto.',
        NSFaceIDUsageDescription: faceIDPermission
      }
    },
    android: {
      package: 'br.com.ordinum.cialai',
      versionCode: 1,
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
        cameraPermission: 'O Cialai usa a câmera somente para ler o código de vínculo exibido no computador.',
        recordAudioAndroid: false,
        barcodeScannerEnabled: true
      }],
      ['expo-secure-store', { configureAndroidBackup: false }],
      ['expo-local-authentication', { faceIDPermission }],
      ['./plugins/with-loopback-network-security.cjs'],
      ['expo-build-properties', {
        android: {
          compileSdkVersion: 36,
          targetSdkVersion: 36,
          minSdkVersion: 26
        },
        ios: {
          deploymentTarget: '16.4'
        }
      }]
    ],
    extra: { appEnv }
  };
};
