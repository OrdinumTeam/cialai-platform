import { expect, test } from '@jest/globals';

import scenePlugin from './with-ios-scene-lifecycle.cjs';

const { adoptSceneLifecycle, sceneManifest, SCENE_DELEGATE_FILE, SCENE_DELEGATE_SWIFT } = scenePlugin;

// AppDelegate.swift como o prebuild do Expo 57 o gera para este app.
const TEMPLATE = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }
}
`;

test('the app delegate leaves the window to the scene and names the delegate that serves it', () => {
  const output = adoptSceneLifecycle(TEMPLATE);
  expect(output).not.toContain('UIWindow(frame: UIScreen.main.bounds)');
  expect(output).not.toContain('#if os(iOS) || os(tvOS)');
  expect(output).toContain('var launchOptions: [UIApplication.LaunchOptionsKey: Any]?');
  expect(output).toContain('self.launchOptions = launchOptions');
  expect(output).toContain('configurationForConnecting connectingSceneSession: UISceneSession');
  expect(output).toContain('configuration.delegateClass = SceneDelegate.self');
  expect(output).toContain('return super.application(application, didFinishLaunchingWithOptions: launchOptions)');
  expect(output.indexOf('configurationForConnecting')).toBeLessThan(output.indexOf('// Linking API'));
  expect(adoptSceneLifecycle(output)).toBe(output);
});

test('an app delegate outside the Expo template is refused instead of half patched', () => {
  expect(() => adoptSceneLifecycle('class AppDelegate: ExpoAppDelegate {}')).toThrow('ios_scene_app_delegate_unexpected');
  expect(() => adoptSceneLifecycle(TEMPLATE.replace('  // Linking API\n', ''))).toThrow('ios_scene_app_delegate_unexpected');
});

test('the manifest declares a single scene served by the SceneDelegate of the module', () => {
  const manifest = sceneManifest();
  expect(manifest.UIApplicationSupportsMultipleScenes).toBe(false);
  const [role] = manifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication;
  expect(role.UISceneConfigurationName).toBe('Default Configuration');
  expect(role.UISceneDelegateClassName).toBe('$(PRODUCT_MODULE_NAME).SceneDelegate');
});

test('the scene delegate creates the window on the scene, starts React Native and forwards URLs', () => {
  expect(SCENE_DELEGATE_FILE).toBe('SceneDelegate.swift');
  expect(SCENE_DELEGATE_SWIFT).toContain('class SceneDelegate: UIResponder, UIWindowSceneDelegate');
  expect(SCENE_DELEGATE_SWIFT).toContain('UIWindow(windowScene: windowScene)');
  expect(SCENE_DELEGATE_SWIFT).toContain('startReactNative(withModuleName: "main", in: window, launchOptions: appDelegate.launchOptions)');
  expect(SCENE_DELEGATE_SWIFT).toContain('openURLContexts');
  expect(SCENE_DELEGATE_SWIFT).toContain('RCTLinkingManager.application(UIApplication.shared, continue: activity');
});
