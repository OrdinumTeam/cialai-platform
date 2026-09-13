# Security Policy

## Supported versions

Cialai has no supported public release yet. The repository contains prerelease code and preparation for version 1.0.0. Security fixes are applied to the current `main` branch while release support is being defined.

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

Do not test against another person's device, computer or Headscale server. Use infrastructure and accounts you are authorized to control.

## Response expectations

The acknowledgment target and remediation timeline are **TO BE CONFIRMED BEFORE PUBLICATION**. The project will not advertise an unverified deadline. A maintainer will confirm a private communication path before requesting additional evidence.

## Scope notes

Cialai handles terminal input, terminal output and project files across paired devices. Reports involving authentication, pairing replay, device isolation, local proxy access, bridge command authorization, update signatures or secret storage are especially important.

The self hosted Headscale service remains under the operator's control. Vulnerabilities in Headscale or Tailscale components should also be reported to their upstream maintainers when appropriate, after coordinating disclosure for any Cialai specific impact.
