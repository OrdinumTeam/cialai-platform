## Cialai {{version}} preview

An early preview of Cialai for macOS, Windows, Linux, Android and iOS. Expect rough edges.

**macOS is signed with the Ordinum Developer ID and notarized by Apple.** **The Windows installers are not signed with a code signing certificate yet**, so SmartScreen warns you before the first launch. In app updates are verified with the Cialai updater key on every system.

### What is new

* **Studio dialogs are sized by their content again.** Pair phone, Preferences, agent accounts and the revoke confirmation no longer take the full width of their breakpoint, the body scrolls inside, and the application behind keeps its dimensions.
* **The documentation graph reads a document beside the map.** Preview opens the rendered Markdown in a panel next to the graph, split in half and resizable, and one explicit action moves it to a window of its own.
* **The phone gets the whole screen back after the keyboard closes.** The shell follows the visible area at all times, so the native done button, a closed composer and a return from the background no longer leave a grey band under the terminal.
* **The agent accounts have a door of their own,** next to the sessions on the computer, and a card layout that fits the width of a phone.
* **Claude Code shows the plan and the usage percentage** that Codex already showed, on the accounts screen and on the session cards, with the name of the window beside each percentage and a clear state when there is no reading.

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
| Android 8 or newer | `Cialai_android_universal.apk` |

On iPhone the preview goes through TestFlight, so there is no file to download.

### Install

**macOS.** Open the DMG, drag Cialai to Applications, then open it and click Open on the first launch.

**Windows.** Run the setup or the MSI. On the SmartScreen warning click More info, then Run anyway.

**Linux.** `sudo apt install ./Cialai_amd64.deb`, `sudo dnf install ./Cialai_x86_64.rpm`, or make the AppImage executable with `chmod +x` and run it. The app updates itself in all three formats.

**Android.** Download the APK on the phone, allow installing unknown apps when Android asks, then open it.

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
