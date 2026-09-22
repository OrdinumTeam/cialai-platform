#!/usr/bin/env python3
"""Cria a versão na App Store, anexa o build e envia à revisão da Apple.

O `asc_api.py` só lê. Este é o outro lado: é ele que muda a App Store Connect.
Por isso o padrão é o plano, no molde do `scripts/deploy-full.sh`. Sem
`--aplicar` nada sai daqui.

  python3 tools/release/asc_submit.py 0.2.8             mostra o plano
  python3 tools/release/asc_submit.py 0.2.8 --aplicar    executa
  python3 tools/release/asc_submit.py 0.2.8 --aplicar --ate anexar

Os textos da ficha saem de `docs/stores/listing-pt-BR.md`, dos blocos
`ASC_WHATS_NEW` e `ASC_PROMO`, e não são escritos aqui: a loja tem uma fonte só, conferida pelo
`npm run check:store-metadata`.

Cada passo é idempotente e relê o estado antes de agir, então repetir o comando
depois de uma falha no meio continua de onde parou em vez de duplicar.

As credenciais vêm de `ordinum-control/secrets`, pelas mesmas variáveis do
`asc_api.py`. Nada do conteúdo delas é impresso.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _stores import REPO_ROOT, env, token_apple  # noqa: E402

API = "https://api.appstoreconnect.apple.com"
PLATAFORMA = "IOS"
LISTAGEM = "docs/stores/listing-pt-BR.md"
# A ficha publicada tem uma localização só. Acrescentar idioma pede descrição,
# palavras chave e capturas próprias, que é outra entrega.
LOCAL_PADRAO = "pt-BR"
PASSOS = ("build", "versao", "textos", "anexar", "enviar")
LIMITE_NOVIDADES = 4000
LIMITE_PROMOCIONAL = 170

APLICAR = False


# Tudo com flush: fora de um terminal o Python segura a saída, e um aviso que
# sai por stderr apareceria fora de ordem, antes do passo que o gerou.
def azul(texto: str) -> None:
    print("\033[1;36m%s\033[0m" % texto, flush=True)


def verde(texto: str) -> None:
    print("\033[0;32m%s\033[0m" % texto, flush=True)


def aviso(texto: str) -> None:
    print("\033[0;33m%s\033[0m" % texto, file=sys.stderr, flush=True)


def erro(texto: str) -> None:
    sys.stdout.flush()
    sys.exit("\033[0;31m%s\033[0m" % texto)


def passo(texto: str) -> None:
    print("  %s" % texto, flush=True)


def peticao(metodo: str, caminho: str, corpo: dict | None = None) -> dict:
    """Uma chamada à API. Escrita não repete sozinha, para não duplicar recurso."""
    argumentos = [
        "curl", "-sS", "-g", "--http1.1",
        "-w", "\n__C__%{http_code}",
        "-X", metodo,
        "-H", "Authorization: Bearer " + TOKEN,
    ]
    if metodo == "GET":
        # Leitura pode repetir à vontade: a rede falha e isso não muda nada lá.
        argumentos[4:4] = ["--retry", "3", "--retry-all-errors"]
    if corpo is not None:
        argumentos += ["-H", "Content-Type: application/json", "-d", json.dumps(corpo)]
    argumentos.append(API + caminho)
    saida = subprocess.run(argumentos, capture_output=True, text=True, check=False)
    texto, _, codigo = saida.stdout.rpartition("__C__")
    codigo = codigo.strip()
    if codigo not in ("200", "201", "204"):
        erro("HTTP %s em %s %s\n%s" % (codigo or "000", metodo, caminho, (texto or saida.stderr)[:700]))
    return json.loads(texto) if texto.strip() else {}


def faria(descricao: str) -> bool:
    """Imprime o que faria fora do modo de aplicar. Devolve se deve executar."""
    if APLICAR:
        return True
    print("  faria: %s" % descricao)
    return False


def bloco_marcado(nome: str) -> str:
    """Conteúdo de um bloco `<!-- NOME_START -->` da listagem, sem a cerca."""
    caminho = os.path.join(REPO_ROOT, LISTAGEM)
    with open(caminho, encoding="utf-8") as fonte:
        texto = fonte.read()
    achado = re.search(
        r"<!-- %s_START -->\s*```text\n([\s\S]*?)\n```\s*<!-- %s_END -->" % (nome, nome), texto)
    if not achado:
        erro("falta o bloco %s em %s" % (nome, LISTAGEM))
    return achado.group(1).strip()


# ── passo 1: o build ─────────────────────────────────────────────────────────
def achar_build(versao: str) -> dict:
    azul("1/5 build, o que o Codemagic subiu")
    dados = peticao("GET", "/v1/builds?filter[app]=%s&limit=20&sort=-uploadedDate"
                           "&include=preReleaseVersion" % APP)
    marketing = {i["id"]: i["attributes"].get("version") for i in dados.get("included", [])}
    for item in dados.get("data", []):
        relacao = (item.get("relationships", {}).get("preReleaseVersion", {}).get("data") or {})
        if marketing.get(relacao.get("id")) != versao:
            continue
        estado = item["attributes"].get("processingState")
        numero = item["attributes"].get("version")
        if estado != "VALID":
            erro("o build %s da %s está em %s. Espere o processamento da Apple terminar"
                 % (numero, versao, estado))
        passo("build %s da %s, %s" % (numero, versao, estado))
        return item
    erro("nenhum build da %s na App Store Connect. Rode a etapa ios do deploy-full antes" % versao)


# ── passo 2: a versão ────────────────────────────────────────────────────────
# Estados em que a Apple ainda deixa editar a versão. Fora deles a versão já
# está com ela ou já saiu, e mexer é pedir outra versão, não corrigir esta.
EDITAVEL = {
    "PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED",
    "METADATA_REJECTED", "INVALID_BINARY",
}


def achar_ou_criar_versao(versao: str) -> dict | None:
    azul("2/5 versão na App Store")
    dados = peticao("GET", "/v1/apps/%s/appStoreVersions?filter[versionString]=%s"
                           "&filter[platform]=%s&limit=1" % (APP, versao, PLATAFORMA))
    existente = (dados.get("data") or [None])[0]
    if existente:
        estado = existente["attributes"].get("appStoreState")
        passo("versão %s já existe, em %s" % (versao, estado))
        if estado not in EDITAVEL:
            erro("a versão %s está em %s e não aceita mais edição. "
                 "Para corrigir, crie a versão seguinte" % (versao, estado))
        return existente

    passo("versão %s não existe ainda" % versao)

    # A Apple aceita UMA versão aberta por vez. Com outra em aberto, criar
    # devolve 409 e o motivo não é óbvio: "You cannot create a new version of
    # the App in the current state". Foi o que aconteceu com a 0.2.8, que ficou
    # em DEVELOPER_REJECTED e nunca chegou ao público.
    #
    # Renomear a vaga é o caminho certo, e não apagar: a versão aberta carrega
    # a ficha inteira já copiada da anterior, descrição, palavras chave,
    # capturas e detalhes de revisão. Só entra aqui versão que ainda não saiu,
    # pelo mesmo conjunto de estados que autoriza edição.
    todas = peticao("GET", "/v1/apps/%s/appStoreVersions?limit=10" % APP).get("data") or []
    aberta = next((v for v in todas if v["attributes"].get("appStoreState") in EDITAVEL), None)
    if aberta:
        antiga = aberta["attributes"].get("versionString")
        passo("a %s está aberta em %s e ocupa a única vaga de versão editável"
              % (antiga, aberta["attributes"].get("appStoreState")))
        if not faria("renomear a versão aberta de %s para %s" % (antiga, versao)):
            return None
        renomeada = peticao("PATCH", "/v1/appStoreVersions/%s" % aberta["id"], {
            "data": {"type": "appStoreVersions", "id": aberta["id"],
                     "attributes": {"versionString": versao, "releaseType": "AFTER_APPROVAL"}},
        })["data"]
        verde("  a vaga da %s virou a %s, com a ficha que já estava lá" % (antiga, versao))
        return renomeada

    anterior = (todas or [None])[0]
    direitos = (anterior["attributes"].get("copyright") if anterior else None)
    if not faria("criar a versão %s, liberação depois da aprovação" % versao):
        return None
    criada = peticao("POST", "/v1/appStoreVersions", {
        "data": {
            "type": "appStoreVersions",
            "attributes": {
                "platform": PLATAFORMA,
                "versionString": versao,
                # Sai sozinha quando a Apple aprovar, que é como a 0.2.2 saiu.
                "releaseType": "AFTER_APPROVAL",
                **({"copyright": direitos} if direitos else {}),
            },
            "relationships": {"app": {"data": {"type": "apps", "id": APP}}},
        },
    })["data"]
    verde("  versão %s criada" % versao)
    return criada


# ── passo 3: os textos da ficha ──────────────────────────────────────────────
# Novidades e texto promocional. Os dois vêm da listagem e os dois são
# regravados a cada envio, porque nenhum dos dois sobrevive sozinho: o
# promocional NAO é copiado quando a Apple cria a versão nova, e a 0.2.8 nasceu
# com ele vazio.
CAMPOS = (
    ("whatsNew", "ASC_WHATS_NEW", LIMITE_NOVIDADES, "novidades"),
    ("promotionalText", "ASC_PROMO", LIMITE_PROMOCIONAL, "texto promocional"),
)


def gravar_textos(versao_id: str | None) -> None:
    azul("3/5 textos da ficha")
    valores = {}
    for campo, bloco, limite, rotulo in CAMPOS:
        texto = bloco_marcado(bloco)
        passo("%s: %d dos %d caracteres" % (rotulo, len(texto), limite))
        if len(texto) > limite:
            erro("o %s passa do limite da Apple" % rotulo)
        valores[campo] = texto
    if versao_id is None:
        print("  faria: gravar os dois textos na localização %s" % LOCAL_PADRAO, flush=True)
        return
    locais = peticao("GET", "/v1/appStoreVersions/%s/appStoreVersionLocalizations" % versao_id)
    dados = locais.get("data") or []
    if not dados:
        erro("a versão não tem localização nenhuma. A Apple costuma copiar a da versão "
             "anterior; abra a versão no App Store Connect e confira a ficha")
    for local in dados:
        idioma = local["attributes"].get("locale")
        faltando = {campo: valor for campo, valor in valores.items()
                    if (local["attributes"].get(campo) or "") != valor}
        if not faltando:
            passo("%s já está com os dois textos" % idioma)
            continue
        if not faria("gravar %s em %s" % (" e ".join(sorted(faltando)), idioma)):
            continue
        peticao("PATCH", "/v1/appStoreVersionLocalizations/%s" % local["id"], {
            "data": {"type": "appStoreVersionLocalizations", "id": local["id"],
                     "attributes": faltando},
        })
        verde("  %s gravado em %s" % (" e ".join(sorted(faltando)), idioma))


# ── passo 4: anexar o build ──────────────────────────────────────────────────
def anexar_build(versao_id: str | None, build: dict) -> None:
    azul("4/5 anexar o build à versão")
    numero = build["attributes"].get("version")
    if versao_id is None:
        print("  faria: anexar o build %s à versão" % numero)
        return
    atual = peticao("GET", "/v1/appStoreVersions/%s/relationships/build" % versao_id).get("data")
    if atual and atual.get("id") == build["id"]:
        passo("o build %s já está anexado" % numero)
        return
    if not faria("anexar o build %s à versão" % numero):
        return
    peticao("PATCH", "/v1/appStoreVersions/%s/relationships/build" % versao_id,
            {"data": {"type": "builds", "id": build["id"]}})
    verde("  build %s anexado" % numero)


# ── passo 5: enviar à revisão ────────────────────────────────────────────────
ABERTAS = ("READY_FOR_REVIEW", "WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES")


def enviar_revisao(versao: str, versao_id: str | None) -> None:
    azul("5/5 enviar à revisão da Apple")
    if versao_id is None:
        print("  faria: abrir a submissão, acrescentar a versão %s e enviar" % versao)
        return
    abertas = peticao("GET", "/v1/reviewSubmissions?filter[app]=%s&filter[platform]=%s"
                             "&filter[state]=%s&limit=10"
                             % (APP, PLATAFORMA, ",".join(ABERTAS))).get("data") or []
    submissao = abertas[0] if abertas else None
    if submissao:
        estado = submissao["attributes"].get("state")
        passo("submissão aberta em %s" % estado)
        if estado != "READY_FOR_REVIEW":
            verde("  a versão %s já está com a Apple, em %s" % (versao, estado))
            return
    else:
        if not faria("abrir uma submissão de revisão"):
            return
        submissao = peticao("POST", "/v1/reviewSubmissions", {
            "data": {"type": "reviewSubmissions",
                     "attributes": {"platform": PLATAFORMA},
                     "relationships": {"app": {"data": {"type": "apps", "id": APP}}}},
        })["data"]
        passo("submissão aberta")

    itens = peticao("GET", "/v1/reviewSubmissions/%s/items" % submissao["id"]).get("data") or []
    ja_tem = any((i.get("relationships", {}).get("appStoreVersion", {}).get("data") or {})
                 .get("id") == versao_id for i in itens)
    if ja_tem:
        passo("a versão %s já está na submissão" % versao)
    elif faria("acrescentar a versão %s à submissão" % versao):
        peticao("POST", "/v1/reviewSubmissionItems", {
            "data": {"type": "reviewSubmissionItems", "relationships": {
                "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": submissao["id"]}},
                "appStoreVersion": {"data": {"type": "appStoreVersions", "id": versao_id}},
            }},
        })
        passo("versão acrescentada")

    if not faria("enviar a submissão à Apple"):
        return
    peticao("PATCH", "/v1/reviewSubmissions/%s" % submissao["id"], {
        "data": {"type": "reviewSubmissions", "id": submissao["id"],
                 "attributes": {"submitted": True}},
    })
    verde("  a %s foi enviada à revisão da Apple" % versao)


def main() -> None:
    global APLICAR, TOKEN, APP
    argumentos = sys.argv[1:]
    if not argumentos or argumentos[0] in ("-h", "--help"):
        sys.exit(__doc__)
    versao = argumentos[0]
    if not re.fullmatch(r"\d+\.\d+\.\d+", versao):
        erro("versão fora do formato x.y.z: %s" % versao)
    APLICAR = "--aplicar" in argumentos
    ate = PASSOS[-1]
    if "--ate" in argumentos:
        ate = argumentos[argumentos.index("--ate") + 1]
        if ate not in PASSOS:
            erro("passo desconhecido: %s. Use um de: %s" % (ate, ", ".join(PASSOS)))
    limite = PASSOS.index(ate)

    APP = env("APP_STORE_APP_ID")
    TOKEN = token_apple()
    azul("envio da %s à App Store, app %s" % (versao, APP))
    if not APLICAR:
        aviso("modo plano: nada sai para fora. Rode com --aplicar para valer.")

    build = achar_build(versao)
    if limite < PASSOS.index("versao"):
        return
    versao_recurso = achar_ou_criar_versao(versao)
    versao_id = versao_recurso["id"] if versao_recurso else None
    if limite >= PASSOS.index("textos"):
        gravar_textos(versao_id)
    if limite >= PASSOS.index("anexar"):
        anexar_build(versao_id, build)
    if limite >= PASSOS.index("enviar"):
        enviar_revisao(versao, versao_id)
    print()
    if APLICAR:
        verde("envio da %s concluído" % versao)
    else:
        aviso("fim do plano. Rode de novo com --aplicar para executar.")


if __name__ == "__main__":
    main()
