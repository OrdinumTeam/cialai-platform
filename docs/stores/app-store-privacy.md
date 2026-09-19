# App Store Privacy Answers

Status: answered and published in App Store Connect on 16/09/2026, audited against the archived binary on 17/09/2026

The product page shows Data Not Collected. The privacy policy URL points to
`https://cialai.com.br/privacy-policy` in the pt-BR localization. The User
Privacy Choices URL stays empty, as planned.

The audit at the end of this page ran on 17/09/2026 against the archived binary,
the IPA that Codemagic signed for version 0.2.4, build 6. The answers no longer
rest on the dependency list alone.

## Privacy policy

| Field | Proposed value |
| --- | --- |
| Privacy Policy URL in English | User must publish `docs/legal/privacy-policy-en.md` and enter its public URL |
| Privacy Policy URL in Brazilian Portuguese | User must publish `docs/legal/privacy-policy-pt-BR.md` and enter its public URL |
| User Privacy Choices URL | Leave empty because Cialai has no publisher account or hosted user record |

The URL must be public, stable and available without authentication. App Store Connect requires a privacy policy URL for the iOS platform.

## Data collection

Question: Do you or your third party partners collect data from this app?

Proposed answer: **No, we do not collect data from this app**

No additional data types should be selected after this answer.

## Basis for the answer

- The iOS app has no Ordinum account, analytics, advertising or crash reporting service.
- Project files and terminal content travel only between the user's paired devices.
- Cialai operates no server. Paired devices connect directly or through the public Tor network, and optional STUN requests to public Cloudflare and Google servers carry no project or terminal content.
- Pairing details and connection profiles remain on the device.
- Device tokens use secure local storage.
- Biometric verification is performed by iOS and the app does not receive biometric templates.
- Camera images are used for live QR recognition and are not uploaded or retained.

## Audit of the archived build, 0.2.4 build 6

Performed on 17/09/2026 over `Cialai.ipa` from the Codemagic build
`6aabba93209c9ed06d840ce9`.

### Embedded frameworks

`ExpoCamera`, `ExpoCameraBarcodeScanning`, `ExpoFileSystem`, `ExpoFont`,
`ExpoModulesCore`, `ExpoModulesJSI`, `ExpoModulesWorklets`, `React`,
`ReactNativeDependencies`, `ZXingObjC` and `hermesvm`. Nothing else ships inside
the app.

There is no Firebase, no Crashlytics, no Sentry, no Amplitude, no Mixpanel and no
AppsFlyer. The strings that resemble those names in the main binary are the C++
`std::istream` sentry class and the JavaScript `isEntry` field, not an SDK. QR
reading is done on the device by `ZXingObjC`, which has no network code of its
own, so the iOS build has no equivalent of the diagnostics channel that ML Kit
brings to Android.

Eight privacy manifests travel inside the bundle, one per framework that Apple
requires to declare its API use.

### Keep this current

Repeat the audit whenever a dependency is added, confirm the privacy policy URLs
stay live, and redo the questionnaire if any feature starts transmitting data to
Ordinum or to a provider acting for Ordinum.

Reference: [Apple guidance for managing app privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy).
