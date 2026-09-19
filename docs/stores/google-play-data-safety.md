# Google Play Data Safety Answers

Status: answered in Play Console on 16/09/2026, audited against the signed AAB on 17/09/2026

The form was filled with the answers below and the privacy policy URL points to
`https://cialai.com.br/privacy-policy`. Answering no to the first question skips
the data type and data handling steps, so no category is declared.

The audit at the end of this page was performed on 17/09/2026 against the signed
AAB of versionCode 16, version 0.2.4, the build submitted to production review.
The answers no longer rest on the dependency list alone.

## Collection and sharing

| Question | Proposed answer |
| --- | --- |
| Does the app collect or share any required user data types? | No |
| Is user data encrypted in transit? | Yes |
| Does the app provide account creation? | No |
| Can users request deletion of a publisher account? | Not applicable because no publisher account exists |
| Has the app completed an eligible independent security review? | No |

No data categories should be declared as collected or shared for the current Android build.

## Basis for the answer

- The app has no analytics, advertising, crash reporting or publisher account service.
- Data exchanged with the desktop follows the user's request and stays between paired devices.
- Cialai operates no server. Paired devices connect directly or through the public Tor network, and optional STUN requests to public Cloudflare and Google servers carry no project or terminal content.
- Mobile profiles and tokens remain in local secure storage.
- Camera access scans a pairing code and does not upload or retain images.
- Biometric verification is handled by Android and the app does not receive biometric templates.
- The clear text loopback connection remains inside the phone. Traffic between devices is encrypted.

## Privacy policy

Publish `docs/legal/privacy-policy-en.md` and `docs/legal/privacy-policy-pt-BR.md` as stable public web pages. Enter the relevant public URL in Play Console and expose the same policy from the app before production submission.

## Audit of the signed AAB, versionCode 16

Performed on 17/09/2026 over the artifact `app-release.aab` of the Codemagic
build `6aabba9263258660ef4dc1d9` and its universal APK, both signed with the
upload key.

### SDKs found in the dex

| Search | Occurrences | Reading |
| --- | --- | --- |
| Google Mobile Ads | 0 | No advertising SDK |
| Firebase Analytics, Messaging, Crashlytics, Installations | 0 | No Firebase product that collects data |
| Crashlytics, Sentry, Bugsnag, Datadog | 0 | No crash or performance reporting |
| Amplitude, Mixpanel, Segment, Google Analytics | 0 | No product analytics |
| AppsFlyer, Adjust, Facebook app events, OneSignal | 0 | No attribution, no push, no marketing |
| ML Kit barcode scanning | present | Reads the pairing QR code on the device |
| Firebase components and encoders | present | Wiring required by ML Kit, no product of its own |
| Google data transport, CCT backend | present | Diagnostics channel that ML Kit brings with it |

The only third party that reaches the network on its own is the Google data
transport that ML Kit registers. It carries ML Kit usage diagnostics, never
camera frames, project content or terminal content. The scanning itself runs on
the device through the bundled `libbarhopper_v3.so` model.

### Permissions in the shipped manifest

`CAMERA` for the pairing code, `INTERNET`, `ACCESS_NETWORK_STATE`,
`ACCESS_WIFI_STATE` and `CHANGE_WIFI_MULTICAST_STATE` for connectivity and local
discovery, `USE_BIOMETRIC` for the local lock, and the React Native internal
`DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. There is no location, contacts,
storage, microphone, phone or account permission. The `android.permission.DUMP`
string that appears in the manifest is the guard of the AndroidX
`ProfileInstallReceiver`, not a permission the app requests.

### Endpoints

No Ordinum controlled endpoint appears in the binary. The `googleapis.com`
strings are OAuth scope constants carried by Google Play services and are never
requested. There is no analytics or crash endpoint.

### Keep this current

Repeat the audit whenever shipped behavior or an included SDK changes, and
update the form in Play Console in the same pass.

Reference: [Google Play guidance for the Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469).
