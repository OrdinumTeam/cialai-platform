#!/usr/bin/env python3
"""capa.py — Feature Graphic do Google Play, 1024x500.

Aparelho com a tela real à esquerda, assinatura da marca mais mensagem à direita, sobre
a superfície blush do Cialai.

A assinatura é o lockup horizontal oficial, `brand/logos/cialai-lockup-1-4k.png`, símbolo
à esquerda e nome à direita. O nome Cialai é lettering desenhado à mão, não existe como
fonte, então o lockup entra como imagem, nunca reescrito nem desenhado pela IA.
Símbolo, headline e subtítulo começam na mesma margem, e o lockup guarda trinta por
cento da própria altura de respiro antes da headline.

A headline da capa usa Outfit 500, um peso abaixo do 600 dos slides.

Uso:  <venv>/bin/python docs/capa.py
"""
import pathlib
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from compose_device import (  # noqa: E402
    BASE, BG, PHONE, TEXTO, TEXTO2, composite_device, fonte,
)

CW, CH = 2048, 1000                     # 2,048 por 1, reduzido para 1024x500

LOCKUP = BASE / "brand/logos/cialai-lockup-1-4k.png"
SCREEN = "real/lista-escuro.png"
HEAD = "Todos os seus terminais."
SUB = "No computador e no celular."

PESO_HEAD_CAPA = 500
HEAD_SZ, SUB_SZ = 92, 46

DEVICE_W = 0.30                         # largura do aparelho, fração do canvas
DEVICE_X, DEVICE_Y = 0.07, 0.13         # canto superior esquerdo, fração do canvas
COL_X = 0.44                            # margem da coluna de texto
LOCKUP_W = 0.27                         # largura do lockup, fração do canvas
RESPIRO = 0.30                          # do lockup antes da headline, em altura do lockup


def main():
    canvas = Image.new("RGB", (CW, CH), BG)

    device = composite_device(PHONE, SCREEN, BG).convert("RGBA")
    pw = int(CW * DEVICE_W)
    ph = int(device.height * pw / device.width)
    device = device.resize((pw, ph), Image.LANCZOS)
    canvas.paste(device, (int(CW * DEVICE_X), int(CH * DEVICE_Y)), device)

    lockup = Image.open(LOCKUP).convert("RGBA")
    lockup = lockup.crop(lockup.getchannel("A").getbbox())
    lw = int(CW * LOCKUP_W)
    lh = int(lockup.height * lw / lockup.width)
    lockup = lockup.resize((lw, lh), Image.LANCZOS)

    d = ImageDraw.Draw(canvas)
    fh = fonte(PESO_HEAD_CAPA, HEAD_SZ)
    fs = fonte(400, SUB_SZ)
    hh = int(HEAD_SZ * 1.15)
    sh = int(SUB_SZ * 1.45)
    gap1 = int(lh * RESPIRO)
    gap2 = int(HEAD_SZ * 0.35)
    total = lh + gap1 + hh + gap2 + sh
    x = int(CW * COL_X)
    y = (CH - total) // 2

    canvas.paste(lockup, (x, y), lockup)
    y += lh + gap1
    d.text((x, y), HEAD, font=fh, fill=TEXTO, anchor="la")
    y += hh + gap2
    d.text((x, y), SUB, font=fs, fill=TEXTO2, anchor="la")

    (BASE / "slides").mkdir(exist_ok=True)
    canvas.save(BASE / "slides/capa.png", "PNG")
    canvas.resize((1024, 500), Image.LANCZOS).save(BASE / "slides/capa-1024x500.png", "PNG")
    print("SAVED slides/capa.png 2048x1000 e slides/capa-1024x500.png")


if __name__ == "__main__":
    main()
