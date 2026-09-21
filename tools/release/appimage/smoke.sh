#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Smoke do AppImage num Linux real: abre o app sob Xvfb e confere que a interface do WebKit sobe.
#
# Cenários, sempre com o diretório de trabalho fora de $APPDIR/usr:
#   appimage   o AppImage aberto de uma pasta temporária, montado por FUSE quando o sistema permite
#   extraido   a árvore de --appimage-extract aberta pelo AppRun a partir de /
#
# Falha quando um ELF do bundle tem biblioteca não resolvida sem LD_LIBRARY_PATH, quando os auxiliares do
# WebKit resolvem a libwebkit2gtk fora do bundle, quando o app sai antes do prazo, quando o WebKitWebProcess
# ou o WebKitNetworkProcess do bundle não estão vivos no fim, quando o processo principal herdou variáveis
# que o AppRun não pode exportar, quando nenhuma janela Cialai aparece, quando nenhum cialai-tunnel com
# executável dentro do APPDIR nasceu, quando tunnel/tunnel.log não foi criado no HOME isolado e quando o log
# mostra aborto, símbolo indefinido, módulo que não carrega ou coredump.
#
# Uso: tools/release/appimage/smoke.sh <AppImage> [segundos] [pasta de logs]
# Precisa de xvfb-run, xauth, xwininfo, pgrep e ldd; tira captura da tela quando o import do ImageMagick existe.
set -euo pipefail

appimage="$(readlink -f "${1:?informe o AppImage}")"
seconds="${2:-20}"
logs="${3:-${RUNNER_TEMP:-/tmp}/appimage-smoke}"
mkdir -p "$logs"
logs="$(readlink -f "$logs")"
work="$(mktemp -d)"
failures=0
groups=()

fail() {
  echo "FAIL: $*"
  failures=$((failures + 1))
}

cleanup() {
  for group in "${groups[@]}"; do kill -KILL -- "-$group" 2>/dev/null || true; done
  rm -rf "$work" 2>/dev/null || true
}
trap cleanup EXIT

for tool in xvfb-run xauth xwininfo pgrep ldd; do
  command -v "$tool" >/dev/null || { echo "FAIL: $tool ausente"; exit 1; }
done
chmod +x "$appimage"

is_elf() {
  [ "$(head -c 4 "$1" | od -An -c | tr -d ' \n')" = '177ELF' ]
}

coredumps() {
  { coredumpctl list --no-legend --no-pager 2>/dev/null || true; ls /var/crash 2>/dev/null || true; } | wc -l
}

# Sem LD_LIBRARY_PATH, cada ELF precisa achar as bibliotecas pelo RUNPATH ou no sistema.
check_libraries() {
  local root="$1" checked=0 file out missing
  while IFS= read -r -d '' file; do
    is_elf "$file" || continue
    out="$(env -u LD_LIBRARY_PATH ldd "$file" 2>&1 || true)"
    case "$out" in *'not a dynamic executable'*|*'statically linked'*) continue ;; esac
    checked=$((checked + 1))
    missing="$(grep 'not found' <<<"$out" | tr -s ' \t' ' ' | paste -sd ';' || true)"
    [ -z "$missing" ] || fail "${file#"$root"/}: $missing"
  done < <(find "$root/usr" -type f -print0)
  echo "ldd conferiu $checked ELFs em ${root}"
  for helper in WebKitWebProcess WebKitNetworkProcess; do
    local resolved
    resolved="$(env -u LD_LIBRARY_PATH ldd "$root/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/$helper" 2>&1 \
      | awk '$1 == "libwebkit2gtk-4.1.so.0" { print $3 }')"
    case "$resolved" in
      "$root"/*) echo "$helper resolve a libwebkit2gtk do bundle" ;;
      *) fail "$helper resolve libwebkit2gtk-4.1.so.0 fora do bundle: ${resolved:-não encontrada}" ;;
    esac
  done
}

environ_of() {
  tr '\0' '\n' <"/proc/$1/environ" 2>/dev/null || true
}

# Primeiro processo vivo cujo executável fica dentro de $2 e cuja linha de comando contém $1.
bundle_process() {
  local pattern="$1" root="$2" pid exe
  for pid in $(pgrep -f "$pattern" || true); do
    exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
    case "$exe" in "$root"/*) echo "$pid"; return 0 ;; esac
  done
  return 1
}

launch() {
  local name="$1" dir="$2"
  shift 2
  local log="$logs/$name.log" home="$work/home-$name"
  mkdir -p "$home"
  echo "== $name: $* a partir de $dir"
  (
    cd "$dir"
    # Um desktop sem as variáveis que o AppRun antigo exportava; HOME novo e sem XDG para o app abrir do zero.
    exec setsid env -u LD_LIBRARY_PATH -u PYTHONHOME -u PYTHONPATH -u PERLLIB -u QT_PLUGIN_PATH \
      -u GIO_MODULE_DIR -u GIO_EXTRA_MODULES -u GTK_PATH -u APPDIR -u OWD \
      -u XDG_DATA_HOME -u XDG_CONFIG_HOME -u XDG_CACHE_HOME HOME="$home" \
      xvfb-run -a -s '-screen 0 1280x800x24 -nolisten tcp' "$@"
  ) >"$log" 2>&1 &
  local group=$!
  groups+=("$group")
  local started=$SECONDS
  while (( SECONDS - started < seconds )) && kill -0 "$group" 2>/dev/null; do sleep 1; done

  if ! kill -0 "$group" 2>/dev/null; then
    local status=0
    wait "$group" || status=$?
    fail "$name: o app saiu depois de $((SECONDS - started)) s com status $status"
  else
    local main appdir display xauthority
    main="$(pgrep -x cialai-desktop | head -n 1 || true)"
    appdir=""
    [ -n "$main" ] && appdir="$(environ_of "$main" | sed -n 's/^APPDIR=//p')"
    if [ -z "$main" ]; then
      fail "$name: nenhum processo cialai-desktop vivo depois de $seconds s"
    elif [ -z "$appdir" ]; then
      # O pgrep achou e a leitura de /proc não: o app saiu entre uma coisa e
      # outra. Dizer "não encontrado" aqui manda a investigação para o lado
      # errado, que foi o que aconteceu na 0.2.7.
      fail "$name: cialai-desktop $main saiu durante a verificação; últimas linhas do log:"$'\n'"$(tail -n 5 "$log")"
    else
      appdir="$(readlink -f "$appdir")"
      echo "$name: cialai-desktop $main com APPDIR=$appdir"
      local variable
      for variable in LD_LIBRARY_PATH PYTHONHOME PYTHONPATH PERLLIB QT_PLUGIN_PATH; do
        if environ_of "$main" | grep -q "^$variable="; then fail "$name: o app herdou $variable"; fi
      done
      if environ_of "$main" | grep '^PATH=' | grep -qF "$appdir"; then fail "$name: o PATH do app aponta para o bundle"; fi
      local helper pid
      for helper in WebKitWebProcess WebKitNetworkProcess; do
        if pid="$(bundle_process "webkit2gtk-4.1/$helper" "$appdir")"; then
          if grep -qF "$appdir/usr/lib/libwebkit2gtk-4.1.so.0" "/proc/$pid/maps" 2>/dev/null; then
            echo "$name: $helper vivo, pid $pid, $(readlink "/proc/$pid/exe")"
          else
            fail "$name: $helper $pid não carregou a libwebkit2gtk do bundle"
          fi
        else
          fail "$name: $helper do bundle não está vivo depois de $seconds s"
        fi
      done
      # O sidecar do túnel nasce ao abrir e precisa vir da própria imagem, ao lado do executável real, e não da
      # pasta do arquivo .AppImage. O núcleo grava tunnel.log no diretório de estado do HOME isolado assim que sobe.
      if pid="$(bundle_process cialai-tunnel "$appdir")"; then
        echo "$name: cialai-tunnel vivo, pid $pid, $(readlink "/proc/$pid/exe")"
      else
        fail "$name: nenhum cialai-tunnel com executável dentro de $appdir depois de $seconds s"
      fi
      local tunnel_log="$home/.local/share/br.com.ordinum.cialai/tunnel/tunnel.log"
      if [ -f "$tunnel_log" ]; then
        echo "$name: $tunnel_log criado com $(wc -l <"$tunnel_log") linhas"
        cp "$tunnel_log" "$logs/$name-tunnel.log" 2>/dev/null || true
      else
        fail "$name: $tunnel_log não foi criado no HOME isolado"
      fi
      display="$(environ_of "$main" | sed -n 's/^DISPLAY=//p')"
      xauthority="$(environ_of "$main" | sed -n 's/^XAUTHORITY=//p')"
      if DISPLAY="$display" XAUTHORITY="$xauthority" xwininfo -root -tree 2>/dev/null | grep -q '"Cialai"'; then
        echo "$name: janela Cialai no display $display"
      else
        fail "$name: nenhuma janela Cialai no display $display"
      fi
      if command -v import >/dev/null; then
        DISPLAY="$display" XAUTHORITY="$xauthority" import -window root "$logs/$name.png" 2>/dev/null || true
      fi
    fi
    kill -TERM -- "-$group" 2>/dev/null || true
    sleep 2
    kill -KILL -- "-$group" 2>/dev/null || true
    wait "$group" 2>/dev/null || true
  fi

  # O app cria o sidecar com process_group(0), então o cialai-tunnel fica num
  # grupo próprio e o kill acima não o alcança. Sobrevivendo, ele continua com
  # a UDP 4740 e as portas do Tor, e a execução seguinte não sobe. Encerrar
  # aqui é o que torna as duas execuções independentes de verdade.
  pkill -x cialai-tunnel 2>/dev/null || true
  sleep 1
  pkill -KILL -x cialai-tunnel 2>/dev/null || true

  local problems
  problems="$(grep -En 'Aborting|undefined symbol|symbol lookup error|error while loading shared libraries|Failed to load module: |Unable to spawn a new child process|core dumped|EGL_BAD_' "$log" || true)"
  [ -z "$problems" ] || fail "$name: o log mostra falha:"$'\n'"$problems"
}

before="$(coredumps)"

mkdir -p "$work/outside" "$work/extract"
mode=()
if [ "${SMOKE_APPIMAGE_MODE:-auto}" = extract ] || [ ! -c /dev/fuse ] \
  || ! { command -v fusermount3 || command -v fusermount; } >/dev/null; then
  mode=(--appimage-extract-and-run)
fi
echo "AppImage ${mode[*]:-montado por FUSE}"
launch appimage "$work/outside" "$appimage" "${mode[@]}"

(cd "$work/extract" && env -u LD_LIBRARY_PATH "$appimage" --appimage-extract >/dev/null)
check_libraries "$work/extract/squashfs-root"
launch extraido / "$work/extract/squashfs-root/AppRun"

after="$(coredumps)"
[ "$after" = "$before" ] || fail "coredumps novos durante o smoke: $before antes, $after depois"

for log in "$logs"/*.log; do
  echo "::group::$(basename "$log")"
  cat "$log"
  echo "::endgroup::"
done
if (( failures )); then
  echo "FAIL AppImage smoke: $failures problemas em $(uname -n)"
  exit 1
fi
echo "PASS AppImage smoke: interface, processos do WebKit e cialai-tunnel da imagem vivos por $seconds s nos dois cenários, com tunnel.log no HOME isolado"
