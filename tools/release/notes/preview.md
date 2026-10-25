## Cialai {{version}} preview

A preview of Cialai for macOS, Windows and Linux. Agent profiles get their own window and the terminal asks which account to use, the file explorer moves close to the VS Code one, and every agent card shows only the state of its own session. The phone apps are unchanged: the phone page comes from the computer, so updating the computer is enough.

**macOS is signed with the Ordinum Developer ID and notarized by Apple.** **The Windows installers are not signed with a code signing certificate yet**, so SmartScreen warns you before the first launch. In app updates are verified with the Cialai updater key on every system.

### What is new

* **Agent profiles.** One window gathers the Codex and Claude Code accounts with the quota of each one and, beside them, an animated tutorial of how to switch accounts. A new account copies the instructions and the configuration of the default one and opens the login in a new session. It opens from the command palette, the app menu, Preferences and the terminal accounts.
* **The right account when you open the agent.** In sessions opened by Cialai, typing `codex` or `claude` with more than one account lists them with their quota. Enter repeats the last account used in that folder, a number switches, an exhausted account is skipped and `codex +name` goes straight to one. It works in zsh, bash and PowerShell.
* **Cut, copy and paste in the explorer.** From the menu and the keyboard, as in VS Code. Pasting into a folder with a file of the same name picks a free name and never overwrites.
* **Multiple selection.** Cmd or Ctrl adds one file at a time, Shift selects a range and Cmd A selects everything. Cut, copy, copy path and move to Trash work on the whole selection, with the count in the dialog.
* **Undo and redo.** Cmd Z undoes rename, move, copy and create, and Cmd Shift Z redoes. Moving to Trash still goes to the system Trash. F2 renames.
* **Several files out of the app.** Dragging a selection hands every file to Finder, a folder or WhatsApp.
* **The open file shows in the tree.** Opening a file in the editor reveals and highlights where it is in the explorer.
* **Each card with the state of its own session.** With several Codex sessions in the same folder the cards used to show the same state, such as Answer delivered. Now each one reads what Codex writes in its own terminal, and the card shows Waiting for you when Codex asks for permission. The AI Bar lists every Codex conversation in progress.
* **Aligned buttons on the empty screen.** New session and Pair phone sit on the same line with space between them, also when a narrow window wraps them.

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
