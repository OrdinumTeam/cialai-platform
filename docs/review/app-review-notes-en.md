# App Review Notes

Status: a shorter variant was submitted on 16/09/2026, without a dedicated desktop

The 0.2.2 submission did not use the text below. The owner chose to ship without
a dedicated review environment, so the notes that went to Apple ask the reviewer
to install the free desktop app and pair a device themselves. That text is in
[Submitted for 0.2.2](#submitted-for-022). The same choice was made on Google
Play, in the app access declaration.

The copy below remains the plan for the case where a review comes back rejected
for lack of access. It needs a dedicated computer, which is the owner gate that
was skipped.

## Submitted for 0.2.2

This is the text in the App Review Information notes field of version 0.2.2, and
the same substance went into the Google Play app access declaration, trimmed to
the 500 character limit that Play imposes there.

<!-- ASC_REVIEW_NOTES_START -->
```text
Cialai is a companion for the Cialai desktop terminal studio. It lets a person pair an iPhone with a computer they control, view terminal history, interact with an active terminal and browse project files allowed by the desktop.

There is no Ordinum account, no subscription and no server to configure, so there is no login credential to provide. When Cialai opens on the computer, it sets up its connectivity on its own.

How to reach every part of the app

1. Download the free Cialai desktop app at https://cialai.com.br and open it on a Mac, Windows or Linux computer. It needs no account.
2. In Cialai on the computer, choose Pair phone. The computer shows a pairing QR code.
3. Open Cialai on the test device, scan the QR code, check that the computer fingerprint matches and choose Pair.
4. When the computer shows a four digit approval code, confirm that the phone shows the same code and authorize the pairing on the computer.
5. Choose the computer in the Computers screen. A Direct or Backup badge shows the connection path in use. From another network the first connection can take a few moments while the backup connection gets ready.
6. Open a session to see terminal history, take over the terminal and browse the files the computer allows.

The pairing QR code rotates every 90 seconds, expires after 10 minutes and can be used only once, so generate a fresh code during the review. The app stores no permanent login credential.

Permission use

Camera access scans the pairing QR code and nothing else.
Local network access reaches a paired computer on the same network when one is available.
Face ID protects sensitive terminal actions. iOS performs the verification and the app does not receive biometric data.

Connectivity and encryption

Cialai uses only standard, published encryption for device connectivity: mutual TLS 1.3 between the paired devices, on the direct connection and inside the embedded open source Tor client. The phone tries the local network first, then a direct path over the internet, then an embedded Tor onion service as backup. Ordinum operates no server and receives no project or terminal content.

The in app web view is locked to the loopback address of the paired computer. It does not provide general web browsing.

Support contact during review: contato@ordinum.com.br
```
<!-- ASC_REVIEW_NOTES_END -->

Contact on the submission: Thiago Amorim, reachable at the private review email
recorded in App Store Connect. The sign in requirement is declared as false,
because the app has no account.

## Plan for a dedicated environment

### Copy for App Review

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
