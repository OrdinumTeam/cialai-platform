#!/usr/bin/env python3
"""prep_screens.py — prepara as capturas do celular do Cialai para o compositing.

Tudo determinístico em PIL/numpy, nada de IA redesenhando a tela:

1. Corta a status bar desenhada no topo da captura. O app começa no header de 44 pt,
   e o compositor desenha a faixa de status limpa sob a Dynamic Island.
2. Troca o nome real do computador por um nome fictício, apagando a caixa do nome e do
   chip de transporte na cor de fundo medida, reescrevendo o nome na fonte do sistema
   no mesmo baseline e recolocando o chip original logo depois.
3. Em Arquivos, cuja captura veio de um build anterior com outro header, transplanta o
   header atual da lista escura por cima do antigo.
4. Para o slide do agente, corta mais fundo, na borda do primeiro card inteiro.

As capturas têm 786x1704, 393x852 lógico em 2x. Medidas abaixo em pixel dessa escala.

Uso:  <venv>/bin/python docs/prep_screens.py
Saída: real/*.png
"""
import pathlib

import numpy as np
from PIL import Image, ImageDraw, ImageFont

BASE = pathlib.Path(__file__).resolve().parent.parent
BRUTAS = BASE / "brutas"
OUT = BASE / "real"

STATUS_H = 94                        # status bar desenhada; o header começa aqui
HEADER_END = 183                     # separador do header em 180 a 182, mais um pixel
SEP_ANTIGO = 89                      # em Arquivos, separador do header antigo em 86 a 88

# caixa do nome real e do chip, medida nas capturas
NOME_X0, NOME_BASE, NOME_CAP = 67, 151, 27        # margem esquerda, baseline, altura da caixa alta
CHIP = (282, 118, 380, 158)                       # chip de transporte, copiado tal qual
GAP_CHIP = CHIP[0] - 265                          # respiro entre o fim do nome e o chip
APAGA = (60, 112, 500, 166)                       # caixa apagada: nome e chip, antes de Computadores

NOME_NOVO = "MacBook de Ana"                       # mesmo nome fictício usado no site
FONTE_SISTEMA = "/System/Library/Fonts/SFNS.ttf"  # a captura usa system-ui, San Francisco

# Corte de topo maior que a status bar, para a tela começar num card inteiro.
# Só vale em tela que entra na disposição "bottom", porque o pé fica abaixo da dobra.
CORTE_TOPO = {
    "agente": 422,                   # borda superior do card site-exemplo
}

MAP = {
    "lista-dark": "lista-escuro",
    "lista-light": "lista-claro",
    "terminal-dark": "terminal",
    "arquivos-dark": "arquivos",
}


def fonte_sistema(cap_alvo, peso=b"Semibold"):
    """San Francisco na instância nomeada, no corpo cujo M tem a altura medida na captura.
    A SFNS.ttf tem quatro eixos, Width, Optical Size, GRAD e Weight; a instância nomeada
    ajusta todos de uma vez."""
    sz = 40
    while True:
        f = ImageFont.truetype(FONTE_SISTEMA, sz)
        f.set_variation_by_name(peso)
        x0, y0, x1, y1 = f.getbbox("M", anchor="ls")
        cap = -y0
        if cap <= cap_alvo or sz <= 20:
            return f
        sz -= 1


def anonimiza(im):
    """Troca o nome do computador no header, preservando o chip e o resto da linha."""
    a = np.asarray(im).copy()
    bg = tuple(int(v) for v in a[0, 0])
    chip = im.crop(CHIP)
    d = ImageDraw.Draw(im)
    d.rectangle(APAGA, fill=bg)
    f = fonte_sistema(NOME_CAP)
    # cor do nome: a mais frequente dentro da caixa antiga que não é fundo
    caixa = a[NOME_BASE - NOME_CAP:NOME_BASE + 1, NOME_X0:265]
    dif = np.abs(caixa.astype(int) - np.array(bg)).sum(2)
    tinta = caixa[dif > 200]
    cor = tuple(int(v) for v in np.median(tinta, 0)) if len(tinta) else (245, 245, 247)
    d.text((NOME_X0, NOME_BASE), NOME_NOVO, font=f, fill=cor, anchor="ls")
    fim = NOME_X0 + int(round(d.textlength(NOME_NOVO, font=f)))
    im.paste(chip, (fim + GAP_CHIP, CHIP[1]))
    return im


def main():
    OUT.mkdir(exist_ok=True)
    prontas = {}
    for stem, nome in MAP.items():
        src = BRUTAS / f"{stem}.png"
        if not src.exists():
            print("SEM CAPTURA", src.name)
            continue
        im = Image.open(src).convert("RGB")
        if nome == "arquivos":
            # header atual, já anonimizado, por cima do header antigo
            header = prontas["lista-escuro"].crop((0, STATUS_H, im.width, HEADER_END))
            corpo = im.crop((0, SEP_ANTIGO, im.width, im.height))
            novo = Image.new("RGB", (im.width, header.height + corpo.height), tuple(int(v) for v in np.asarray(im)[0, 0]))
            novo.paste(header, (0, 0))
            novo.paste(corpo, (0, header.height))
            prontas[nome] = novo
            novo.save(OUT / f"{nome}.png", "PNG")
            print("SAVED real/%s.png  %dx%d" % (nome, novo.width, novo.height))
            continue
        im = anonimiza(im)
        prontas[nome] = im
        rec = im.crop((0, STATUS_H, im.width, im.height))
        rec.save(OUT / f"{nome}.png", "PNG")
        print("SAVED real/%s.png  %dx%d" % (nome, rec.width, rec.height))
    for nome, topo in CORTE_TOPO.items():
        im = prontas["lista-escuro"]
        rec = im.crop((0, topo, im.width, im.height))
        rec.save(OUT / f"{nome}.png", "PNG")
        print("SAVED real/%s.png  %dx%d" % (nome, rec.width, rec.height))


if __name__ == "__main__":
    main()
