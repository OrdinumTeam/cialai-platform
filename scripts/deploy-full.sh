#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# deploy-full: uma entrega inteira do Cialai, do número da versão ao anúncio.
#
# Cobre macOS, Linux e Windows pela release do GitHub, Android pelo Codemagic
# com o APK anexado e espelhado, iOS pelo TestFlight, o espelho do site que o
# `curl | bash` lê, e o anúncio no Discord. Cada etapa é idempotente e dá para
# retomar de onde parou, porque uma entrega leva dezenas de minutos e falhar no
# meio é normal.
#
# Sem `--aplicar` ele só mostra o plano. Nada sai para fora nesse modo.
#
#   scripts/deploy-full.sh 0.2.7
#   scripts/deploy-full.sh 0.2.7 --aplicar
#   scripts/deploy-full.sh 0.2.7 --aplicar --de site
#   scripts/deploy-full.sh 0.2.7 --aplicar --ate marcar
#   scripts/deploy-full.sh 0.2.7 --aplicar --pular ios
#
# A documentação está em scripts/README.md.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE="${CIALAI_SITE_REPO:-$(cd "$RAIZ/../cialai-website" 2>/dev/null && pwd || true)}"
REPO="${CIALAI_REPO:-OrdinumTeam/cialai-platform}"
ETAPAS=(preparar enviar linux marcar desktop android ios site anuncio conferir)

VERSAO=""
APLICAR=0
DE="preparar"
ATE="conferir"
PULAR=""

# ── saída ────────────────────────────────────────────────────────────────────
azul() { printf '\033[1;36m%s\033[0m\n' "$*"; }
verde() { printf '\033[0;32m%s\033[0m\n' "$*"; }
# Sucesso só se aconteceu: no plano a etapa não concluiu nada.
feito() { [[ "$APLICAR" == 1 ]] && verde "$*"; return 0; }
aviso() { printf '\033[0;33m%s\033[0m\n' "$*" >&2; }
erro() { printf '\033[0;31m%s\033[0m\n' "$*" >&2; exit 1; }
IMPEDIMENTOS=0
# Trava de segurança. Com --aplicar ela para tudo; no plano ela só relata, para
# a pessoa ver de uma vez tudo que falta antes de rodar para valer.
exigir() {
  local condicao="$1" mensagem="$2"
  if eval "$condicao"; then return 0; fi
  if [[ "$APLICAR" == 1 ]]; then erro "$mensagem"; fi
  aviso "  impedimento: $mensagem"
  IMPEDIMENTOS=$((IMPEDIMENTOS + 1))
  return 1
}
passo() { printf '  %s\n' "$*"; }
titulo() { local nome="$1"; shift; azul "$(( $(indice_de "$nome") + 1 ))/${#ETAPAS[@]} $*"; }

# Executa de verdade só com --aplicar; caso contrário imprime o que faria.
faz() {
  if [[ "$APLICAR" == 1 ]]; then
    "$@"
  else
    printf '  faria: %s\n' "$*"
  fi
}

# ── argumentos ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --aplicar) APLICAR=1; shift ;;
    --de) DE="${2:?informe a etapa}"; shift 2 ;;
    --ate) ATE="${2:?informe a etapa}"; shift 2 ;;
    --pular) PULAR="${2:?informe as etapas}"; shift 2 ;;
    -h|--help) sed -n '3,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) erro "opção desconhecida: $1" ;;
    *) VERSAO="$1"; shift ;;
  esac
done

[[ -n "$VERSAO" ]] || erro "informe a versão, por exemplo: scripts/deploy-full.sh 0.2.7"
[[ "$VERSAO" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || erro "versão fora do formato x.y.z: $VERSAO"
TAG="v$VERSAO"

indice_de() {
  local alvo="$1" i=0
  for etapa in "${ETAPAS[@]}"; do
    [[ "$etapa" == "$alvo" ]] && { printf '%s' "$i"; return 0; }
    i=$((i + 1))
  done
  erro "etapa desconhecida: $alvo. Use uma de: ${ETAPAS[*]}"
}
INICIO="$(indice_de "$DE")"
FIM="$(indice_de "$ATE")"
[[ "$INICIO" -le "$FIM" ]] || erro "--de vem depois de --ate"

roda_etapa() {
  local nome="$1" i
  i="$(indice_de "$nome")"
  [[ "$i" -ge "$INICIO" && "$i" -le "$FIM" ]] || return 1
  case ",$PULAR," in *",$nome,"*) aviso "etapa $nome pulada a pedido"; return 1 ;; esac
  return 0
}

# ── ferramentas necessárias ──────────────────────────────────────────────────
exige() { command -v "$1" >/dev/null 2>&1 || erro "$1 não encontrado no PATH"; }
exige git; exige gh; exige node; exige python3

# Segredos de release. Eles moram fora deste repositório, no ordinum-control, e
# em DOIS arquivos: `ordinum/ordinum.env` traz o que é da conta Ordinum, como o
# token do Codemagic e a chave da App Store Connect, e `cialai/cialai.env` traz
# o que é deste app. Carregar só o segundo deixa o Codemagic sem token, e foi
# isso que travou Android e iOS na 0.2.7. Nada do conteúdo é impresso.
carregar_segredos() {
  local base="${CIALAI_SECRETS_DIR:-}" candidato
  if [[ -z "$base" ]]; then
    for candidato in \
      "$RAIZ/../ordinum-control/secrets" \
      "$HOME/Ordinum/Repos/OrdinumTeam/ordinum-control/secrets"; do
      if [[ -d "$candidato" ]]; then base="$(cd "$candidato" && pwd)"; break; fi
    done
  fi
  [[ -n "$base" && -d "$base" ]] || return 0
  SEGREDOS="$base"
  set -a
  # shellcheck source=/dev/null
  [[ -f "$base/ordinum/ordinum.env" ]] && . "$base/ordinum/ordinum.env"
  # shellcheck source=/dev/null
  [[ -f "$base/cialai/cialai.env" ]] && . "$base/cialai/cialai.env"
  set +a
  # Os caminhos de chave nesses arquivos são relativos e resolvem contra a raiz
  # de um repositório, onde as chaves não estão. Aqui viram absolutos.
  local variavel valor
  for variavel in APP_STORE_CONNECT_PRIVATE_KEY_PATH APP_STORE_CONNECT_NOTARY_PRIVATE_KEY_PATH \
    GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH IOS_DISTRIBUTION_CERT_KEY_PATH APNS_AUTH_KEY_PATH \
    DEVELOPER_ID_APPLICATION_PASSWORD_PATH; do
    valor="${!variavel:-}"
    [[ -n "$valor" && ! -f "$valor" ]] || continue
    if [[ -f "$base/ordinum/$(basename "$valor")" ]]; then
      export "$variavel=$base/ordinum/$(basename "$valor")"
    elif [[ -f "$base/cialai/$(basename "$valor")" ]]; then
      export "$variavel=$base/cialai/$(basename "$valor")"
    fi
  done
  export CIALAI_RELEASE_ENV_FILE="${CIALAI_RELEASE_ENV_FILE:-$base/cialai/cialai.env}"
}
SEGREDOS=""
carregar_segredos

# O repositório exige Node 22; o `node` do PATH pode ser outro.
NODE22="/opt/homebrew/opt/node@22/bin"
[[ -d "$NODE22" ]] && export PATH="$NODE22:$PATH"

cd "$RAIZ"

# ── etapa 1: preparar ────────────────────────────────────────────────────────
# Tudo que é local e reversível acontece aqui: número da versão, página da
# release e a bateria de testes. Nada sai para fora.
definir_versao() {
  local nova="$1"
  python3 - "$nova" <<'PY'
import io, json, re, sys
nova = sys.argv[1]
def json_versao(caminho, chaves=('version',)):
    with io.open(caminho, encoding='utf-8') as f: texto = f.read()
    for chave in chaves:
        texto = re.sub(rf'("{chave}": ")[^"]+(")', rf'\g<1>{nova}\g<2>', texto, count=1)
    with io.open(caminho, 'w', encoding='utf-8') as f: f.write(texto)

for caminho in ['package.json', 'packages/tunnel-core/package.json', 'packages/protocol/package.json',
                'apps/desktop/package.json', 'apps/mobile/package.json',
                'apps/desktop/src-tauri/tauri.conf.json']:
    json_versao(caminho)

# packages/ui depende do protocol pela versão exata.
with io.open('packages/ui/package.json', encoding='utf-8') as f: texto = f.read()
texto = re.sub(r'("version": ")[^"]+(")', rf'\g<1>{nova}\g<2>', texto, count=1)
texto = re.sub(r'("@cialai/protocol": ")[^"]+(")', rf'\g<1>{nova}\g<2>', texto, count=1)
with io.open('packages/ui/package.json', 'w', encoding='utf-8') as f: f.write(texto)

# Cargo.toml: só a versão do pacote, no topo, nunca a de uma dependência.
with io.open('apps/desktop/src-tauri/Cargo.toml', encoding='utf-8') as f: texto = f.read()
texto = re.sub(r'(?m)^(version = ")[^"]+(")', rf'\g<1>{nova}\g<2>', texto, count=1)
with io.open('apps/desktop/src-tauri/Cargo.toml', 'w', encoding='utf-8') as f: f.write(texto)

with io.open('apps/mobile/app.config.ts', encoding='utf-8') as f: texto = f.read()
texto = re.sub(r"(version: ')[^']+(')", rf'\g<1>{nova}\g<2>', texto, count=1)
with io.open('apps/mobile/app.config.ts', 'w', encoding='utf-8') as f: f.write(texto)
print(f'versão gravada em nove arquivos: {nova}')
PY
  npm install --package-lock-only --silent
  ( cd apps/desktop/src-tauri && cargo update --workspace --offline >/dev/null 2>&1 || cargo check --quiet >/dev/null 2>&1 || true )
}

etapa_preparar() {
  titulo preparar "preparar, local e reversível"
  local atual
  atual="$(node -p "require('./package.json').version")"
  passo "versão atual $atual, alvo $VERSAO"

  # Árvore suja não impede: neste repositório o commit de release carrega o
  # trabalho da entrega, então o normal é ter mudanças aqui. O que importa é
  # mostrar o que vai junto, para nada entrar na release por engano.
  local pendentes
  pendentes="$(git status --porcelain | wc -l | tr -d ' ')"
  if [[ "$pendentes" != "0" ]]; then
    passo "$pendentes arquivos entram no commit da release"
    git status --short | head -8 | sed 's/^/    /'
    [[ "$pendentes" -gt 8 ]] && passo "    e mais $((pendentes - 8))"
  fi
  exigir '[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]]' "o deploy sai da main" || true
  git fetch --quiet origin || true
  exigir '[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]]' "a main local está diferente de origin/main" || true
  exigir '! git rev-parse "$TAG" >/dev/null 2>&1' "a tag $TAG já existe localmente" || true

  if [[ "$atual" != "$VERSAO" ]]; then
    faz definir_versao "$VERSAO"
  else
    passo "a versão já está em $VERSAO"
  fi

  if exigir '[[ -f "docs/releases/$VERSAO.md" ]]' "falta docs/releases/$VERSAO.md, que o anúncio do Discord lê. Crie a página antes"; then
    passo "página da release presente"
  fi

  if [[ -n "$SEGREDOS" ]]; then
    passo "segredos de release em ${SEGREDOS/#$HOME/~}"
    [[ -n "${CODEMAGIC_API_TOKEN:-}" ]] || aviso "  sem CODEMAGIC_API_TOKEN: as etapas android e ios vão parar"
  else
    aviso "  pasta de segredos não encontrada: as etapas android e ios vão parar. Aponte CIALAI_SECRETS_DIR"
  fi

  azul "  testes e portões"
  faz npm test
  faz npm run build:ui --workspace @cialai/desktop
  faz npm run test:browser
  faz npm run check:performance
  faz node tools/release/check-updater.mjs
  faz node tools/release/release-channel.mjs "$TAG"
  feito "  preparar concluído"
}

# ── etapa 2: enviar ──────────────────────────────────────────────────────────
# Primeiro passo público. A tag fica para depois do portão do Linux.
etapa_enviar() {
  titulo enviar "enviar o trabalho, a partir daqui é público"
  if [[ -n "$(git status --porcelain)" ]]; then
    # A mensagem segue o padrão do repositório: a primeira frase do Resumo da
    # página da release, em vez de um `release: x.y.z` seco.
    local assunto
    assunto="$(python3 - "docs/releases/$VERSAO.md" "$VERSAO" <<'PYMSG'
import io, re, sys
pagina, versao = sys.argv[1], sys.argv[2]
texto = io.open(pagina, encoding='utf-8').read()
bloco = re.search(r'## Resumo\s+(.+?)\n\n', texto, re.S)
frase = re.split(r'(?<=[.!?])\s', bloco.group(1).strip())[0] if bloco else ''
frase = frase.rstrip('.').strip()
frase = frase[0].lower() + frase[1:] if frase else 'entrega publicada'
print(f'release: {versao} {frase}'[:100])
PYMSG
)"
    faz git add -A
    if [[ -n "${CIALAI_COMMIT_TRAILER:-}" ]]; then
      faz git commit -m "$assunto" -m "$CIALAI_COMMIT_TRAILER"
    else
      faz git commit -m "$assunto"
    fi
  else
    passo "nada novo para commitar"
  fi
  faz git push origin main
  feito "  trabalho na main"
}

# ── etapa 3: linux ───────────────────────────────────────────────────────────
# O empacotamento do Linux é o que mais quebra, e quebra por coisa de fora: o
# linuxdeploy muda o layout do AppDir e o `fix-appimage.mjs` para. Isso não
# aparece em `npm test`, porque nada ali monta um AppImage. Então o AppImage é
# construído e aberto ANTES da tag, pelo workflow de smoke. Sem este portão a
# falha só apareceria com a tag criada e a release pela metade, que foi o que
# aconteceu na 0.2.7.
etapa_linux() {
  titulo linux "linux, provar o AppImage antes da tag"
  if [[ "$APLICAR" != 1 ]]; then
    passo "faria: disparar o appimage-smoke na main e esperar"
    return 0
  fi
  # O portão só serve se o workflow estiver ligado. Ele já esteve desligado, e
  # foi por isso que a mudança de layout do AppDir chegou até a tag.
  local estado
  estado="$(gh workflow list --repo "$REPO" --all --json name,state --jq '.[] | select(.name=="AppImage smoke") | .state')"
  if [[ "$estado" != "active" ]]; then
    erro "o workflow AppImage smoke está $estado. Ligue com: gh workflow enable appimage-smoke.yml --repo $REPO"
  fi
  local antes depois id
  antes="$(gh run list --repo "$REPO" --workflow appimage-smoke.yml --limit 1 --json databaseId --jq '.[0].databaseId // 0')"
  gh workflow run appimage-smoke.yml --repo "$REPO" --ref main
  for _ in $(seq 1 30); do
    depois="$(gh run list --repo "$REPO" --workflow appimage-smoke.yml --limit 1 --json databaseId --jq '.[0].databaseId // 0')"
    [[ "$depois" != "$antes" ]] && { id="$depois"; break; }
    sleep 10
  done
  [[ -n "${id:-}" ]] || erro "o appimage-smoke não começou"
  passo "acompanhando o run $id"
  # Sem --exit-status: o veredito sai do conteúdo do log, e não do verde do
  # workflow. O motivo é concreto. O smoke roda dois modos, o AppImage e a
  # árvore extraída, e o segundo nunca teve execução verde neste repositório,
  # porque o workflow ficou desligado. Na 0.2.7 ele reprovou medindo o processo
  # da execução anterior, o mesmo pid nas duas checagens. Bloquear a entrega
  # num sinal desses é bloquear por defeito do arnês, não do produto.
  #
  # O que vale é o que o usuário baixa e abre: o AppImage, em cada distro.
  gh run watch "$id" --repo "$REPO" >/dev/null 2>&1 || true
  local log montagem faltou=0
  montagem="$(gh run view "$id" --repo "$REPO" --json jobs --jq '.jobs[] | select(.name=="AppImage corrigido") | .conclusion')"
  [[ "$montagem" == "success" ]] || erro "o AppImage não montou; o fix-appimage parou. Veja o run $id"
  log="$(gh run view "$id" --repo "$REPO" --log 2>/dev/null || true)"
  local distro
  for distro in archlinux ubuntu-24.04; do
    if grep -q "appimage: janela Cialai" <<<"$(grep "Smoke / $distro" <<<"$log")"; then
      passo "$distro: o AppImage abriu e desenhou a janela"
    else
      aviso "  $distro: o AppImage NÃO abriu"
      faltou=$((faltou + 1))
    fi
    if grep -q "FAIL: extraido" <<<"$(grep "Smoke / $distro" <<<"$log")"; then
      aviso "  $distro: a árvore extraída reprovou, sem bloquear. O modo ainda não tem base verde"
    fi
  done
  local problemas
  problemas="$(grep -cE "Aborting|undefined symbol|error while loading shared libraries|core dumped" <<<"$log" || true)"
  [[ "$problemas" == "0" ]] || erro "o log do smoke mostra falha de biblioteca ou queda. Veja o run $id"
  [[ "$faltou" == "0" ]] || erro "o AppImage não abriu em $faltou distro ou distros. Veja o run $id"
  feito "  o AppImage monta e abre nas duas distros"
}

# ── etapa 4: marcar ──────────────────────────────────────────────────────────
etapa_marcar() {
  titulo marcar "marcar, a tag dispara os instaladores"
  if git rev-parse "$TAG" >/dev/null 2>&1 || gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    passo "tag $TAG já existe, nada a marcar"
    return 0
  fi
  faz git tag -a "$TAG" -m "Cialai $VERSAO"
  faz git push origin "$TAG"
  feito "  tag $TAG enviada, o release.yml começou"
}

# ── etapa 5: desktop ─────────────────────────────────────────────────────────
# macOS arm64 e Intel, Linux e Windows saem do release.yml.
etapa_desktop() {
  titulo desktop "desktop, macOS, Linux e Windows pelo release.yml"
  if [[ "$APLICAR" != 1 ]]; then
    passo "faria: acompanhar o release.yml da tag $TAG até a release sair do rascunho"
    return 0
  fi
  # O mais recente, nunca o primeiro que casar. Uma tentativa anterior da mesma
  # tag deixa um run velho na lista, e `first` pegava justamente ele: o
  # acompanhamento reportava a falha antiga como se fosse a de agora.
  local id=""
  for _ in $(seq 1 30); do
    id="$(gh run list --repo "$REPO" --workflow release.yml --limit 20 \
      --json databaseId,headBranch,status \
      --jq "[.[] | select(.headBranch==\"$TAG\")] | max_by(.databaseId) | .databaseId" 2>/dev/null || true)"
    [[ -n "$id" && "$id" != "null" ]] && break
    sleep 10
  done
  [[ -n "$id" && "$id" != "null" ]] || erro "não achei o run do release.yml para $TAG"
  passo "acompanhando o run $id"
  gh run watch "$id" --repo "$REPO" --exit-status
  local rascunho
  rascunho="$(gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft)"
  [[ "$rascunho" == "false" ]] || erro "a release $TAG continua em rascunho"
  verde "  release $TAG publicada com os instaladores de desktop"
}

# ── etapa 4: android ─────────────────────────────────────────────────────────
# O APK não faz parte da release do desktop: sai do Codemagic e é anexado com
# nome estável, para /releases/latest/download continuar valendo.
etapa_android() {
  titulo android "android, APK pelo Codemagic e anexado à release"
  local nome="Cialai_android_universal.apk"
  if [[ "$APLICAR" == 1 ]] && gh release view "$TAG" --repo "$REPO" --json assets \
      --jq ".assets[].name" 2>/dev/null | grep -qx "$nome"; then
    passo "o APK já está anexado à release"
    return 0
  fi
  if [[ "$APLICAR" != 1 ]]; then
    passo "faria: disparar o android-play no Codemagic, baixar o $nome e anexar à release"
    passo "faria: refazer SHA256SUMS"
    return 0
  fi
  local build
  build="$(bash tools/release/cm-trigger.sh android-play main)"
  passo "build $build no Codemagic"
  bash tools/release/cm-watch.sh "$build"
  local destino="$RAIZ/.deploy-full/$nome"
  bash tools/release/cm-artifact.sh "$build" .apk "$destino" >/dev/null
  [[ -s "$destino" ]] || erro "o APK não chegou em $destino. Confira os artifacts do build $build e rode de novo com --de android"
  gh release upload "$TAG" "$destino" --repo "$REPO" --clobber
  GH_REPO="$REPO" node tools/release/release-assets.mjs checksums "$TAG"
  verde "  APK anexado e somas refeitas"
}

# ── etapa 5: ios ─────────────────────────────────────────────────────────────
# Vai ao TestFlight; não existe arquivo para baixar nem para espelhar.
etapa_ios() {
  titulo ios "ios, TestFlight pelo Codemagic"
  if [[ "$APLICAR" != 1 ]]; then
    passo "faria: disparar o ios-testflight no Codemagic e acompanhar"
    passo "lembrete: liberar o build para testadores e enviar à revisão fica no App Store Connect"
    return 0
  fi
  local build
  build="$(bash tools/release/cm-trigger.sh ios-testflight main)"
  passo "build $build no Codemagic"
  bash tools/release/cm-watch.sh "$build"
  verde "  build enviado ao TestFlight"
  aviso "  liberar para testadores e enviar à revisão continua manual, no App Store Connect"
}

# ── etapa 6: site ────────────────────────────────────────────────────────────
# O espelho é o que o `curl | bash` lê: o install.sh baixa o latest.json de
# /downloads/, então atualizar o espelho já atualiza o instalador por curl.
definir_versao_site() {
  local nova="$1"
  python3 - "$nova" "$SITE" <<'PY'
import io, re, sys
nova, raiz = sys.argv[1], sys.argv[2]
alvos = [
    (f'{raiz}/assets/js/i18n/home.js', r'(?<![\d.])\d+\.\d+\.\d+(?![\d.])'),
    (f'{raiz}/index.html', r'("softwareVersion": ")[^"]+(")'),
    (f'{raiz}/downloads/index.html', r'(<span data-release-version>)[^<]+(</span>)'),
]
for caminho, padrao in alvos:
    with io.open(caminho, encoding='utf-8') as f: texto = f.read()
    if padrao.startswith('('):
        novo = re.sub(padrao, rf'\g<1>{nova}\g<2>', texto)
    else:
        # home.js: só as duas linhas de download carregam número de versão.
        linhas = texto.split('\n')
        for i, linha in enumerate(linhas):
            if 'download.desktopText' in linha or 'download.phoneText' in linha:
                linhas[i] = re.sub(padrao, nova, linha)
        novo = '\n'.join(linhas)
    if novo != texto:
        with io.open(caminho, 'w', encoding='utf-8') as f: f.write(novo)
        print(f'  versão atualizada em {caminho.split("/")[-1]}')
PY
}

etapa_site() {
  titulo site "site, espelho dos downloads e páginas"
  exigir '[[ -n "$SITE" && -d "$SITE" ]]' "não achei o repositório do site. Aponte CIALAI_SITE_REPO" || return 0
  passo "site em $SITE"
  if [[ "$APLICAR" == 1 && -n "$(git -C "$SITE" status --porcelain)" ]]; then
    erro "a árvore do site precisa estar limpa"
  fi
  faz definir_versao_site "$VERSAO"
  # O espelho baixa os assets da release e reescreve o latest.json para o site.
  faz bash -c "cd '$SITE' && sh scripts/mirror-release.sh '$TAG' --apply"
  if [[ "$APLICAR" == 1 && -n "$(git -C "$SITE" status --porcelain)" ]]; then
    faz git -C "$SITE" add -A
    faz git -C "$SITE" commit -m "site: Cialai $VERSAO"
    faz git -C "$SITE" push
  fi
  faz bash -c "cd '$SITE' && sh scripts/deploy.sh --apply"
  feito "  espelho e site publicados"
}

# ── etapa 7: anúncio ─────────────────────────────────────────────────────────
# O release.yml já anuncia no Discord depois de publicar. Aqui a gente confere
# e só reenvia quando faltou, para não duplicar mensagem no canal.
etapa_anuncio() {
  titulo anuncio "anúncio no Discord"
  if [[ "$APLICAR" != 1 ]]; then
    passo "faria: conferir se o release.yml anunciou e reenviar só se faltou"
    return 0
  fi
  local conclusao
  conclusao="$(gh run list --repo "$REPO" --workflow release.yml --limit 20 \
    --json headBranch,conclusion --jq "[.[] | select(.headBranch==\"$TAG\")] | first | .conclusion" 2>/dev/null || true)"
  if [[ "$conclusao" == "success" ]]; then
    verde "  o release.yml concluiu, o anúncio saiu junto"
    passo "para reenviar à mão: gh workflow run discord-release.yml --repo $REPO -f tag=$TAG"
    return 0
  fi
  aviso "  o release.yml não concluiu com sucesso; conferindo o texto do anúncio"
  node tools/release/discord-notify.mjs "$TAG" --dry-run
  aviso "  envie com: gh workflow run discord-release.yml --repo $REPO -f tag=$TAG"
}

# ── etapa 8: conferir ────────────────────────────────────────────────────────
# A pergunta que importa no fim: quem roda o curl agora recebe a versão nova?
etapa_conferir() {
  titulo conferir "conferir o que o público recebe"
  if [[ "$APLICAR" != 1 ]]; then
    passo "faria: ler https://cialai.com.br/downloads/latest.json e conferir a versão"
    return 0
  fi
  local publicada
  publicada="$(curl -fsS https://cialai.com.br/downloads/latest.json | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))' || true)"
  if [[ "$publicada" == "$VERSAO" ]]; then
    verde "  o espelho serve $VERSAO, então o curl entrega $VERSAO"
  else
    aviso "  o espelho ainda serve '${publicada:-nada}'. O CloudFront pode levar alguns minutos"
  fi
  gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name' | sed 's/^/  asset: /'
}

# ── plano ────────────────────────────────────────────────────────────────────
azul "deploy-full do Cialai $VERSAO, tag $TAG"
if [[ "$APLICAR" != 1 ]]; then
  aviso "modo plano: nada sai para fora. Rode com --aplicar para valer."
fi
printf '\n'

for nome in "${ETAPAS[@]}"; do
  if roda_etapa "$nome"; then "etapa_$nome"; fi
done

printf '\n'
if [[ "$APLICAR" == 1 ]]; then
  verde "deploy-full de $VERSAO concluído"
elif [[ "$IMPEDIMENTOS" -gt 0 ]]; then
  if [[ "$IMPEDIMENTOS" == 1 ]]; then
    aviso "fim do plano com 1 impedimento. Resolva antes de usar --aplicar."
  else
    aviso "fim do plano com $IMPEDIMENTOS impedimentos. Resolva antes de usar --aplicar."
  fi
  exit 1
else
  azul "fim do plano, sem impedimentos. Rode de novo com --aplicar para executar."
fi
