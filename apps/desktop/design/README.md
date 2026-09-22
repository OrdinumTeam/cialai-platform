# App icon sources

These three files are **generated**, not drawn by hand.

```sh
node tools/brand/build-app-icons.mjs          # writes the three files and the interface mark
node tools/brand/build-app-icons.mjs --medir  # prints the measurements only
node tools/brand/build-site-brand.mjs         # writes the brand assets of the website
```

| File | Use | Shape |
| --- | --- | --- |
| `app-icon-1024.png` | iPhone, Android and the website favicon | Plate edge to edge, opaque RGB with no alpha channel |
| `desktop-icon-1024.png` | macOS, Windows and Linux | Plate of 824 px centred in 1024, with a transparent margin |
| `android-foreground-1024.png` | Android adaptive icon foreground | The artwork alone, inside the 66 dp safe zone, over `#FFFFFF` |

## The design

The icon is the mantis head in colour on a white rounded plate. Nothing here
draws a shape: both pieces come finished from the brand folder.

| Piece | What it carries |
| --- | --- |
| `brand/logo/cialai-icon.png` | The white rounded plate with the artwork inside |
| `brand/logo/cialai-icon-v2.png` | The same artwork, with no plate |

The two place the artwork at the same size, 87.6% of the frame height, so the
second is the first without its background. That is why the desktop plate is
the approved piece reduced, and not a rounded rectangle rasterized here: the
curve is the designer's.

## Why each target is framed differently

**On the phone the plate fills the frame,** because the system is what rounds
it. On iOS the file must also be opaque, with no alpha channel, so the corners
the plate leaves out are painted white; the iOS mask eats them. On Android the
adaptive background is `#FFFFFF`, which plays the part of the plate the iPhone
already carries drawn.

**On the desktop the plate steps back to the system grid,** 824 px of 1024,
with the transparent margin the Dock expects. It is the same grid the
applications that ship with the system use, and without it the icon touches its
neighbours.

`tools/check/desktop-icon.mjs` reads `PLACA_MACOS` from the generator and
asserts the plate measures exactly that and stays centred, so the files and the
code cannot drift apart. It also asserts the artwork takes the same fraction of
both plates, which is what keeps the phone and the computer looking like the
same application.

Run `npm run icon --workspace @cialai/desktop` afterwards to regenerate every
desktop size under `src-tauri/icons`. iOS and Android come from `expo prebuild`,
which reads `apps/mobile/app.config.ts`.

## The interface mark

`packages/ui/src/assets/cialai-mark-256.png` is the sidebar, splash and first
run mark, generated from the black symbol. The stylesheet turns it white on dark
backgrounds. It exists because those three screens used to import the 4096 px
master, four megabytes fetched before the first paint to draw a mark at a few
dozen pixels.
