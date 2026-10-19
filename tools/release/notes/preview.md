## Cialai {{version}} preview

A preview of Cialai for macOS, Windows, Linux, Android and iOS. The desktop takes on the visual language of the phone, every session gets its own colour and icon everywhere, and the phone tells you when a session needs you.

**macOS is signed with the Ordinum Developer ID and notarized by Apple.** **The Windows installers are not signed with a code signing certificate yet**, so SmartScreen warns you before the first launch. In app updates are verified with the Cialai updater key on every system.

### What is new

* **The desktop speaks the phone's visual language.** Solid surfaces, rounded corners and separation by tone, with no gradients, glass or glow. The sidebar stays pink, light in the light theme and plum in the dark one. Buttons, fields, menus and colour changes share the same short animation.
* **The session colour leads what belongs to the session.** The card bar, the icon, the agent name, the usage percentage, buttons, focus, the terminal cursor and selection, the palette entry, the on screen notice and the AI Bar follow the chosen colour. Without a colour everything stays Cialai pink. Warning and error colours, ANSI colours and the output of the CLIs never change.
* **An icon per session.** Thirty icons, picked together with the colour when the session is created or from Colour and icon. The icon sits next to the name on the card and in the header, on the computer and on the phone. Without a choice it shows the agent running there or a terminal.
* **The weekly limit in the AI Bar.** The outer ring is the 5 hour session and the inner ring is the weekly window, drawn with the same stroke. An account without a weekly limit and a reading that has not arrived yet look different from 0%. The tooltip and the screen reader name the window, the usage and the reset.
* **New usage bands.** Amber from 60% and red from 80%, on the computer, on the phone page and in the app. Anyone still on the old 50 and 70 defaults moves to the new ones once.
* **The official signature.** The brand with the website lettering appears in the sidebar, the splash and the loading screen. With the sidebar closed, the lettering shows small in the toolbar.
* **Four keys always in sight on the phone.** The terminal bar shows Enter, Esc, Ctrl C and Ctrl V, and the arrow still opens the special keyboard. Anyone who had picked their own keys keeps them.
* **Attention notices on the phone.** The terminal bell, a notice sent by the program, a finished command, an agent waiting for you or asking for permission and a finished answer become a notice with the session name and colour. Tapping it opens the session. Turn it on in Settings, under Sessions asking for attention. Notices are local: they go out while the app has the terminal open and shortly after it moves to the background.
* **The native app keeps pace.** Home and the Agents tab show the weekly window, the sessions of a folder show their colour and icon, the official brand replaces the old symbol and icons lost their background plates.
* **Update the computer and the phone together.** The phone page is served by the computer and carries the attention, colour and icon of each session; a new app with an older computer works, without attention notices.

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
