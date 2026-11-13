## Cialai {{version}} preview

The phone now leaves the Tor fallback within seconds when a direct path is back, terminals open faster on the phone, and the phone terminal bar has seven icon buttons. The phone apps are updated too.

**macOS is signed with the Ordinum Developer ID and notarized by Apple.** **The Windows installers are not signed with a code signing certificate yet**, so SmartScreen warns you before the first launch. In app updates are verified with the Cialai updater key on every system.

### What is new

* **Out of the fallback fast.** Stuck on Tor, the phone used to try the direct path once every 5 minutes. It now tries after 5, 10, 20 and 30 seconds and then once a minute, while Tor keeps carrying what is open, and switches as soon as the direct path answers. A network change, coming back to the app or learning a new address of the computer restarts the count.
* **A NAT punch with time to work.** The punch had 5 seconds in total and opening its control channel over Tor could take all of it. It now has 30 seconds.
* **Only the terminal on screen opens first.** The phone used to load the history of every session on open, 256 KiB each. It now loads the selected one, and the others when you open them.
* **Reconnect without the replay.** On reconnect the phone says how far it got and the computer sends only what is missing.
* **Path in the log.** `tunnel.log` on the computer records which path each device came in through, when it changed and why.
* **Seven button terminal bar.** Enter, Esc, Interrupt, Paste, Special keyboard, Quick commands and Message, icons only. Interrupt still sends Ctrl+C.
* **Special keyboard.** Enter on every tab, arrows at the bottom of every tab, and symbols with short captions for Tab, Shift Tab, Backspace and the arrows.
* **Broto uses renewed addresses at once.** A Broto saved the renewed addresses of the computer but kept dialing the old ones until restart.

Nothing in this preview was proven on a real phone before release; the fallback exit is proven by tests with a simulated clock. Leaving the fallback fast needs the phone app at 0.6.1, and the new bar and the faster terminal load arrive with the computer at 0.6.1, because the terminal page comes from it.

Broto has its own version, 0.2.1, and release tag `broto-v0.2.1`. Its Windows and Linux installers are separate from the Cialai host installers below. Visit https://cialai.com.br/broto for downloads. Connecting a Broto by QR needs Cialai 0.6.0 on the computer and on the phone and Broto 0.2.0.

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

The Android and iPhone apps are updated in this preview. `Cialai_android_universal.apk` is attached here and mirrored on the website, and the iPhone build is on TestFlight and in App Store review.

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
