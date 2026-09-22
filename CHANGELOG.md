# Changelog

All notable changes to Cialai will be documented in this file.

The format follows Keep a Changelog, and the project intends to use Semantic Versioning after its first public release.

## Unreleased

### Added

* A cross platform Tauri desktop application for project workspaces, terminal sessions, files, previews, Git tools and local integrations
* A Go tunnel sidecar that pairs desktops and mobile devices and connects them directly or through an embedded Tor onion service, with no server to host
* Expo shells for iOS and Android with QR pairing, protected local profiles and biometric session locking
* Signed update support prepared for desktop releases
* Automated checks for the desktop, shared interface, tunnel protocol, mobile shell and release documentation
* An AppImage smoke test that opens the Linux app under Xvfb on Ubuntu 24.04 and Arch Linux with the system Mesa, WebKitGTK and GVfs
* The phone Home ends with the community rooms. Two buttons, Discord and WhatsApp, open the same invitations the website publishes, in the system browser. The addresses live in `apps/mobile/src/config/community.ts` as data, never as dictionary text, and only a public https invitation is accepted. The brand marks are generated from the official path by `tools/brand/build-community-glyphs.mjs` and tinted by the palette, so one file serves both themes
* A performance budget, `npm run check:performance`, measured on a computer simulated four times slower and over the production build. It records how long the studio takes to become usable, the payload of the first paint, the long tasks and the frame rate of the animated sheet, compares them with a versioned baseline and prints the change. Passing it by turning animation off is impossible: the animation scenario runs with motion on and the check asserts the sheet still animates
* The application icon and every brand mark are generated, not drawn by hand. `tools/brand/build-app-icons.mjs` writes the three icon sources and the interface mark from the white and the black master, and `tools/brand/build-site-brand.mjs` writes the brand files of the website, each one at the exact size of the file it replaces so no page markup has to change. The gate cross reads the gradient ends and the symbol height from the generator, so the files and the code cannot drift apart
* A `cialai` command in the terminal. The app writes it on first launch and checks it on every launch, so it repairs itself when the application moves. It only opens Cialai, with no arguments and no subcommands. On macOS and Linux it lands in `~/.local/bin` and the app never edits a shell file: when the folder is outside the PATH, Preferences shows the exact line to paste. On Windows it lands in `%LOCALAPPDATA%` and the folder is added to the user `Path` in the registry, read without expanding so `%USERPROFILE%` entries survive. A file with that name that is not ours is never overwritten or deleted, and removing the command from Preferences keeps it removed

### Fixed

* The phone page served to the mobile apps was missing the shell design tokens: text fell back to the system serif font, buttons had no background and neither theme applied. The page now activates the same visual layer the desktop uses, follows the device font and the appearance chosen in the app, and no longer repeats the computer name and transport that the native bar already shows
* The phone terminal keys row is wrapped so every key is visible, with a single scrolling row only while the software keyboard is open. Terminal, files and new session actions are labelled buttons with a visible background
* The phone terminal no longer blinks: the WebGL renderer is off on the phone, the page is no longer reloaded by pull to refresh, losing the terminal lease dims the view instead of blanking it, and the desktop keeps a remote lease for 45 s instead of 15 s
* The mobile app no longer drops a working connection because one health probe was slow over the backup: it needs two consecutive failures, confirms with the tunnel core and a longer probe before reopening the proxy, and pairing shows the elapsed time, explains the backup delay and can be cancelled
* The pairing dialog kept resetting the ten minute validity at every code rotation. The window now starts once, each rotated code carries the remaining time, and the dialog says when it expired. The duplicated pairing shortcut in the Devices toolbar was removed
* Session cards show the model, the context window used and the estimated cost of the Claude Code session, and offer to install the status line hook from the card or from Preferences when it is missing
* Session activity now says what is actually happening. The desktop publishes the agent turn, read from the files each agent writes, and the age of the last PTY output, and the interface derives label, tone and animation from a single pure function. An agent that already answered shows Answer delivered with a still dot instead of animating until you quit it, an idle `ssh` or `python` prompt shows Process open, and a quiet process never turns into finished. The phone terminal header gained the indicator it never had
* Sessions no longer look busy or disconnected after the connection drops and comes back. Activity evidence is invalidated when the bridge falls, replayed history no longer counts as new output, and a parked session with a live PTY gets its state from the desktop without being reattached, so the list corrects itself in one poll without opening every terminal
* The studio gained a documentation graph. A tab in the central area draws every Markdown file of the session folder, and only the folders that lead to them, as a navigable force graph: a project with a thousand folders and documentation in ten areas shows ten areas and the paths to them, nothing else. It opens from the work area header, from ⇧⌘D, from the command palette or from Show in the documentation graph in the explorer context menu, and it opens documents in the same editor, reveals them in the same explorer and refreshes through the same file watchers. The scan reads paths and metadata only, never file contents, and never follows a symbolic folder
* Agent accounts can now be switched from the interface, with no command typed into a terminal. A screen lists every Claude Code and Codex profile found on the computer with its plan and window usage, marks the one in use and offers to use another one for new sessions; it opens from the phone session list and from Preferences on the computer. A new terminal is born with that account's variables, a running task stays on the account it started on, and an already open terminal gets a menu action that opens the agent on the chosen profile instead. Creating a profile makes an empty private folder and opens a terminal on it so the CLI itself can log in. Cialai only chooses which folder the agent uses: it never moves `auth.json`, never copies a credential and never reads one
* A collapsed side column no longer disappears without a trace. The rail that brings it back is 28 px wide, clickable along its whole length, and shows what is hidden: the session count with a pending attention badge on the left, the Git change count on the right. The work area header also gained two always visible toggles, sessions on the left and files on the right, and the first time each column collapses a notice says where to reopen it
* The mobile app now always opens on the Home screen, even when the last computer answers. Home is the hub: the Continue card reaches the terminal in one tap, and Computers, Pair and Settings are there without going through the terminal first. Nothing connects before that tap, and the mark the old launch rule kept in the secure store is deleted once
* The phone gained the terminal actions the desktop already had. A three dot button on every card, and a long press as a shortcut, open a bottom sheet with rename, subtitle, color, pin, move up and down, new session in this folder, change folder, copy path, restart and close; the open terminal header now opens the same menu instead of a lone power icon. Card presentation became server owned with a revision per write, so a name given on the phone is no longer erased by the computer's next save
* The folder picker can now reach folders it could not reach before. Each project root offers itself, so a session can open in the root instead of only in its subfolders, and a browse mode with a trail, Folder above, Use this folder and tap to descend covers the rest of the disk within the limits the computer sets. It answers over a new `list_dirs` command that returns folder names only, never file contents, and refuses `..`, relative paths, symbolic links, hidden folders and anything outside the home tree, the project roots and the mounted volumes
* The phone terminal gained a floating composer. A bubble over the terminal opens a native text box where a long instruction can be written, corrected and reviewed with the device keyboard, selection, clipboard, autocorrect and dictation. Enter inside the box always breaks a line, and the text only reaches the terminal through Insert, which writes it and stops there, or Send, which writes it and only then sends Enter as a separate write. A multi-line text going to a program without bracketed paste asks for a second confirmation, and the draft survives closing the box
* Windows paths now follow one contract on both sides. The Rust side sends every path with forward slashes, including the process working directory and the session folder, and announces the same separator; the interface normalizes the only other door, the system dialog, at the boundary. Going up from `C:/Users` reaches the drive root instead of an invalid `C:`, folders compare without case on a file system that ignores it, dropping a file from Explorer works, and the explorer no longer keeps switching roots
* A desktop window that fails to paint is no longer a dead rectangle. The startup safety net now acts on a positive signal from the interface instead of on window visibility, which never triggered because every window is created visible; after the deadline the window grows, becomes resizable again and, with no frame of its own, gets the system one so it can be moved and closed. The page also ships a static first paint with the brand background and a drag region, platform detection races a deadline instead of blocking the mount, and a failure to start the phone page, the bridge or the tunnel supervisor is recorded and degraded instead of killing the app
* Opening the studio no longer downloads four megabytes of brand artwork. The sidebar, the splash and the first run imported the 4096 px master to draw the mark at 20, 52 and 64 px, which was 87% of everything fetched before the first paint. They now use a 256 px derivative generated from the same master, with the same framing, so nothing changes on screen: the first paint went from 4601 KB to 615 KB
* Collapsing a side column is one button again. The headers of the sessions and the files columns each carried a collapse button with the same icon, the same label and the same shortcut as the toggle in the work area header, and the two sat side by side across the divider. The one in the work area header stayed, because it also brings the column back and reports its state
* Desktop dialogs no longer depend on styles injected at runtime to have a size. The width and the height ceiling of the sheet now live in the application stylesheet, so a failure to inject the emotion styles no longer leaves the sheet spread across the window with its content cut off at the top and the bottom. The sections inside a dialog also stopped measuring the window: on a 880 px window the pairing sheet used to collapse the QR code into a single column with the full 700 px of the sheet available, and grew from 463 to 660 px tall. Two new gates cover this, one over the production stylesheet and one in the browser over the production build, with twelve accounts on screen
* Desktop dialogs no longer depend on styles injected at runtime to be positioned either. In the installed 0.2.7 the pairing sheet appeared at the bottom corner of the window, in the document flow, with no scrim and no centring. The fixed layer, the centring, the scrim and the padding of the title, the body and the actions now come from the application stylesheet with the values MUI uses, so nothing changes while the injected styles are there. The browser gate drops the emotion sheets and measures again, in both engines
* The Linux AppImage no longer aborts on current distributions such as Arch Linux with Mesa 26 and recent Ubuntu. The system Mesa stack and its base libraries now come from the host, the WebKit helpers find the bundled libraries on their own, the bundled GLib ignores the host GIO modules and the launcher no longer exports `LD_LIBRARY_PATH`, `PYTHONHOME`, `PYTHONPATH`, `PERLLIB` or `QT_PLUGIN_PATH`. The updater signature is made over the final AppImage

### Security

* Pairing credentials remain outside the browser interface and are stored by platform protected storage
* The mobile proxy accepts loopback traffic only and uses a short lived opening secret
* Release publication is blocked until the updater public key and signing secrets are configured

### Release status

Version 1.0.0 has not been published. Signed installers, native mobile archives, physical device testing, store review and the external release gates remain pending.

## 0.2.8 preview

Preview dated 2026-09-21. The brand mark was redrawn, the icon became the brand gradient filling the whole frame with the white symbol on it, the same drawing reaches the computer, the iPhone and Android, and dialogs no longer depend on styles injected at runtime to be positioned.

### Added

* An icon built from two finished brand pieces, the mantis head in colour on a white rounded plate. The framing differs per system and each difference has a reason: on the phone the plate fills the frame because the system is what rounds it, and on the desktop it steps back to the 824 of 1024 system grid so the icon does not touch its neighbours in the Dock. No shape is rasterized by the generator
* The same icon on iPhone, on Android and in the browser tab, where the adaptive foreground is the colour artwork over the white that plays the part of the plate, sized against the mask and asserted to fit the 66 dp safe zone
* Two generators for the brand files, one for the application icons and the interface mark, one for the website, both reading finished brand pieces rather than drawing anything

### Fixed

* The redrawn monochrome symbol reaches every place that showed the previous one: the sidebar, the splash and the first run of the studio, the iPhone shortcut and the light and dark marks of the pages
* The `cialai` command is found on Linux. Typing it gave command not found, and the application still reported everything was fine. The cause is an ordering trap: the Debian and Ubuntu `~/.profile` only adds `~/.local/bin` to PATH when the folder already exists, and it runs at login, before Cialai creates the folder; opening a new terminal did not help either, because a terminal opens an interactive shell, which reads `~/.bashrc`. The application now writes a marked block into that file, guarded so it cannot stack the folder on PATH, with a backup before the first write and an exact removal from Preferences. On fish nothing is edited: a file of its own lands in `conf.d`. The probe stopped lying too, because it measured a freshly opened login shell, where the folder already exists
* Dialogs no longer depend on styles injected at runtime to be positioned, only to be decorated
* The release announcement is one block per highlight instead of a wall of text, and resending an old announcement uses today's format rather than the one that existed on the day of the tag
* The delivery script loads both secret files, so the Codemagic token is found and the Android and iOS steps no longer stall

## 0.2.7 preview

Preview dated 2026-09-21. Opening the studio got seven times lighter, the `cialai` command now exists in the terminal, dialogs carry their own size, collapsing a side column is one button again, the icon got room to breathe and the phone Home invites you to the community.

### Added

* A `cialai` command in the terminal, written on first launch and checked on every launch
* The community rooms at the end of the phone Home, Discord and WhatsApp
* A performance budget, `npm run check:performance`, measured on a computer simulated four times slower
* A dialog geometry gate over the production stylesheet, and two browser scenarios that measure the sheet with twelve accounts on screen

### Fixed

* Opening the studio no longer downloads four megabytes of brand artwork: the first paint went from 4601 KB to 615 KB
* Dialogs no longer depend on styles injected at runtime to have a size, and their sections measure the sheet instead of the window
* Collapsing a side column is one button again
* The application icon is framed by the solid mass of the head instead of the box its thin tips stretch

## 0.2.6 preview

Preview dated 2026-09-19. Studio dialogs are sized by their content again, the documentation graph reads a document beside the map, the phone gets the whole screen back after the keyboard closes, the agent accounts have a door of their own and a layout that fits a phone, and Claude Code shows the same plan numbers Codex already showed.

### Added

* The documentation graph reads a document beside the map. Preview on a Markdown node opens the rendered document in a panel next to the graph, inside the same tab, split in half and resizable by the divider. Choosing another document swaps the content of the same panel, closing it gives the whole area back to the graph, and one explicit action moves the document to a window of its own. Open in the editor keeps opening the file for editing, and the graph keeps its selection, zoom and position through all of it
* A door of its own for the agent accounts in the studio, next to the sessions, so switching account no longer goes through Preferences. The screen is the same one the phone already had, with the same list, the same actions and the same numbers

### Fixed

* Preview, Open in the editor and Reveal in the explorer did nothing in the documentation graph. The studio never handed the three path actions to the panel, so every click ended in `actions.previewPath is not a function`
* Studio dialogs are sized by their content again. Pair phone, Preferences, agent accounts and the revoke confirmation took the full width of their breakpoint, which stretched the pairing dialog to 900 px and pushed the instructions away from the QR code, and let Preferences cover almost the whole window. Each size now has the width its content asks for, the paper never passes 660 px in height, the body scrolls inside, focus stays in the dialog and goes back to the control that opened it, and the application behind keeps its dimensions
* The phone no longer keeps the height of the keyboard after it collapses. The shell follows the visual viewport at all times, instead of only while a shrink larger than 80 px lasts, so the native done button, a closed composer, a return from the background and a rotation all give the whole screen back. A lost intermediate measurement no longer leaves a grey band under the terminal and the session list, because every measurement is the visible height of that moment
* The agent accounts fit the width of a phone. Each account is a card of three lines, with name and plan on the first, the plan usage on the second and a short Use button beside them, instead of one row where a repeated long button squeezed the name into a few letters. The explanation of what the button does appears once, at the top, and the list scrolls to the last account with the close button still in reach
* Claude Code shows the plan and the usage percentage that Codex already showed, on the accounts screen and on the session cards, on the computer and on the phone. Both providers read from the same place as the AI bar, which reads the CLI, the official endpoint, the Claude Desktop cache and the status line hook, so an account without the hook is no longer left without a number. Every percentage carries the name of the window it belongs to, so two different periods never look like the same measure, a reading that failed says so, an old reading appears dimmed and says it is old, and a missing reading is never shown as zero per cent

## 0.2.5 preview

Preview dated 2026-09-19. The studio gained a documentation graph, session activity that says what is actually happening, and agent account switching from the interface. The phone gained a floating composer, a session menu and a folder picker that reaches the whole disk. Windows paths follow one contract on both sides.

### Added

* A documentation graph in the central area of the studio. It draws every Markdown file of the session folder, and only the folders that lead to them, as a navigable force graph: a project with a thousand folders and documentation in ten areas shows ten areas and the paths to them, nothing else. It opens from the work area header, from the command palette, from Shift Cmd D or Shift Ctrl D and from Show in the documentation graph in the explorer context menu, opens documents in the same editor and refreshes through the same file watchers. The scan reads paths and metadata only, never file contents, and never follows a symbolic folder
* An agent accounts screen that lists every Claude Code and Codex profile found on the computer with its plan and window usage, marks the one in use and offers to use another one for new sessions. It opens from the phone session list and from Preferences on the computer. Cialai only chooses which folder the agent uses: it never moves `auth.json`, never copies a credential and never reads one
* A floating composer on the phone terminal, where a long instruction can be written, corrected and reviewed with the device keyboard, selection, clipboard, autocorrect and dictation, and reaches the terminal only through Insert or Send
* A session menu on the phone with rename, subtitle, colour, pin, move, new session in this folder, change folder, copy path, restart and close, reached by a three dot button or a long press
* A Windows test script and a diagnostic collector for the checks that need the real system

### Fixed

* Session activity is derived from the agent turn and the age of the last terminal output by a single pure function, so an agent that already answered shows Answer delivered with a still dot, an idle `ssh` or `python` prompt shows Process open, and a quiet process never turns into finished
* Sessions no longer look busy or disconnected after the connection drops and comes back. Activity evidence is invalidated when the bridge falls, replayed history no longer counts as new output, and a parked session with a live terminal gets its state from the desktop without being reattached
* A collapsed side column no longer disappears without a trace. The rail that brings it back is 28 px wide, clickable along its whole length, and shows the session count with a pending attention badge on the left and the Git change count on the right
* The folder picker offers each project root itself, so a session can open in the root instead of only in its subfolders, and browses the rest of the disk with a trail, Folder above, Use this folder and tap to descend
* The mobile app always opens on the Home screen, even when the last computer answers, and nothing connects before the first tap
* Windows paths follow one contract on both sides. Going up from `C:/Users` reaches the drive root instead of an invalid `C:`, folders compare without case on a file system that ignores it, dropping a file from Explorer works, and the explorer no longer keeps switching roots
* A desktop window that fails to paint is no longer a dead rectangle. The startup safety net acts on a positive signal from the interface, and after the deadline the window grows, becomes resizable again and gets the system frame so it can be moved and closed

## 0.2.4 preview

Preview dated 2026-09-18. The iOS and Android apps ship the phone connection, terminal and navigation work that landed in 0.2.3, which until now existed only on the desktop side. The desktop app is unchanged from 0.2.3 and does not need to be updated: every fix below is either inside the phone app or inside the page the desktop already serves.

### Added

* The mobile apps carry the home screen with the last computer, Computers, Pair, Terminal and Settings, and every back button leads to it
* Core log lines reach the advanced diagnostics in the mobile settings and, on iOS, the macOS Console through `os_log`

### Fixed

* The phone connection no longer drops and reconnects every 20 to 30 s: the health probe uses a local route the loopback proxy answers without a cookie, losing health keeps the page behind a Reconnecting banner instead of unmounting it, the proxy is reused for the same computer, re-adopting the same path no longer closes the terminals, and network changes respect the reserve hysteresis
* One retry ladder from 2 s to 16 s per computer, no longer restarting when the reason changes, and an immediate retry when the core announces a path
* On iOS a healthy check after returning from the background no longer restarts a working session, and on Android the local discovery only restarts when the transport actually changed
* QUIC uses a 20 s keepalive with a 45 s idle timeout and a 4 s direct dial budget for slow mobile networks

## 0.2.3 preview

Preview dated 2026-09-17 with the AI bar, the phone terminal and connection fixes, the mobile home screen, the Windows console fix and the Linux sidecar fix on top of 0.2.2, whose desktop build was never published.

### Added

* An AI bar on the right of the content, retractable, with one ring per Claude Code and Codex account found on the computer. Each ring shows the current session usage of that plan, the detail shows the weekly and per model windows and the sessions of the account, and the studio session activity appears on the ring. Open, collapsed or hidden with Shift Cmd N or Shift Ctrl N, the View menu and a Preferences section. Usage is read from the tools' own files, the Claude Code CLI and the official usage endpoints, never written, and alerts are off by default. The reading logic comes from Codenotch, MIT
* The mobile app has a home screen with the last computer, Computers, Pair, Terminal and Settings cards, and every back button leads to it. The app opens on the home when there is no last computer or the last connection failed, and goes straight to the terminal otherwise. Leaving the terminal keeps the proxy open for 90 s so returning reuses the same connection, and Disconnect on the Continue card closes it at once. The offline screen offers the home, the list, settings and pairing, and the loading screen shows the Cialai name
* Core log lines reach the advanced diagnostics in the mobile settings and, on iOS, the macOS Console through `os_log`
* The nightly workflow builds the Windows app in release and repeats the self test counting console windows, the AppImage smoke fails when the tunnel core does not start from inside the image, and the website repository checks `install.sh` in Arch, Debian, Fedora and Ubuntu containers

### Fixed

* The Linux AppImage showed Network with a problem from the first launch and never started `cialai-tunnel`: the sidecar was looked up next to the `.AppImage` file instead of inside the mounted image. It is now resolved next to the real executable and under `$APPDIR/usr/bin`, and a missing or invalid sidecar is written to `app.log` with the path that was tried
* On Windows the app kept opening console windows: the Git status of the explorer, the tunnel core and the diagnostic were spawned from a GUI subsystem process without `CREATE_NO_WINDOW`. All three now start as background commands, the tunnel binary is built as a GUI subsystem program, and the check `check:background-commands` refuses any production `Command::new` without that protection
* The tunnel core is started at most ten times per ten minute window, counting automatic restarts and interface calls, so a crash loop no longer multiplies processes
* The desktop neutralizes cursor, attribute and colour queries in the session history, even when they are split between two chunks, so replaying a history to a new subscriber never produces keystrokes. The `binary` path of `pty_write` refuses characters above U+00FF instead of truncating them
* The phone terminal typed by itself after switching sessions or computers or after a dropped connection: the replayed history carried cursor and attribute queries that the terminal answered as keystrokes. The page now ignores everything the terminal emits while a replay is being written, reattaches with a backoff from 500 ms to 8 s per session instead of every 500 ms, no longer reattaches sessions in error or parked off screen, and only sends wheel reports when the program is still tracking the mouse after the replay
* Accented characters and ç typed on the phone came out doubled or broken: the keyboard composition is sent once, the input is normalized to NFC, and the binary channel of the terminal only carries mouse reports
* The explorer runs Git status less often: every 60 s while visible, none while hidden, with a 2.5 s debounce on watcher events and at least 5 s between runs, which matters on Windows where each run starts two processes
* The mobile connection dropped and reconnected every 20 to 30 s on iPhone: the health probe hit the gated `/api/health` route without the proxy cookie and got 403. The proxy now answers a local `/_cialai/health` route from the path manager state without any cookie, and each failed probe records its HTTP status in the advanced diagnostics
* Losing health on the phone no longer unmounts the page: a Reconnecting banner shows above the terminal, the proxy is reused when it is still open, and the offline screen only appears when the core confirms there is no path or after 45 s
* Reopening the same computer reuses the local proxy with the same port, nonce and cookie, and every page load with a valid cookie is redirected to the URL carrying the bridge, so the WebView recovers after a content process restart without reloading the terminals
* Re-adopting a path to the same address no longer closes the WebSockets or counts as a switch, and network interface changes reach the core only after 2.5 s of stability and respect the reserve hysteresis. QUIC uses a 20 s keepalive with a 45 s idle timeout and a 4 s direct dial budget for slow mobile networks
* The offline screen and the connection state share one retry ladder from 2 s to 16 s per computer, no longer restarting when the reason changes, and retry at once when the core announces a path. On iOS a healthy check after returning from the background no longer restarts the session, and the page waits for the previous socket to close before opening the next one
* The Linux installer decides the package format from `ID` and `ID_LIKE` in `/etc/os-release` before checking tools, so Arch with `apt-get` or `dnf` installed receives the AppImage. It replaces the AppImage atomically so updating with the app open works, creates the `cialai.desktop` entry with icons, and only warns about FUSE when neither `fusermount3` nor `fusermount` exists

## 0.2.2 preview

Preview dated 2026-09-16 with the phone presentation, the phone connection and the mobile settings work on top of 0.2.1, which was never published.

### Added

* Face ID or biometrics can be set in the mobile settings to always, only when opening the computer, or off. The default stays always

### Changed

* The phone page and the mobile shell follow the presentation of the Ordinum Control iPhone app they were born from: flat toolbar icons for back, files, end session and new session, a single scrolling row of 44 px keys, session cards with the session colour and 17 px names, a 13 px terminal, and a 44 px native bar with the computer name, the transport as a small chip and the Computers action in the accent colour over the iOS neutral palette
* The phone keys row starts with Esc and Enter, the two keys used most with an agent

### Fixed

* The phone connection no longer restarts every few seconds while sessions produce output. The desktop bridge dropped the whole phone connection whenever its 64 frame output queue filled, which happened on every replay of the session histories, so the page reconnected in a loop. The queue holds 4096 frames, output larger than one frame is split, and a full queue now detaches only the lagging terminal, which the page reattaches from the offset it already has. The bridge logs why each phone connection ended
* The phone page keeps its bridge socket across short hides such as a Face ID prompt or the notification centre, instead of reconnecting and replaying every terminal
* Touch scrolling inside a program that uses the alternate screen no longer sends arrow keys, which recalled the prompt history in Claude Code. It sends mouse wheel reports when the program tracks the mouse and nothing otherwise

## 0.2.1 preview

Preview dated 2026-09-15 with Linux, interface and macOS packaging fixes on top of 0.2.0. The Android app is the same as in 0.2.0.

### Fixed

* The Linux AppImage aborted on recent distributions such as Arch and newer Ubuntu with `Could not create default EGL display`, because it bundled graphics libraries older than the Mesa of the system. The AppImage now leaves the graphics stack to the system, finds the WebKit helpers without `LD_LIBRARY_PATH` and starts without the classic AppRun variables
* Terminals, Git, the Dev Browser, the Office conversion and the tunnel sidecar no longer inherit `PYTHONHOME`, `PYTHONPATH`, `LD_LIBRARY_PATH` and the other variables the AppImage sets for itself, which broke Python, Git over HTTPS, curl and pacman inside Cialai
* On Linux the folder, command and environment of each process are read again on every sample, so the session card follows `cd` and `exec`
* The AI usage follows the Claude Code or Codex process behind launcher scripts and finds Codex homes outside `~/.codex`
* The terminal no longer shows a black frame around it in the light and dark themes, on the desktop and on the phone page
* The search and copy buttons of the session header, which did nothing, were removed; the terminal search through Cmd F or Ctrl F now highlights results
* The macOS DMG is notarized and stapled, not only the app inside it

### Changed

* Linux downloads recommend the DEB package for Debian and Ubuntu and the RPM package for Fedora and openSUSE, with the AppImage for other distributions

## 0.2.0 preview

Preview dated 2026-09-15 for macOS, Windows, Linux and Android. It replaces the Headscale setup with automatic connectivity.

### Changed

* The phone reaches the computer with no server run by you, by Ordinum or by the project. When Cialai opens, the computer brings its connectivity up by itself: Ed25519 identity keys, a direct QUIC connection on UDP port 4740 or a free port with mutual TLS 1.3 and the desktop key pinned in the QR code, port mapping through UPnP, NAT-PMP or PCP when the router allows, optional STUN through public Cloudflare and Google servers, a DNS-SD `_cialai._udp` announcement on the local network and an embedded single hop Tor onion service as meeting point and backup
* The phone tries the local network, then the direct path over the internet, then the backup through Tor. From the backup it keeps trying to move to a direct path with a NAT punch coordinated over the control channel. The Devices screen and the phone show Direct and Backup badges
* The desktop bundles the Tor Expert Bundle 15.0.22 with tor 0.4.9.12; Android uses tor-android and iOS uses Tor.framework
* The Headscale setup assistant gave way to the Phone access panel on the Devices screen, with advanced diagnostics that list the public networks in use

### Pairing

* `CIALAI2.` pairing codes always carry the onion address and up to six direct candidates in under 700 bytes. The QR code rotates every 90 seconds and expires after 600 seconds
* A phone that is not paired yet only reaches the pairing request. Approval by code on the computer stays optional
* Each phone gets its own `cdt1` token, rotated every 30 days. Revoking a phone closes its sessions on both paths and the bridge closes its sockets with code 4401

### Upgrade notes

* Pairings from 0.1.x previews do not carry over. Pair each phone again after updating
* A Headscale API key saved by an earlier version is no longer used and can be deleted in the advanced diagnostics of the Devices screen
* The Headscale mode stays in the repository as inert code until device validation, and `infra/headscale` is kept only as history

### Public networks used

* The Tor network, optional STUN servers from Cloudflare and Google, and DNS-SD on the local network

### Known limits

* The computer must be on with Cialai open
* Networks that block both Tor and UDP leave the phone without a path
* The backup through Tor is slower than a direct connection
* Validation covers automated suites and in process tests against the real Tor network. The physical checklist on real phones and networks is still pending

## 0.1.1 preview

Released on 2026-09-14 for macOS, Windows and Linux. The Android APK in this release is the same 0.1.0 build.

### Fixed

* On Windows the window grows past the splash size, new terminals no longer stay blank while the console waits for a cursor position reply, terminal memory is measured before Windows 11 and the phone can read project files through the Win32 backend
* The mobile site served by the desktop uses fixed content types instead of the types in the Windows registry
* Side columns that a narrow window collapsed open again from their button, shortcut and command palette entry

## 0.1.0 preview

Released on 2026-09-14 as the first public preview for macOS, Windows, Linux and Android, without Apple or Microsoft code signing.
