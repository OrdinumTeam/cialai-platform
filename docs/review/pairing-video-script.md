# Pairing Review Video Script

Status: script prepared, recording pending

Goal: show the complete pairing and first terminal interaction with fictional data in no more than 90 seconds.

## Recording setup

- Use the dedicated environment from `desktop-demo-runbook.md`.
- Record the desktop at 1920 by 1080 pixels.
- Capture the physical iPhone screen at native resolution.
- Place desktop and phone side by side in the final frame.
- Hide notifications, menu bar account names, network names and personal status details.
- Use the `cialai-review-demo` folder and the `Review` terminal only.
- Record a fresh pairing and revoke that phone immediately after export.

## Shot list

| Time | Desktop | iPhone | Caption |
| --- | --- | --- | --- |
| 0 to 5 seconds | Cialai open on the Review session | Cialai welcome screen | Cialai connects your phone to a computer you control |
| 5 to 15 seconds | Choose Link phone and show Review Mac | Open the scanner | Start a short lived pairing from the desktop |
| 15 to 27 seconds | Show the QR code and approval area | Scan the QR code and show the matching computer | Scan once to identify the two devices |
| 27 to 38 seconds | Approve the matching four digit code | Show Review Mac as connected | Confirm the code before granting access |
| 38 to 52 seconds | Keep the Review terminal visible | Open Review and show existing history | The phone receives the current terminal history |
| 52 to 67 seconds | Show the new command and output | Type `printf 'Hello from iPhone\n'` | Terminal input and output stay synchronized |
| 67 to 77 seconds | Keep Files open beside the terminal | Open `welcome.txt` | Only allowed project files are available |
| 77 to 87 seconds | Revoke the phone | Show the removed state | Access can be revoked from the desktop |
| 87 to 90 seconds | Show the Cialai wordmark | Show the Cialai wordmark | Your terminals on your devices |

## Voiceover

```text
Cialai pairs your phone with a computer you control. Start a short lived pairing on the desktop, scan the code and confirm the matching digits. Your active terminal history appears on the phone. Commands stay synchronized, and allowed project files remain available when you step away. Revoke a device from the desktop whenever access should end.
```

## Evidence and safety gate

Do not pause on the QR code longer than needed. The recording still contains a credential even when it expires, so use an isolated review user and revoke the device after capture. Inspect every frame for personal data and private paths before upload.

Record the following with the final file:

| Field | Value |
| --- | --- |
| Video filename | User records |
| Duration | User records |
| Mobile version and build | User records |
| Desktop version | User records |
| Source commit | User records |
| Recording date | User records |
| Device revoked after capture | User confirms |
| Reviewer | User records |
