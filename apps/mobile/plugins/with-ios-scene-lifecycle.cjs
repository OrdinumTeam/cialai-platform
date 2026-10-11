// SPDX-License-Identifier: Apache-2.0
// Ciclo de vida UIScene no iOS. Um app ligado ao SDK do iOS 27 precisa adotar
// as cenas, senão o UIKit o derruba na abertura: foi o que aconteceu com o
// 0.2.10 (12), compilado com o Xcode 27. O Expo 57 ainda gera o AppDelegate
// clássico, com a janela criada na abertura, então este plugin declara o
// manifesto de cena no Info.plist, tira a criação da janela do AppDelegate e a
// entrega a um SceneDelegate, que também recebe as URLs abertas na cena. No
// Xcode 26 nada muda de comportamento: as cenas valem desde o iOS 13.
const { IOSConfig, withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const SCENE_CONFIGURATION = 'Default Configuration';
const SCENE_DELEGATE_CLASS = '$(PRODUCT_MODULE_NAME).SceneDelegate';
const SCENE_DELEGATE_FILE = 'SceneDelegate.swift';

const SCENE_DELEGATE_SWIFT = `import UIKit
import React

// Cena única do app. O AppDelegate cria a fábrica do React Native na abertura;
// a janela nasce aqui, ligada à cena, e as URLs abertas chegam por aqui.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let factory = appDelegate.reactNativeFactory else { return }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: appDelegate.launchOptions)
    open(urls: connectionOptions.urlContexts)
    for activity in connectionOptions.userActivities { continueActivity(activity) }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    open(urls: URLContexts)
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    continueActivity(userActivity)
  }

  private func open(urls contexts: Set<UIOpenURLContext>) {
    for context in contexts {
      _ = RCTLinkingManager.application(UIApplication.shared, open: context.url, options: [:])
    }
  }

  private func continueActivity(_ activity: NSUserActivity) {
    _ = RCTLinkingManager.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
  }
}
`;

// Bloco que o modelo do Expo gera na abertura; a janela passa a nascer na cena.
const WINDOW_BLOCK = /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\(\n\s*withModuleName: "main",\n\s*in: window,\n\s*launchOptions: launchOptions\)\n#endif\n/;
const WINDOW_PROPERTY = '  var window: UIWindow?\n';
const LINKING_MARK = '  // Linking API\n';

function sceneManifest() {
  return {
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: [
        { UISceneConfigurationName: SCENE_CONFIGURATION, UISceneDelegateClassName: SCENE_DELEGATE_CLASS }
      ]
    }
  };
}

// Reescreve o AppDelegate.swift gerado: guarda as opções da abertura, deixa a
// janela para o SceneDelegate e responde qual delegate atende a cena. Um
// arquivo que não tem o formato esperado é recusado, para a mudança do modelo
// do Expo aparecer no prebuild e não só na abertura do app.
function adoptSceneLifecycle(contents) {
  if (contents.includes('configurationForConnecting')) return contents;
  if (!WINDOW_BLOCK.test(contents) || !contents.includes(WINDOW_PROPERTY) || !contents.includes(LINKING_MARK)) {
    throw new Error('ios_scene_app_delegate_unexpected');
  }
  return contents
    .replace(WINDOW_PROPERTY, `${WINDOW_PROPERTY}  // Opções da abertura, guardadas para o SceneDelegate iniciar o React Native.
  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?
`)
    .replace(WINDOW_BLOCK, `    // A janela nasce no SceneDelegate, ligada à cena.
    self.launchOptions = launchOptions
`)
    .replace(LINKING_MARK, `  // Ciclo de vida UIScene: uma cena só, atendida pelo SceneDelegate.
  public func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "${SCENE_CONFIGURATION}", sessionRole: connectingSceneSession.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }

${LINKING_MARK}`);
}

function withSceneManifest(config) {
  return withInfoPlist(config, next => {
    next.modResults.UIApplicationSceneManifest = sceneManifest();
    return next;
  });
}

function withSceneAppDelegate(config) {
  return withAppDelegate(config, next => {
    if (next.modResults.language !== 'swift') throw new Error('ios_scene_app_delegate_language');
    next.modResults.contents = adoptSceneLifecycle(next.modResults.contents);
    return next;
  });
}

function withSceneDelegateFile(config) {
  return IOSConfig.XcodeProjectFile.withBuildSourceFile(config, { filePath: SCENE_DELEGATE_FILE, contents: SCENE_DELEGATE_SWIFT, overwrite: true });
}

function withIosSceneLifecycle(config) {
  return withSceneDelegateFile(withSceneAppDelegate(withSceneManifest(config)));
}

module.exports = withIosSceneLifecycle;
module.exports.adoptSceneLifecycle = adoptSceneLifecycle;
module.exports.sceneManifest = sceneManifest;
module.exports.SCENE_DELEGATE_SWIFT = SCENE_DELEGATE_SWIFT;
module.exports.SCENE_DELEGATE_FILE = SCENE_DELEGATE_FILE;
