# App Review Notes

Status: copy prepared, submission pending

Copy the section below into App Store Connect only after every owner field is complete and the dedicated review environment passes the desktop demo runbook.

## Copy for App Review

```text
Cialai is a companion for the Cialai desktop terminal studio. It lets a person pair an iPhone with a computer they control, view terminal history, interact with an active terminal and browse project files allowed by the desktop.

The app has no Ordinum account, no subscription and no server to configure. The review requires no coordination server. When Cialai opens on the computer, it sets up its connectivity on its own. The iPhone reaches the computer on the local network, over a direct connection through the internet or through an embedded Tor onion service used as backup, so it does not need to share a network with the computer. Content moves through an end to end encrypted connection between the paired phone and computer. Ordinum does not receive project files or terminal content.

Review access

Dedicated desktop name: [USER: ENTER REVIEW DESKTOP NAME]
Desktop access method: [USER: ENTER THE REVIEW ACCESS URL OR INSTRUCTIONS]
Access credential: [USER: ENTER ONLY IN APP STORE CONNECT]
Availability window: [USER: ENTER DATES AND TIME ZONE]
Support contact during review: [USER: ENTER CONFIRMED CONTACT]

Steps

1. Open the dedicated desktop through the access method above. Cialai is already running there with the Review session open.
2. In Cialai on the desktop, choose Pair phone. The desktop shows a pairing QR code.
3. Open Cialai on the iPhone, scan the QR code shown by the desktop, check that the computer fingerprint matches and choose Pair.
4. When the desktop shows a four digit approval code, check that the phone shows the same code on its pairing screen and choose Authorize on the desktop.
5. Choose Review Mac in the Computers screen. A Direct or Backup badge shows the path in use. From another network the first connection can take a few moments while the backup connection gets ready.
6. Open the Review session to see terminal history and the fictional welcome file.

The QR code rotates every 90 seconds, expires after 10 minutes and can be used only once. Generate a fresh code during review. No permanent login credential is stored in the app.

Permission use

Camera access scans the pairing QR code.
Local network access reaches a paired computer on the same network when available.
Face ID protects sensitive terminal actions. The operating system performs biometric verification and the app does not receive biometric data.

Encryption

Cialai uses only standard, published encryption for device connectivity: mutual TLS 1.3 between the paired devices, on the direct connection and inside the embedded open source Tor client. The build declares its encryption use in App Store Connect. Export compliance answers and any required documentation will be supplied by the account holder.

A pairing walkthrough video is attached in the review package. It shows the same dedicated environment and fictional data.
```

## Owner gate before submission

- Replace every owner field in App Store Connect.
- Keep credentials only in the private review field.
- Confirm the signed build number and version match the tested candidate.
- Confirm the dedicated computer remains awake and reachable throughout review.
- Confirm the checks in the advanced diagnostics of the Devices screen pass on the dedicated computer, with the onion service published.
- Generate no long lived QR payload or static device token.
- Attach the final pairing video.
- Revoke every device used during rehearsal and recording.
- Record the submission date and build number in `docs/produto/12-decisoes.md` after the real action.
