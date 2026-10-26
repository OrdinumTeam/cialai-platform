## Cialai {{version}} preview

A quiet fix of Cialai for macOS, Windows and Linux, on top of 0.4.0. The account menu is picked with the arrow keys, and the session card shows the agent and the account again instead of the shell. The phone apps are unchanged.

**macOS is signed with the Ordinum Developer ID and notarized by Apple.** **The Windows installers are not signed with a code signing certificate yet**, so SmartScreen warns you before the first launch. In app updates are verified with the Cialai updater key on every system.

### What is fixed

* **Pick the account with the arrow keys.** Typing `codex` or `claude` with more than one account lists them; use the up and down arrows, or j and k, with the chosen one highlighted, and Enter opens it. A number from 1 to 9 still opens its account directly, and Esc cancels. Before only a number worked.
* **The card shows the agent and the account again.** After you pick the account, the session card shows Codex or Claude Code and the profile instead of the shell. The agent now runs in the shell itself, never in a subshell, and the card finds the agent even when a shell or a launcher leads the foreground group.
* **The tutorial teaches the arrows.** The account menu tutorial in the Agent profiles window shows the arrow keys instead of the number.

Earlier versions are listed at https://github.com/OrdinumTeam/cialai-platform/tree/main/docs/releases

### Which file to download

| Platform | File |
| --- | --- |
| macOS on Apple silicon | `Cialai_aarch64.dmg` |
| macOS on Intel | `Cialai_x64.dmg` |
| Windows 10 and 11 | `Cialai_x64-setup.exe` or `Cialai_x64.msi` |
| Debian, Ubuntu and derivatives | `Cialai_amd64.deb` |
| Fedora, openSUSE and derivatives | `Cialai_x86_64.rpm` |
| Other Linux distributions | `Cialai_amd64.AppImage` |

The Android and iPhone apps are unchanged in this preview and keep working with it. Android still gets `Cialai_android_universal.apk` from the site and iPhone the TestFlight build.

### Install

**macOS.** Open the DMG, drag Cialai to Applications, then open it and click Open on the first launch.

**Windows.** Run the setup or the MSI. On the SmartScreen warning click More info, then Run anyway.

**Linux.** `sudo apt install ./Cialai_amd64.deb`, `sudo dnf install ./Cialai_x86_64.rpm`, or make the AppImage executable with `chmod +x` and run it. The app updates itself in all three formats.

**macOS and Linux in one line.** `curl -fsSL https://cialai.com.br/install.sh | bash`

### Verify your download

`SHA256SUMS` lists the checksum of every file here.

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
```

Use `sha256sum` instead of `shasum -a 256` on Linux.

### Public networks and limits

Cialai runs no server of its own, and neither does Ordinum. The connection uses the Tor network as meeting point and backup, optional STUN servers from Cloudflare and Google, and DNS-SD on your local network.

The computer must be on with Cialai open. A network that blocks both Tor and UDP leaves the phone without a path, and the backup through Tor is slower than a direct connection.

### Report a problem

Open an issue at https://github.com/OrdinumTeam/cialai-platform/issues with your system, the file you installed and what happened.
