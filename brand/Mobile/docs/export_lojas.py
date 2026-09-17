#!/usr/bin/env python3
"""export_lojas.py — gera os arquivos finais nas medidas de cada loja.

Cada destino é composto na própria proporção, em dobro, e só então reduzido. Nada de
esticar ou preencher com margem o master 9:16, o que empurraria o aparelho para longe.

| Destino                         | Pixels     | Pasta          |
|---------------------------------|------------|----------------|
| Google Play, telefone           | 1080x1920  | slides/play    |
| App Store, iPhone 6,9 polegadas | 1320x2868  | slides/iOS     |

Sem iPad: o app declara `supportsTablet: false`. Tablets do Google Play ficam como
pendência na MATRIZ.

Uso:  <venv>/bin/python docs/export_lojas.py
"""
import pathlib
import sys

from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from compose_device import BASE, SLIDES, compor  # noqa: E402

# frac controla a largura do aparelho no layout "full". O retrato da Apple é mais alto
# que o 9:16, então lá o aparelho cresce para ocupar a folga em vez de sobrar fundo.
DESTINOS = [
    dict(pasta="play", w=1080, h=1920, frac=None),
    dict(pasta="iOS", w=1320, h=2868, frac=0.78),
]


def main():
    for dst in DESTINOS:
        out = BASE / "slides" / dst["pasta"]
        out.mkdir(parents=True, exist_ok=True)
        for key in list(SLIDES):
            cfg = dict(SLIDES[key])
            kw = dict(cw=dst["w"] * 2, ch=dst["h"] * 2)
            if dst["frac"]:
                kw["phone_frac"] = dst["frac"]
            im = compor(cfg, **kw).resize((dst["w"], dst["h"]), Image.LANCZOS)
            im.save(out / f"{key}.png", "PNG")
            print("SAVED slides/%s/%s.png  %dx%d" % (dst["pasta"], key, dst["w"], dst["h"]))


if __name__ == "__main__":
    main()
