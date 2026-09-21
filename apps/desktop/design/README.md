# App icon sources

These three files are **generated**, not drawn by hand. The source is the brand
master `brand/logo/cialai-mantis-v4-1-head-4k.png`.

```sh
node tools/brand/build-app-icons.mjs          # writes the three files
node tools/brand/build-app-icons.mjs --medir  # prints the measurements only
node tools/brand/build-app-icons.mjs --folha  # writes a comparison sheet to the temp folder
```

| File | Use | Shape |
| --- | --- | --- |
| `app-icon-1024.png` | iOS and Expo source | Square, opaque RGB on white; iOS applies its own mask |
| `desktop-icon-1024.png` | macOS, Windows and Linux | Rounded tile at 824 px centered in a transparent 1024 px canvas, following the macOS grid |
| `android-foreground-1024.png` | Android adaptive icon foreground over `#FFFFFF` | Artwork scaled to fit the 66 dp safe zone |

## Framing

The mark is placed by its **solid mass**, the rows that carry real ink, and not
by its bounding box. The bounding box is stretched by three thin tips: the top
of the petal, the antenna points and the taper of the mouth, which alone eats
14% of the height. Framing by the bounding box pushed the artwork to 87.7% of
the tile with 6.2% of breathing room, which reads as a frame inside a frame in
the Dock. Those tips now live in the margin.

Two constants at the top of the generator govern everything: `ALVO_MASSA`, the
share of the tile height the solid mass takes, and `TETO_CAIXA`, the ceiling for
the full bounding box. Raising the first makes the head bigger and brings the
thin tips closer to the edge. With this artwork the two pull against each other,
because the brand requires proportional scaling: a bigger head always costs
margin. Shortening the mouth taper would lift that trade, and it needs the
source vector, which is not versioned here.

The squircle of `desktop-icon-1024.png` is reused from the file itself, so the
approved curve of the macOS grid is preserved instead of being redrawn.

Run `npm run icon --workspace @cialai/desktop` afterwards to regenerate every
desktop size under `src-tauri/icons` from `desktop-icon-1024.png`. iOS and
Android come from `expo prebuild`, which reads `apps/mobile/app.config.ts`.
