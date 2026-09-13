# App Review Desktop Demo Runbook

Status: runbook prepared, review environment pending

This runbook creates the repeatable experience promised in the App Review notes. It does not authorize publishing, remote access changes or credential creation from this repository.

## Environment owned by the user

Prepare a dedicated computer and a dedicated operating system account with no personal data. Use a clean Cialai release candidate and a Headscale user reserved for review. Keep all remote access credentials outside the repository and enter them only in the private App Store Connect review field.

Record these values in the private release record:

| Field | Value |
| --- | --- |
| Cialai version | User records |
| Build number | User records |
| Source commit | User records |
| Operating system | User records |
| Headscale version | User records |
| Review desktop name | Review Mac |
| Availability window and time zone | User records |
| Support contact | User confirms |

## Fictional project

Create a folder named `cialai-review-demo` with no link to a real repository. Add only these files:

```text
README.md
welcome.txt
src/example.js
```

Use simple fictional content. The terminal history may show these commands:

```sh
pwd
printf 'Cialai review ready\n'
ls
```

Do not clone a customer project, reuse a developer home folder or copy saved terminal history.

## Desktop preparation

1. Install the exact signed candidate that will accompany the mobile build.
2. Complete onboarding and choose only `cialai-review-demo` as a project root.
3. Configure the dedicated Headscale server and the review user.
4. Name the computer `Review Mac`.
5. Open one terminal session named `Review` in the fictional project.
6. Run the three safe commands above and leave the session active.
7. Confirm that `welcome.txt` opens from the mobile file browser.
8. Confirm that Link phone creates a fresh QR code and shows an approval code.
9. Configure the computer to remain awake for the approved review window.
10. Verify the remote desktop access method from an external network.

## Rehearsal

Use a clean iPhone installation and perform the complete flow:

1. Reach the dedicated computer with the instructions prepared for the reviewer.
2. Generate and scan a fresh QR code.
3. Approve the matching four digit code.
4. Open `Review Mac` and the `Review` terminal.
5. Send `printf 'Hello from iPhone\n'` and confirm the result appears on both devices.
6. Open `welcome.txt` from Files.
7. Put the phone in airplane mode for 60 seconds and confirm recovery after reconnecting.
8. Revoke the phone from the desktop and confirm the removed state.
9. Pair again to prove that recovery does not depend on retained review state.

Record actual times and results in the printable mobile test sheet before submission. A rehearsal failure blocks the review package.

## Availability check during review

Check the following at the start and end of each day in the declared window:

- Computer powered on and Cialai running
- Headscale health endpoint responding
- Review session alive with only fictional content
- Remote desktop instructions still valid
- Support contact monitoring the confirmed channel
- No unexpected device present in the Headscale review user

Do not rotate credentials or update the candidate while a review is active unless the reviewer is notified through App Store Connect.

## Cleanup

After the review result, revoke all review phones, remove the review Headscale nodes, close the review terminal and rotate any remote access credential. Preserve only sanitized timing and result evidence.
