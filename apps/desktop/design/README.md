# Desktop icon source

`app-icon-1024.png` is the approved transparent symbol from
`brand/logo/cialai-mantis-v4-1-head-4k.png`, composited without reinterpretation
over the opaque white background required by the Cialai brand guide.

Run `npm run icon --workspace @cialai/desktop` to regenerate every platform
size under `src-tauri/icons`. The source stays square, opaque and at 1024 px so
the generated desktop and iOS assets share the same approved composition.
