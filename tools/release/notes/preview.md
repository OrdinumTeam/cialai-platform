## Cialai {{version}} preview

A Broto now connects from the phone by QR, the documentation graph gains six views, and session cards collapse to one line. The phone apps are updated too.

**macOS is signed with the Ordinum Developer ID and notarized by Apple.** **The Windows installers are not signed with a code signing certificate yet**, so SmartScreen warns you before the first launch. In app updates are verified with the Cialai updater key on every system.

### What is new

* **Broto from the phone.** The Broto window shows a QR code, valid once and for ten minutes. On the phone, the three dot menu of a computer gains Connect a Broto, which reads it with the camera. The computer publishes a temporary onion and a mark on the local network, and the Broto dials as always: nothing listens on the Broto and the phone never talks to it. The phone shows the Broto name and four digits, and you type the same digits on the Broto, so a photo of the QR is not enough to pair another machine. Pasting a code still works.
* **Six graph views.** A selector in the graph bar switches between Map, Tree, Radial, Blocks, Neighbors and 3D. Blocks sizes each file by its bytes, Neighbors shows one file with the files it links to and the ones that link to it, up to three steps away, and 3D turns with a drag on the same canvas, without WebGL.
* **Links between files.** The options panel reads the documentation or the whole project, up to 20,000 files, and draws Markdown links and wikilinks and the imports of JavaScript, TypeScript, CSS, HTML, Python, Rust and Go. The next scan only reads what changed.
* **Graph colours.** Colour by group, folder, file type, size, date of change or rules of your own, in four palettes: Safe, the default, tested for colour blindness, Neon, Pastel and Monochrome.
* **Collapsible session cards.** A card collapses to its icon, name and activity dot, one by one or all at once, and Preferences can make new cards join collapsed.
* **Folder looks.** A folder remembers the colour and the icon last chosen for a session in it.
* **Terminal theme.** The terminal can be light or dark on its own, apart from the window.
* **More formats in the editor.** Audio, video, fonts and read only Jupyter notebooks, plus highlighting for `.env`, ignore files, Makefile and shell profiles.
* **Windows terminal size.** The terminal no longer goes back to an old size after maximizing, opening a panel or changing the font. A Windows 11 virtual machine reproduced the old behaviour with an earlier build and showed this one keeping the size. It has no real GPU, so long use on a Windows machine with one is still the final proof of the WebGL part.
* **Window buttons on Wayland.** On Linux with Wayland the title bar buttons follow the side and order set in GNOME or KDE.
* **One button per side column.** The edge rail is the only way back for a collapsed column.

Broto has its own version, 0.2.0, and release tag `broto-v0.2.0`. Its Windows and Linux installers are separate from the Cialai host installers below. Visit https://cialai.com.br/broto for downloads. Connecting a Broto by QR needs Cialai 0.6.0 on the computer and on the phone and Broto 0.2.0.

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
