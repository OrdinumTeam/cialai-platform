# App icon sources

All icons derive from the approved `brand/logo/cialai-icon.png`, a 2048 px white
rounded tile with the Cialai mantis head.

| File | Use | Shape |
| --- | --- | --- |
| `app-icon-1024.png` | iOS and Expo source | Square, opaque RGB on white; iOS applies its own mask |
| `desktop-icon-1024.png` | macOS, Windows and Linux | Rounded tile at 824 px centered in a transparent 1024 px canvas, following the macOS grid |
| `android-foreground-1024.png` | Android adaptive icon foreground over `#FFFFFF` | Artwork scaled to fit the 66 dp safe zone |

Run `npm run icon --workspace @cialai/desktop` to regenerate every desktop size
under `src-tauri/icons` from `desktop-icon-1024.png`.
