# Cialai Privacy Policy

Effective date: September 13, 2026

Publication status: prepared for publication before the first public release

Cialai is an open source terminal studio provided by ORDINUM INOVACAO E TECNOLOGIA LTDA. This policy explains how the Cialai desktop and mobile applications handle information.

## Summary

Cialai does not provide an Ordinum account, advertising, analytics or a hosted application service. Ordinum does not collect project contents, terminal input, terminal output, pairing codes, device tokens or biometric data through Cialai.

Cialai connects devices through a Headscale server selected and operated by the user or their organization. The operator of that server is responsible for its infrastructure and logs.

## Information processed on your devices

Cialai processes the following information only to provide its features:

- Project folders and files selected on the desktop
- Terminal input, output, session history and process information
- Git status and local previews
- Names and technical identifiers for paired computers and phones
- Connection state, network addresses and diagnostic logs
- Headscale configuration and credentials provided by the user

This information is stored locally where needed. Headscale API keys use the operating system credential store on desktop. Device tokens use secure storage on mobile. Desktop device tokens are stored only as hashes. Pairing secrets are short lived and are not retained after use.

## Device connectivity

Terminal content and project files move between devices only when the user opens a paired session. Traffic between paired devices is encrypted end to end. Headscale coordinates device discovery but cannot read that encrypted content. A relay may forward encrypted packets when a direct path is unavailable.

The mobile app creates a loopback connection on the phone to display the desktop interface. That local connection does not leave the device. The camera is used only to scan a pairing code. Biometric checks are performed by the operating system and Cialai does not receive the underlying biometric data.

## Services chosen by the user

The user provides the Headscale server address and is responsible for the server operator's privacy practices. A self hosted server may retain administrative logs such as connection time, device name and network address according to its configuration.

When a desktop user manually checks for an application update, the desktop app requests the signed release manifest and package from GitHub Releases. GitHub may process standard request metadata under its own privacy terms. Ordinum does not receive that request metadata from Cialai.

## Sharing and sale

Ordinum does not sell personal information. Cialai does not share project contents or terminal content with Ordinum or advertising partners. Data travels only to devices and infrastructure chosen by the user to perform the requested connection.

## Retention and deletion

Local preferences, session history and connection profiles remain on the device until the user removes them or uninstalls the application. Users can revoke a paired device from the desktop and forget a profile from the mobile app. Headscale operators control retention and deletion on their own servers.

## Permissions

The mobile app may request camera, local network and biometric permissions. Camera access scans pairing codes. Local network access finds the paired computer. Biometric access protects sensitive terminal actions. Denying a permission limits the related feature.

## Children

Cialai is a developer tool and is not directed to children.

## Changes

Material changes to this policy will be published with a new effective date. Store privacy answers will be reviewed whenever application behavior or included third party code changes.

## Contact

Privacy contact: **TO BE CONFIRMED BEFORE PUBLICATION**

Until the dedicated contact is confirmed, use the private contact route described in the repository `SECURITY.md` file.
