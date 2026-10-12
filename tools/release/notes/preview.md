## Cialai {{version}} preview

An early preview of Cialai for macOS, Windows, Linux, Android and iOS. Expect rough edges.

**macOS is signed with the Ordinum Developer ID and notarized by Apple.** **The Windows installers are not signed with a code signing certificate yet**, so SmartScreen warns you before the first launch. In app updates are verified with the Cialai updater key on every system.

### What is new

* **A native phone Home, with Projects and Agents tabs.** The app opens on one usage card per agent with the account in use, your computers, your favourite projects and quick actions. Agents lists every account of both agents, the one in use first, and Projects shows the folders as a grid or as a list, with the choice kept on the device.
* **A device keyboard button in the phone terminal bar.** It opens and closes the keyboard without touching the terminal. Esc, Tab and Paste stay in the bar, and the special keys moved to an expand button.
* **One header in the phone session.** The shell hides its computer bar while a terminal or the files are open. The new session flow and Settings are more compact.
* **No more blank page while the terminal loads.** The phone shows a loading screen until the computer page answers, and the page says Opening the terminal until the session is ready.
* **Local notices** for a finished session and for a usage limit close to its end, switched on one by one in the phone Settings.
* **The phone keeps what the computer sent.** The snapshot with accounts, projects and sessions only goes out while the bridge is connected and follows each reconnection. Without a paired computer the tabs that depend on one are locked.
* **Each terminal card shows its own conversation.** The Claude Code model, context and cost are matched by the conversation id of each terminal, so terminals in the same folder no longer show the same reading.
* **The sessions column fits narrow windows.** Below 230 px the agent row wraps and the chips truncate with an ellipsis. In the header the session name shrinks first and the path gives way last.
* **Agent accounts in one list,** on the computer and on the phone, with the agent glyph on every row and a new profile button per agent.
* **The keyboard works on Windows.** The window kept asking the WebView2 for focus on every focus event, which the WebView2 itself raises on Windows, so no key ever landed. The terminal also gets its colours and font back, `claude` and `codex` are found right after installing, and clicking back into the terminal no longer leaves `[I` on the command line.
* **The Linux pairing dialog says what stopped.** Instead of Preparing the connection forever, it shows the real error, where the `app.log` is and a diagnostics button. An identity key with open permission bits is repaired instead of killing the tunnel.
* **The iPhone app opens again.** It adopts the UIScene lifecycle required by the iOS 27 SDK.
* **The terminal bar, the loading screen, the snapshot fix and the accounts list are served by the computer,** so the phone shows them once the desktop app is updated.

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
