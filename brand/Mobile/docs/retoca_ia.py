#!/usr/bin/env python3
"""retoca_ia.py — retoques determinísticos nas telas desenhadas pela IA.

Computadores e Ajustes vieram com uma faixa preta vazia no topo: o prompt pediu 60 px de
margem e o modelo entendeu 60 pt na escala dele. A faixa é aparada até sobrar a margem
que o app real deixa acima do primeiro elemento, e o compositor cobre o resto com a
faixa de status.

A tela de Ajustes saiu ainda com dois desvios de prompt: a palavra UPPERCASE escrita como se
fosse um rótulo, acima de IDIOMA, e o título Ajustes encostado em Computadores em vez de
centrado. Uma segunda geração corrigiu o título mas piorou o resto, então a primeira fica
como bruto e os dois desvios são corrigidos aqui em PIL, sobre fundo chapado:

1. A faixa de linhas do rótulo estranho é removida, e a imagem recebe a mesma altura de
   fundo no pé, para o espaçamento entre a barra de navegação e IDIOMA voltar ao que era.
2. O título é apagado na cor local e reescrito em San Francisco Bold, no mesmo corpo e no
   mesmo baseline, centrado na largura da tela.

Uso:  <venv>/bin/python docs/retoca_ia.py
Entradas: ia/ajustes-bruto.png, ia/computadores-bruto.png
Saídas:   ia/ajustes.png, ia/computadores.png
"""
import pathlib

import numpy as np
from PIL import Image, ImageDraw, ImageFont

BASE = pathlib.Path(__file__).resolve().parent.parent
SRC = BASE / "ia/ajustes-bruto.png"
OUT = BASE / "ia/ajustes.png"
SRC_COMP = BASE / "ia/computadores-bruto.png"
OUT_COMP = BASE / "ia/computadores.png"
MARGEM_TOPO = 62                        # 8 pt na escala do render, 3072 px para 393 pt

FONTE_SISTEMA = "/System/Library/Fonts/SFNS.ttf"
FAIXA = (780, 896)                      # linhas removidas, rótulo estranho com as margens
TITULO = (1300, 480, 1775, 635)         # caixa apagada em volta de Ajustes
TITULO_TXT = "Ajustes"


def fonte_bold(cap_alvo):
    sz = 200
    while sz > 20:
        f = ImageFont.truetype(FONTE_SISTEMA, sz)
        f.set_variation_by_name(b"Bold")
        if -f.getbbox("A", anchor="ls")[1] <= cap_alvo:
            return f
        sz -= 2
    return f


def apara_topo(a, margem=MARGEM_TOPO):
    """Corta o topo até a primeira linha que difere do canto, menos a margem pedida.
    A altura removida volta como fundo no pé, para a imagem manter a proporção."""
    canto = a[0, 0]
    dif = np.abs(a - canto).sum(2)
    primeira = int(np.where((dif > 24).any(1))[0].min())
    corte = max(0, primeira - margem)
    pe = np.median(a[-40:], axis=(0, 1)).astype(np.uint8)
    enchimento = np.full((corte, a.shape[1], 3), pe, dtype=np.uint8)
    return np.vstack([a[corte:].astype(np.uint8), enchimento]), corte


def main():
    a = np.asarray(Image.open(SRC_COMP).convert("RGB")).astype(int)
    a, corte = apara_topo(a)
    Image.fromarray(a).save(OUT_COMP, "PNG")
    print("SAVED ia/computadores.png  topo aparado em %d px" % corte)

    im = Image.open(SRC).convert("RGB")
    a = np.asarray(im).astype(int)

    # 2. título: mede caixa alta e baseline do A antes de apagar
    x0, y0, x1, y1 = TITULO
    reg = a[y0:y1, x0:x1]
    branco = (reg.min(2) > 200)
    ys, xs = np.where(branco)
    topo = y0 + int(ys.min())
    col_a = branco[:, : int((xs.max() - xs.min()) * 0.2)]        # primeira letra, A
    base = y0 + int(np.where(col_a.any(1))[0].max()) + 1
    cap = base - topo
    fundo = tuple(int(v) for v in np.median(reg[~branco], 0))

    d = ImageDraw.Draw(im)
    d.rectangle(TITULO, fill=fundo)
    f = fonte_bold(cap)
    larg = d.textlength(TITULO_TXT, font=f)
    d.text(((im.width - larg) / 2, base), TITULO_TXT, font=f, fill=(245, 245, 247), anchor="ls")
    print("titulo: caixa alta %d, baseline %d, fundo %s" % (cap, base, "#%02X%02X%02X" % fundo))

    # 1. faixa removida e devolvida no pé
    a = np.asarray(im)
    pe = np.median(a[-40:], axis=(0, 1)).astype(np.uint8)
    corpo = np.delete(a, np.arange(*FAIXA), axis=0)
    enchimento = np.full((FAIXA[1] - FAIXA[0], a.shape[1], 3), pe, dtype=np.uint8)
    a, corte = apara_topo(np.vstack([corpo, enchimento]).astype(int))
    Image.fromarray(a).save(OUT, "PNG")
    print("SAVED ia/ajustes.png  %dx%d, topo aparado em %d px" % (a.shape[1], a.shape[0], corte))


if __name__ == "__main__":
    main()
