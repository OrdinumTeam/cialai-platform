#!/usr/bin/env python3
"""retoca_en.py — corrige o título das telas em inglês.

O Nano Banana Pro traduz o corpo das capturas, mas insiste em manter o título
`Terminais` na lista de sessões, provavelmente por lê-lo como nome de produto. As duas
palavras só diferem na oitava letra, `i` contra `l`, então a correção não precisa de
fonte: a haste do próprio `i` é reaproveitada, esticada até a altura da maiúscula e
plantada no lugar, com o ponto apagado. O resultado usa os pixels da fonte original.

Entrada: `real-en/<nome>-bruto.png`, a resposta crua do modelo.
Saída:   `real-en/<nome>.png`, já usada pelo compositor.

Uso:  <venv>/bin/python docs/retoca_en.py [nome ...]
Padrão: lista-escuro e lista-claro
"""
import pathlib
import sys

import numpy as np
from PIL import Image

BASE = pathlib.Path(__file__).resolve().parent.parent
PADRAO = ["lista-escuro", "lista-claro"]
FAIXA_TITULO = (100, 150)          # janela onde o título mora nas capturas de 786 px


def grupos_de_glifo(mascara):
    """Colunas contínuas com tinta, uma por glifo."""
    col = mascara.any(0)
    saida, inicio = [], None
    for x, v in enumerate(col):
        if v and inicio is None:
            inicio = x
        elif not v and inicio is not None:
            saida.append((inicio, x - 1))
            inicio = None
    if inicio is not None:
        saida.append((inicio, len(col) - 1))
    return saida


def corrige(nome):
    entrada = BASE / ("real-en/%s-bruto.png" % nome)
    saida = BASE / ("real-en/%s.png" % nome)
    img = Image.open(entrada).convert("RGB")
    a = np.asarray(img).astype(int)
    y0, y1 = FAIXA_TITULO
    cinza = np.asarray(img.convert("L")).astype(int)[y0:y1, :400]
    fundo = int(np.median(cinza[:, 300:400]))
    tinta = abs(cinza - fundo) > 60

    glifos = grupos_de_glifo(tinta)
    assert len(glifos) >= 3, "%s: título não encontrado" % nome
    x0, x1 = glifos[-2]                                   # o `i` antes do `s` final
    assert x1 - x0 <= 9, "%s: o penúltimo glifo não é uma haste" % nome

    sub = tinta[:, x0:x1 + 1]
    linhas = np.where(sub.any(1))[0]
    topo_ponto, base = y0 + int(linhas.min()), y0 + int(linhas.max())
    haste = np.where(sub[int(linhas.min()) + 6:].any(1))[0] + int(linhas.min()) + 6
    topo_haste = y0 + int(haste.min())
    assert topo_haste - topo_ponto > 4, "%s: glifo sem ponto, não é um i" % nome

    # altura da maiúscula, medida no T que abre a palavra
    xt0, xt1 = glifos[0]
    lt = np.where(tinta[:, xt0:xt1 + 1].any(1))[0]
    topo_maiuscula = y0 + int(lt.min())

    # a haste nova nasce da linha do meio do i, que é tinta cheia. O topo do i traz a
    # sombra do pingo, então ele não entra: o `l` do Montserrat termina reto em cima e
    # só precisa de uma linha suavizada para não virar degrau.
    corpo = a[topo_haste:base + 1, x0:x1 + 1]
    meio = corpo[len(corpo) // 2:len(corpo) // 2 + 1]
    cor_fundo = np.median(a[y0:y0 + 6, x1 + 12:x1 + 20], axis=(0, 1))
    topo_suave = np.rint(meio * 0.55 + cor_fundo * 0.45).astype(int)
    altura = base - topo_maiuscula + 1
    recheio = np.repeat(meio, max(0, altura - 4), axis=0)
    nova = np.concatenate([topo_suave, recheio, corpo[-3:]], axis=0)[:altura]

    # a limpeza sobe até o topo da faixa do título, para o pingo não deixar resto
    alto, baixo = y0, base + 2
    a[alto:baixo, x0 - 3:x1 + 4] = np.median(
        a[alto:baixo, x1 + 12:x1 + 20], axis=(0, 1)).astype(int)
    a[base + 1 - len(nova):base + 1, x0:x1 + 1] = nova

    Image.fromarray(a.astype("uint8")).save(saida, "PNG")
    print("RETOCADO", saida.name, "i -> l em x", x0, "altura", len(nova))


if __name__ == "__main__":
    for arquivo in (sys.argv[1:] or PADRAO):
        corrige(arquivo)
