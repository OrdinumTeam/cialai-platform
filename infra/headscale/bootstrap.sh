#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Renders the Cialai Headscale configuration, starts the service and waits for
# the Let's Encrypt certificate. It never creates or prints API keys itself.
set -euo pipefail

readonly TEMPLATE="config/config.yaml.template"
readonly TARGET="config/config.yaml"
readonly WAIT_SECONDS=300

usage() {
  cat <<'EOF'
Uso: ./bootstrap.sh [--domain hs.exemplo.com] [--ipv4 203.0.113.10] [--no-start] [--force]

  --domain    Nome público do Headscale, com registro A apontando para este servidor
  --ipv4      IPv4 público usado pelo relé DERP embutido
  --no-start  Só gera config/config.yaml
  --force     Substitui um config/config.yaml existente
EOF
}

fail() {
  printf 'Erro: %s\n' "$1" >&2
  exit 1
}

valid_domain() {
  [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] && [ "${#1}" -le 253 ]
}

valid_ipv4() {
  local IFS=.
  local -a octets
  [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  read -r -a octets <<<"$1"
  for octet in "${octets[@]}"; do
    [ "$((10#$octet))" -le 255 ] || return 1
  done
}

cd "$(dirname "$0")"

domain=""
ipv4=""
start=1
force=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain) domain="${2:-}"; shift 2 ;;
    --ipv4) ipv4="${2:-}"; shift 2 ;;
    --no-start) start=0; shift ;;
    --force) force=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

[ -n "$domain" ] || read -r -p "Domínio público do Headscale: " domain
[ -n "$ipv4" ] || read -r -p "IPv4 público deste servidor: " ipv4
domain="$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]')"

valid_domain "$domain" || fail "domínio inválido: $domain"
valid_ipv4 "$ipv4" || fail "IPv4 inválido: $ipv4"
case "$domain" in
  cialai.internal | *.cialai.internal) fail "o domínio não pode ficar dentro de cialai.internal, usado pelo MagicDNS" ;;
esac
[ -f "$TEMPLATE" ] || fail "modelo ausente: $TEMPLATE"
if [ -e "$TARGET" ] && [ "$force" -ne 1 ]; then
  fail "$TARGET já existe; use --force para substituir"
fi

temporary="$(mktemp "config/.config.yaml.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
sed -e "s/__HEADSCALE_DOMAIN__/$domain/g" -e "s/__PUBLIC_IPV4__/$ipv4/g" "$TEMPLATE" >"$temporary"
if grep -q '__[A-Z0-9_]*__' "$temporary"; then
  fail "o modelo ainda tem marcadores sem valor"
fi
chmod 0644 "$temporary"
mv "$temporary" "$TARGET"
trap - EXIT
printf 'Configuração gerada em %s para %s.\n' "$TARGET" "$domain"

if [ "$start" -ne 1 ]; then
  exit 0
fi

command -v docker >/dev/null || fail "Docker não encontrado"
docker compose version >/dev/null || fail "Docker Compose v2 não encontrado"
docker compose run --rm --no-deps headscale configtest >/dev/null || fail "o Headscale recusou a configuração gerada"
docker compose up --detach

printf 'Aguardando o certificado e a saúde em https://%s/health' "$domain"
deadline=$((SECONDS + WAIT_SECONDS))
until curl --fail --silent --show-error --max-time 5 "https://$domain/health" >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    printf '\n'
    fail "o servidor não respondeu em ${WAIT_SECONDS}s; veja docker compose logs headscale e o diagnóstico do README"
  fi
  printf '.'
  sleep 5
done
printf '\nHeadscale pronto em https://%s\n\n' "$domain"
cat <<EOF
Próximo passo: crie a chave da API e cole no assistente de rede do Cialai.

  docker compose exec headscale headscale apikeys create --expiration 365d

A chave controla o servidor inteiro. Guarde somente no computador que vai usar o Cialai.
EOF
