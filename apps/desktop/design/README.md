# App icon sources

These three files are **generated**, not drawn by hand.

```sh
node tools/brand/build-app-icons.mjs          # writes the three files and the interface mark
node tools/brand/build-app-icons.mjs --medir  # prints the measurements only
node tools/brand/build-site-brand.mjs         # writes the brand assets of the website
```

| File | Use | Shape |
| --- | --- | --- |
| `app-icon-1024.png` | iOS and Expo source | Square, opaque RGB, gradient with the white symbol |
| `desktop-icon-1024.png` | macOS, Windows and Linux | Square, edge to edge, with an alpha channel that is fully opaque |
| `android-foreground-1024.png` | Android adaptive icon foreground | The white symbol alone, inside the 66 dp safe zone, over `#E23B84` |

## The design

The icon follows the sibling Ordinum applications: the brand gradient filling
the whole frame, from magenta orchid at the top to hot pink at the bottom, with
the symbol in white on it. The white brand mark carries only the antennae, the
eyes and the mouth; the petal and the face are cut out, and the gradient shows
through them.

**The file is a full square, with no rounded corners drawn in it.** This is the
part that matters. Current macOS applies the system mask itself. The previous
icon shipped a squircle already drawn inside a transparent frame, so the system
masked something that was already smaller: it was born smaller than its
neighbours in the Dock, with the edge of its own plate visible inside the frame.
`tools/check/desktop-icon.mjs` asserts the corners are opaque so that cannot
come back.

Two constants in `tools/brand/build-app-icons.mjs` govern the rest: `TOPO` and
`BASE`, the ends of the gradient, and `ALTURA_MARCA`, how much of the frame the
symbol takes. The check cross reads them, so the files and the code cannot drift
apart.

Run `npm run icon --workspace @cialai/desktop` afterwards to regenerate every
desktop size under `src-tauri/icons`. iOS and Android come from `expo prebuild`,
which reads `apps/mobile/app.config.ts`.

## The interface mark

`packages/ui/src/assets/cialai-mark-256.png` is the sidebar, splash and first
run mark, generated from the black symbol. The stylesheet turns it white on dark
backgrounds. It exists because those three screens used to import the 4096 px
master, four megabytes fetched before the first paint to draw a mark at a few
dozen pixels.
