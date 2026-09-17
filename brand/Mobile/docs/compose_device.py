#!/usr/bin/env python3
"""compose_device.py — Screenshots de loja do Cialai por COMPOSITING.

Mesma receita validada na Advoris e no CowSynch, traduzida para a marca Cialai. O Nano
Banana Pro renderiza só o aparelho com a tela CHROMA MAGENTA; aqui a captura real entra
por cima em PIL, pixel a pixel, com cantos arredondados e Dynamic Island preservados e o
app começando abaixo do notch. Headline e subtítulo são escritos na Outfit, a fonte do
site do Cialai, nunca desenhados pela IA.

As três telas nativas sem captura real, Parear, Computadores e Ajustes, vêm desenhadas
pela IA em `ia/` e entram pela mesma cola, marcadas como provisórias na MATRIZ.

Uso:  <venv>/bin/python docs/compose_device.py [chave ...]
"""
import sys
import pathlib

import numpy as np
from PIL import Image, ImageDraw, ImageFont

BASE = pathlib.Path(__file__).resolve().parent.parent
FONTE = str(BASE / "brand/fonts/Outfit-Variable.ttf")  # eixo wght 100 a 900
PESO_HEAD, PESO_SUB = 600, 400                           # display e corpo

CW, CH = 2160, 3840                                      # 9:16

BG = (251, 243, 247)                                     # #FBF3F7 superfície da marca
TEXTO = (58, 27, 51)                                     # #3A1B33 ameixa
TEXTO2 = (107, 79, 99)                                   # #6B4F63 texto secundário

HEAD_SZ, SUB_SZ = 140, 64

# ---- CONFIG por slide ----
# disp "full"   texto em cima, aparelho inteiro centralizado embaixo
# disp "bottom" texto em cima, aparelho grande subindo da base e cortado nela
# origem "real" captura do app; "ia" tela desenhada, provisória
SLIDES = {
    "slide-1-terminais": dict(
        screen="real/lista-escuro.png", out="slides/slide-1-terminais.png", disp="full", origem="real",
        head=["Todos os seus terminais,", "no celular."],
        sub=["Cada sessão do computador,", "com estado, agente e consumo."],
    ),
    "slide-2-terminal": dict(
        screen="real/terminal.png", out="slides/slide-2-terminal.png", disp="bottom", origem="real",
        head=["Acompanhe o agente", "e assuma o terminal."],
        sub=["Histórico ao vivo e teclas essenciais", "na mesma tela."],
    ),
    "slide-3-parear": dict(
        screen="ia/parear.png", out="slides/slide-3-parear.png", disp="full", origem="ia",
        head=["Vincule o celular", "com um código QR."],
        sub=["Código de curta duração,", "sem conta e sem servidor."],
    ),
    "slide-4-computadores": dict(
        screen="ia/computadores.png", out="slides/slide-4-computadores.png", disp="bottom", origem="ia",
        head=["Seus computadores,", "com o estado da conexão."],
        sub=["Direta quando a rede permite,", "pelo Tor como reserva."],
    ),
    "slide-5-arquivos": dict(
        screen="real/arquivos.png", out="slides/slide-5-arquivos.png", disp="full", origem="real",
        head=["Navegue pelos", "arquivos do projeto."],
        sub=["Somente leitura,", "só nas pastas liberadas no computador."],
    ),
    "slide-6-agente": dict(
        screen="real/agente.png", out="slides/slide-6-agente.png", disp="bottom", origem="real",
        head=["Veja o que o agente", "está fazendo."],
        sub=["Modelo, esforço, contexto e custo", "em cada sessão."],
    ),
    "slide-7-ajustes": dict(
        screen="ia/ajustes.png", out="slides/slide-7-ajustes.png", disp="full", origem="ia",
        head=["Segurança", "no próprio aparelho."],
        sub=["Biometria em cada ação sensível,", "idioma e tema à sua escolha."],
    ),
    "slide-8-tema": dict(
        screen="real/lista-claro.png", out="slides/slide-8-tema.png", disp="bottom", origem="real",
        head=["Claro ou escuro,", "como o sistema."],
        sub=["A mesma lista,", "no tema do seu aparelho."],
    ),
}
PHONE = "_work/phone-chroma.png"

PROIBIDO = ["(", ")", " - ", "–", "—"]         # parênteses, hífen solto, meia-risca, travessão
for _k, _cfg in SLIDES.items():
    for _ln in _cfg["head"] + _cfg["sub"]:
        for _p in PROIBIDO:
            assert _p not in _ln, f"{_k}: texto visível com {_p!r}: {_ln!r}"


GROW = 3        # folga em volta da tela, para alcançar a borda antisserrilhada do chroma


def fonte(peso, tamanho):
    """Outfit Variable no peso pedido. Cada instância precisa fixar o eixo de novo."""
    f = ImageFont.truetype(FONTE, tamanho)
    f.set_variation_by_axes([peso])
    return f


def composite_device(device_path, screen_path, bg, fill_mode="width"):
    """Cola a tela na tela chroma e achata o fundo do render na cor do slide."""
    A = np.asarray(Image.open(BASE / device_path).convert("RGB")).astype(int)
    r, g, b = A[..., 0], A[..., 1], A[..., 2]
    mag = (r > 150) & (g < 120) & (b > 150)                    # tela chroma magenta
    ys, xs = np.where(mag)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    tw, th = x1 - x0, y1 - y0
    # Dynamic Island e cantos escuros no topo da tela, o app começa abaixo deles
    sub = A[y0:y1, x0:x1]
    dark = (sub[..., 0] < 60) & (sub[..., 1] < 60) & (sub[..., 2] < 60)
    tzone = dark[: int(th * 0.15)]
    island_bottom = int(np.where(tzone.any(1))[0].max()) if tzone.any() else int(th * 0.06)
    inset = island_bottom + 22

    si = Image.open(BASE / screen_path).convert("RGB")
    top_bg = np.median(np.asarray(si)[:4], axis=(0, 1)).astype(int).tolist()   # faixa de status na cor do app
    aw, ah = tw, th - inset
    if fill_mode == "cover":
        sc = max(aw / si.width, ah / si.height)
        si = si.resize((round(si.width * sc), round(si.height * sc)), Image.LANCZOS)
        left = (si.width - aw) // 2
        sarr = np.asarray(si.crop((left, 0, left + aw, ah))).astype(int)
    else:
        si = si.resize((aw, round(si.height * aw / si.width)), Image.LANCZOS)
        sarr = np.asarray(si).astype(int)[:ah]
    fill = np.full((th, tw, 3), top_bg, dtype=int)
    fill[inset:inset + sarr.shape[0], :] = sarr
    # a moldura cresce por replicação de borda, para a dilatação não deixar faixa clara
    fill = np.pad(fill, ((GROW, GROW), (GROW, GROW), (0, 0)), mode="edge")

    # máscara suave: quanto mais magenta o pixel, mais ele cede lugar à tela.
    # a borda antisserrilhada mistura em vez de virar degrau, então a moldura preta
    # continua preta e não sobra nem halo magenta nem fio claro por cima dela.
    out = A.copy()
    sl = (slice(y0 - GROW, y1 + GROW), slice(x0 - GROW, x1 + GROW))
    reg = out[sl].astype(float)
    rr, gg, bb_ = reg[..., 0], reg[..., 1], reg[..., 2]
    alpha = np.clip((np.minimum(rr, bb_) - gg - 15) / 70.0, 0, 1)[..., None]
    out[sl] = np.rint(reg * (1 - alpha) + fill * alpha).astype(int)
    escrito = np.zeros(A.shape[:2], bool)                      # onde a tela de fato entrou
    escrito[sl] = alpha[..., 0] > 0.02

    # resto de tinta magenta refletida na moldura e no entorno do notch vira neutro.
    # Só fora da tela colada: o rosa #FF7AB2 do Cialai cai no mesmo critério e viraria
    # pêssego se a limpeza passasse por dentro do app.
    r, g, b = out[..., 0], out[..., 1], out[..., 2]
    roxo = (g < np.minimum(r, b) - 25) & (r > 40) & (b > 40) & ~escrito
    out[..., 1] = np.where(roxo, (r + b) // 2, g)

    # o fundo branco do render vira a cor do slide, sem tocar na tela colada
    corner = np.median(np.stack([out[5, 5], out[5, -5], out[-5, 5], out[-5, -5]]), 0)
    chapa = np.abs(out - corner).sum(2) < 45
    chapa[escrito] = False
    out[chapa] = bg
    nonbg = np.abs(out - np.array(bg)).sum(2) > 18
    ys2, xs2 = np.where(nonbg)
    bb = (xs2.min(), ys2.min(), xs2.max() + 1, ys2.max() + 1)
    return Image.fromarray(out.astype("uint8")).crop(bb)


def fit(d, linhas, peso, base_sz, minimo, maxw):
    sz = base_sz
    while sz > minimo and max(d.textlength(l, font=fonte(peso, sz)) for l in linhas) > maxw:
        sz -= 4
    return fonte(peso, sz), sz


def ctext(d, y, txt, font, fill, cw):
    d.text(((cw - d.textlength(txt, font=font)) / 2, y), txt, font=font, fill=fill, anchor="la")


def compor(cfg, cw=CW, ch=CH, device_path=PHONE, phone_frac=None, bottom_frac=None):
    """Monta um slide na proporção pedida. As medidas de texto acompanham a largura,
    então a mesma receita serve para 9:16 e para o retrato da Apple."""
    k = cw / CW
    canvas = Image.new("RGB", (cw, ch), BG)
    d = ImageDraw.Draw(canvas)
    head, sub = cfg["head"], cfg["sub"]

    maxw = cw - 2 * int(cw * 0.075)
    fh, hs = fit(d, head, PESO_HEAD, int(HEAD_SZ * k), int(84 * k), maxw)
    fb, ss = fit(d, sub, PESO_SUB, int(SUB_SZ * k), int(42 * k), maxw)
    hlh, slh, sgap = int(hs * 1.22), int(ss * 1.45), int(hs * 0.66)
    nblock = hlh * len(head) + sgap + slh * len(sub)

    device = composite_device(device_path, cfg["screen"], BG).convert("RGBA")
    text_top = int(ch * 0.075)

    if cfg["disp"] == "bottom":                    # aparelho grande, cortado na base
        pw = int(cw * (bottom_frac or 0.80))
        ph = int(device.height * pw / device.width)
        device = device.resize((pw, ph), Image.LANCZOS)
        # um quarto do aparelho sempre sai pela base, em qualquer proporção de tela,
        # respeitado o respiro mínimo depois do texto
        y = max(text_top + nblock + int(ch * 0.055), ch - int(ph * 0.75))
        canvas.paste(device, ((cw - pw) // 2, y), device)
        text_top = max(text_top, (y - nblock) // 2)     # texto centrado no espaço livre
    else:                                          # aparelho inteiro, centralizado
        area_top = text_top + nblock + int(ch * 0.05)
        area_bot = ch - int(ch * 0.04)
        sc = min((area_bot - area_top) / device.height,
                 (cw * (phone_frac or 0.62)) / device.width)
        pw, ph = int(device.width * sc), int(device.height * sc)
        device = device.resize((pw, ph), Image.LANCZOS)
        canvas.paste(device, ((cw - pw) // 2, area_top + (area_bot - area_top - ph) // 2), device)

    y = text_top
    for ln in head:
        ctext(d, y, ln, fh, TEXTO, cw)
        y += hlh
    y = text_top + hlh * len(head) + sgap
    for ln in sub:
        ctext(d, y, ln, fb, TEXTO2, cw)
        y += slh
    return canvas


def render(key):
    cfg = SLIDES[key]
    (BASE / "slides").mkdir(exist_ok=True)
    compor(cfg).save(BASE / cfg["out"], "PNG")
    print("SAVED", cfg["out"])


if __name__ == "__main__":
    for k in (sys.argv[1:] or list(SLIDES)):
        render(k)
