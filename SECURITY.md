# Security Policy

## Supported versions

Cialai has no supported stable release yet. Preview builds are published on cialai.com.br and the repository contains preparation for version 1.0.0. Security fixes are applied to the current `main` branch while release support is being defined.

## Reporting a vulnerability

Security contact: **TO BE CONFIRMED BEFORE PUBLICATION**

Until the dedicated contact is confirmed, use GitHub private vulnerability reporting when it is enabled for this repository. If it is unavailable, contact an Ordinum maintainer through a private channel listed on their GitHub profile and ask for a secure reporting route.

Do not disclose a vulnerability in a public issue. Do not include credentials, pairing QR payloads, device tokens, private files or unredacted logs in any report.

Please include:

- The affected revision and platform
- A concise description of the impact
- Reproduction steps using test data
- Sanitized logs or screenshots
- Any suggested mitigation

Do not test against another person's device or computer, and do not attack the public Tor network or STUN servers. Use devices, networks and accounts you are authorized to control.

## Response expectations

The acknowledgment target and remediation timeline are **TO BE CONFIRMED BEFORE PUBLICATION**. The project will not advertise an unverified deadline. A maintainer will confirm a private communication path before requesting additional evidence.

## Scope notes

Cialai handles terminal input, terminal output and project files across paired devices. Reports involving authentication, pairing replay, device isolation, local proxy access, bridge command authorization, update signatures or secret storage are especially important.

## Connectivity threat model

Since the 0.2.0 preview the computer and the phone connect without any server run by the user, by Ordinum or by the project. The summary below lists what the design protects and what it does not.

| Asset or threat | Design |
| --- | --- |
| Device identity | Each computer and each phone has its own Ed25519 key. The phone pins the desktop key carried in the pairing QR code |
| Traffic between devices | Every session uses mutual TLS 1.3, on the direct QUIC path and inside the Tor network. Tor relays and STUN servers never see terminal content |
| Unpaired devices | A key that is not registered gets a restricted session that only reaches `POST /pair`, only while a pairing code is active, with at most four such sessions living 60 seconds each |
| Pairing code theft | The `CIALAI2.` QR rotates every 90 seconds, expires after 600 seconds, carries a one time secret, allows 5 attempts per minute and locks after 10 wrong secrets. Approval by code on the computer is optional |
| Device credentials | One `cdt1` token per phone, stored as a hash on the computer and in secure storage on the phone, rotated every 30 days. The browser page never receives it |
| Lost or stolen phone | Revocation on the computer closes the phone sessions on both transports and the bridge closes its sockets with code 4401 |
| Local network exposure | The direct listener accepts only mutual TLS sessions. The DNS-SD `_cialai._udp` announcement uses a name derived from the key fingerprint and never the computer name |
| Location privacy | Not provided. The desktop onion service is single hop and non anonymous; it exists for reachability, not to hide the computer |
| Availability | Not guaranteed. The computer must be on with Cialai open, networks that block both Tor and UDP leave no path, and the Tor backup is slower than a direct connection |

The Tor Expert Bundle, tor-android and Tor.framework are third party components. Vulnerabilities in Tor or in other upstream components should also be reported to their maintainers when appropriate, after coordinating disclosure for any Cialai specific impact.

The Headscale mode of the 0.1.x previews remains in the repository only as inert code until device validation of the new connectivity. `infra/headscale` is kept as history and is not part of the product path.
