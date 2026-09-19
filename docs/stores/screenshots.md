# Store Screenshot Plan

Status: eight Brazilian Portuguese images shipped to both stores on 16/09/2026; the English set is live on Google Play since 17/09/2026

The set was built with the recipe in `brand/Mobile/MATRIZ.md` and follows the
order in `brand/Mobile/roteiro.md`, which is the order both stores now show.
Both store consoles scramble the order when several files are uploaded at once.
On Google Play the fix is to add one file at a time; on the App Store the
screenshot set is reordered through the API.

Still pending: the English set, the Google Play tablet sizes, and the capture
record below, which only makes sense once a real device build reproduces the
three screens that are still drawn by the image model.

## How the English set was produced

The pipeline now takes a language. `compose_device.py`, `export_lojas.py` and
`capa.py` accept `--idioma en`, read the screens from `brand/Mobile/real-en/` and
`brand/Mobile/ia-en/`, write the headlines held in the `EN` table of
`compose_device.py`, and save to `brand/Mobile/slides-en/`.

The English screens were not captured again on a device. Each Brazilian
Portuguese screen was handed to Nano Banana Pro, `gemini-3-pro-image`, with the
instruction to translate every visible string and keep the layout, the typeface,
the colours and the dimensions untouched. The drawn screens were regenerated at
4K so they keep the 3072 by 5504 pixels of the originals.

The model kept insisting on the screen title `Terminais`, probably reading it as
a product name. `docs/retoca_en.py` fixes it without a font file: the two words
differ only in the eighth letter, so the stem of the `i` itself is reused,
stretched to cap height and planted in place with the dot erased. The raw model
answer stays as `real-en/<nome>-bruto.png`, in the same spirit as `retoca_ia.py`.

Replace these screens with real English captures once a device build is
available. `@cialai/i18n` already ships the English interface, so the capture is
the only missing step.

All screenshots must use fictional projects and test infrastructure. Remove QR payloads, API keys, device tokens, personal paths, notifications and account identifiers. Use the same story and ordering in Brazilian Portuguese and English.

## Screen priority

| Priority | Screen | What it proves |
| --- | --- | --- |
| 1 | Pair a computer | Short lived QR flow and clear confirmation |
| 2 | Computers | Paired computers and connection state |
| 3 | Terminal | Live session with readable history and mobile keys |
| 4 | Files | Project navigation and read only state |
| 5 | Reconnecting | Honest behavior when the computer is unavailable |
| 6 | Settings | Local security and connection controls |

The first three images must show the real application interface without marketing frames. Capture connected and offline states from the same fictional setup.

## Apple App Store

| Target | Output | Quantity | Status |
| --- | --- | --- | --- |
| iPhone 6.9 inch portrait | 1320 by 2868 pixels | 8 in pt-BR, shipped; 8 in English, rendered | pt-BR live on the store since 16/09/2026; the English set pending upload while the first submission is in review |
| iPhone 6.9 inch landscape | 2868 by 1320 pixels | 1 optional terminal view per language | Pending native iPhone build |
| iPhone 6.5 inch portrait | 1284 by 2778 pixels | Optional fallback only | Not uploaded; App Store Connect reuses the 6.9 inch set |
| Mac | 2880 by 1800 pixels | Not planned | Desktop distribution uses signed GitHub installers, not the Mac App Store |

App Store Connect accepts one to ten screenshots per device size and does not accept alpha transparency. If the final iOS build declares iPad support, add a separate iPad set before submission. Do not assume that an iPhone set satisfies an iPad requirement.

Reference: [Apple screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications).

## Google Play

| Target | Output | Quantity | Status |
| --- | --- | --- | --- |
| Phone portrait | 1080 by 1920 pixels | 8 in pt-BR and 8 in English, shipped | pt-BR live since 16/09/2026, en-US sent on 17/09/2026 |
| 7 inch tablet landscape | 1920 by 1080 pixels | 4 per language | Pending tablet layout verification |
| 10 inch tablet landscape | 2560 by 1440 pixels | 4 per language | Pending tablet layout verification |
| Feature graphic | 1024 by 500 pixels | 1 in pt-BR and 1 in English, shipped | pt-BR live since 16/09/2026, en-US sent on 17/09/2026 |

Google Play requires at least two screenshots for publication. Four screenshots with at least 1080 pixels and a 16 by 9 or 9 by 16 ratio are recommended for app discovery. Images must be JPEG or 24 bit PNG without alpha.

Reference: [Google Play preview asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151).

## Capture record

For each final image record the app version, build number, device, operating system, locale, dimensions, source commit and reviewer. A screenshot is ready only after the real store build reproduces the intended screen.
