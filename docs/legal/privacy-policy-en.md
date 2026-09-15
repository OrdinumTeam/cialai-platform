# Cialai Privacy Policy

Effective date: September 15, 2026

Publication status: prepared for publication before the first public release

Cialai is an open source terminal studio provided by ORDINUM INOVACAO E TECNOLOGIA LTDA. This policy explains how the Cialai desktop and mobile applications handle information.

## Summary

Cialai does not provide an Ordinum account, advertising, analytics or a hosted application service. Ordinum does not collect project contents, terminal input, terminal output, pairing codes, device tokens or biometric data through Cialai.

The phone apps connect only to the user's own computer, through an end to end encrypted connection the computer sets up on its own, with no server run by the user, by Ordinum or by the project in the path. Ordinum does not receive, store or access terminals, files or traffic.

## Information processed on your devices

Cialai processes the following information only to provide its features:

- Project folders and files selected on the desktop
- Terminal input, output, session history and process information
- Git status and local previews
- Local reading of coding agent plan usage, from the files those agents write on the computer
- The computer's identity, with its Ed25519 keys, and the list of paired phones, so each one can be revoked
- Names and technical identifiers for paired computers and phones
- Connection state, network addresses and diagnostic logs

This information is stored locally, in the application's own data directories, and none of it is sent to Ordinum. The phone keeps the public key of each paired computer, received through the pairing QR code, the device's own key, which identifies it to the computer, and one token per paired computer, kept in the device's secure storage and restricted to it. Desktop device tokens are stored only as hashes. Pairing secrets are short lived and are not retained after use. A Headscale API key saved by an earlier preview is no longer used and can be deleted in the advanced diagnostics of the Devices screen.

## Device connectivity

Terminal content and project files move between devices only when the user opens a paired session. Communication between computer and phone is end to end encrypted with mutual TLS 1.3 on every path: on the local network, on the direct connection over the internet and on the Tor backup. There is no server run by the user, by Ordinum or by the project in the path.

The pairing QR code carries the computer's public key and works only once: it rotates every 90 seconds and expires after 10 minutes. Each phone has its own key and its own token, revocable one by one, and revocation drops the device's sessions on both paths.

The mobile app creates a loopback connection on the phone to display the desktop interface. That local connection does not leave the device. The camera is used only to scan a pairing code and nothing from it is stored. Biometric checks are performed by the operating system and Cialai does not receive the underlying biometric data.

## Public networks and third party services

For the devices to find each other, Cialai uses public networks, and each one sees only what is described below:

- **Tor network.** The computer publishes a built in onion service, which works as the meeting point and the backup connection. Tor relays carry only encrypted traffic. Because this onion service is single hop to reduce latency, the introduction and rendezvous relays may see the computer's IP address, never the content.
- **Public STUN servers from Cloudflare and Google.** They are optional and help discover the computer's public address. When STUN is used, those servers see the computer's public IP address.
- **DNS-SD on the local network.** The announcement publishes an identifier derived from the computer's public key, without the person's name.
- **The user's router.** When the router allows it, the computer requests a port mapping through UPnP, NAT-PMP or PCP.

When a desktop user manually checks for an application update, the desktop app requests the signed release manifest and package from GitHub Releases. GitHub may process standard request metadata under its own privacy terms. Ordinum does not receive that request metadata from Cialai.

## Sharing and sale

Ordinum does not sell personal information. Cialai does not share project contents or terminal content with Ordinum or advertising partners. Content travels only between the devices paired by the user, end to end encrypted, including when it crosses the public networks described above.

## Retention and deletion

Local preferences, session history, identities and paired computers remain on the device until the user removes them or uninstalls the application. Users can revoke a paired device from the desktop and forget a computer from the mobile app. Because no Ordinum or project server takes part in the connection, there is no connection data to delete with Ordinum. To erase what the application keeps, remove the application or its data directories.

## Permissions

The mobile app may request camera, local network and biometric permissions. Camera access scans pairing codes. Local network access finds the paired computer before the phone uses the connection over the internet. Biometric access protects sensitive terminal actions. Denying a permission limits the related feature.

## Children

Cialai is a developer tool and is not directed to children.

## Changes

Material changes to this policy will be published with a new effective date. Store privacy answers will be reviewed whenever application behavior or included third party code changes.

## Contact

Privacy contact: **TO BE CONFIRMED BEFORE PUBLICATION**

Until the dedicated contact is confirmed, use the private contact route described in the repository `SECURITY.md` file.
