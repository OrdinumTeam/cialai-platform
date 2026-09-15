# Google Play Data Safety Answers

Status: proposed answers for the first Android build

Owner action required: verify these answers against the signed AAB and every included SDK, publish the privacy policy on a public URL and complete the Data safety form in Play Console.

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

## Required audit before submission

- Inspect the final AAB dependency report for SDKs that collect or share data.
- Inspect the merged manifest for permissions added by dependencies.
- Confirm that no application request reaches an Ordinum controlled endpoint.
- Confirm that diagnostics leave the device only after an explicit user action.
- Update this form whenever shipped behavior or an included SDK changes.

Reference: [Google Play guidance for the Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469).
