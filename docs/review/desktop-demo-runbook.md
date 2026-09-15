# App Review Desktop Demo Runbook

Status: runbook prepared, review environment pending

This runbook creates the repeatable experience promised in the App Review notes. It does not authorize publishing, remote access changes or credential creation from this repository.

## Environment owned by the user

Prepare a dedicated computer and a dedicated operating system account with no personal data. Use a clean Cialai release candidate. The candidate brings its connectivity up on its own, so the review needs no Headscale server, coordination server, account or address to type. Keep all remote access credentials outside the repository and enter them only in the private App Store Connect review field.

Record these values in the private release record:

| Field | Value |
| --- | --- |
| Cialai version | User records |
| Build number | User records |
| Source commit | User records |
| Operating system | User records |
| Advanced diagnostics result | User records |
| Review desktop name | Review Mac |
| Availability window and time zone | User records |
| Support contact | User confirms |

## Network mode

The review uses the real automatic connectivity of the signed candidate, the only network mode of the product since the 0.2.0 preview. When Cialai opens, the computer starts:

- An Ed25519 identity for the computer and for each phone
- A direct QUIC listener on UDP port 4740, or a free port when that one is taken, that accepts only mutual TLS 1.3 sessions
- A port mapping through UPnP, NAT-PMP or PCP when the router allows
- Optional STUN requests to public Cloudflare and Google servers
- A DNS-SD `_cialai._udp` announcement on the local network
- An embedded single hop Tor onion service as meeting point and backup

The phone tries the local network first, then the direct path over the internet, then the backup through Tor, and from the backup it keeps trying to move to a direct path. The Devices screen and the phone show a Direct or Backup badge for each connection. Networks that block both Tor and UDP leave the phone with no path, and the backup is slower than a direct connection.

The interface demo mode, opened in a browser on the desktop Vite server with `?terminais=demo&tunnel=demo`, only simulates the sidecar, the Tor bootstrap and pairing with fictional data. It runs no sidecar, no Tor and no real phone, so it helps rehearse screens and captures but never replaces the review computer.

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
3. In the Phone access section of Preferences, set the computer name to `Review Mac` and turn on Confirm each new phone and Keep active during remote use.
4. Open one terminal session named `Review` in the fictional project.
5. Run the three safe commands above and leave the session active.
6. Open the advanced diagnostics of the Devices screen, run the checks and confirm that they pass with the direct listener ready and the onion service published.
7. Confirm that `welcome.txt` opens from the mobile file browser.
8. Confirm that Pair phone creates a fresh QR code and shows an approval code when a phone scans it.
9. Configure the computer to remain awake for the approved review window.
10. Verify the remote desktop access method from an external network.

## Rehearsal

Use a clean iPhone installation and perform the complete flow:

1. Reach the dedicated computer with the instructions prepared for the reviewer.
2. With the iPhone on a cellular connection or on a network other than the computer's, generate and scan a fresh QR code.
3. Approve the matching four digit code.
4. Open `Review Mac` and the `Review` terminal and record whether the badge shows Direct or Backup.
5. Send `printf 'Hello from iPhone\n'` and confirm the result appears on both devices.
6. Open `welcome.txt` from Files.
7. Put the phone in airplane mode for 60 seconds and confirm recovery after reconnecting.
8. Revoke the phone from the desktop and confirm the removed state.
9. Pair again with the iPhone on the computer's local network to prove that recovery does not depend on retained review state and that the local path works.

Record actual times and results in the printable mobile test sheet before submission. A rehearsal failure blocks the review package.

## Availability check during review

Check the following at the start and end of each day in the declared window:

- Computer powered on and Cialai running
- Advanced diagnostics checks passing, with the onion service published
- Review session alive with only fictional content
- Remote desktop instructions still valid
- Support contact monitoring the confirmed channel
- No unexpected device on the Devices screen

Do not rotate credentials or update the candidate while a review is active unless the reviewer is notified through App Store Connect.

## Cleanup

After the review result, revoke all review phones, close the review terminal and rotate any remote access credential. Preserve only sanitized timing and result evidence.
