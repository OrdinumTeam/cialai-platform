# App Store Privacy Answers

Status: answered and published in App Store Connect on 16/09/2026

The product page shows Data Not Collected. The privacy policy URL points to
`https://cialai.com.br/privacy-policy` in the pt-BR localization. The User
Privacy Choices URL stays empty, as planned.

Owner action still required: the audit at the end of this page was not performed
against the archived binary. The answers rest on the dependency list in the
repository, not on an inspection of the shipped build.

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

## Required audit before submission

- Inspect the final dependency graph and archived binary for analytics, advertising and crash reporting SDKs.
- Confirm that no request is sent to an Ordinum controlled endpoint.
- Confirm that support diagnostics are shared only after an explicit user action.
- Confirm that the privacy policy URLs are live and match the text in this repository.
- Repeat the questionnaire if any future feature transmits data to Ordinum or a service provider acting for Ordinum.

Reference: [Apple guidance for managing app privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy).
