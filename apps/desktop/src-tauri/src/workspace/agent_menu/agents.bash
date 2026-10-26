# SPDX-License-Identifier: Apache-2.0
# Cialai: menu de contas ao digitar codex ou claude nas sessoes do Cialai.
# O app grava este arquivo em ~/.cialai/shell e o reescreve quando muda.
# Mesmo contrato de agents.zsh, escrito para o bash 3.2 do macOS: sem
# arrays associativos, sem mapfile e sem expansoes de caixa.
#
# A conta se escolhe com as setas, ou com j e k, e Enter abre. Um numero de
# 1 a 9 abre a conta dele direto, e Esc, q ou Ctrl+C desistem.

_cialai_agents_dir="${CIALAI_AGENTS_DIR:-$HOME/.cialai/agents}"

_cialai_agents_text() {
  local key value text=""
  if [ -r "$_cialai_agents_dir/menu.tsv" ]; then
    while IFS=$'\t' read -r key value; do
      if [ "$key" = "$1" ]; then text=$value; break; fi
    done < "$_cialai_agents_dir/menu.tsv"
  fi
  if [ -z "$text" ]; then
    case $1 in
      question) text='?' ;;
      enter) text='↑ ↓, Enter: {name}' ;;
      *) text='{name}?' ;;
    esac
  fi
  printf '%s\n' "${text//\{name\}/$2}"
}

_cialai_agents_pad() {
  local text=$1 pad=$(( $2 - ${#1} ))
  printf '%s' "$text"
  while [ "$pad" -gt 0 ]; do printf ' '; pad=$(( pad - 1 )); done
}

# Desenha as contas e a dica, com a escolhida em destaque. Le os vetores e a
# escolha de _cialai_agents_pick, que o bash deixa ver por escopo dinamico.
# Termina sem quebra de linha, na linha da dica, para o redesenho subir
# exatamente o numero de contas.
_cialai_agents_draw() {
  local esc=$'\e' index mark tone label
  for (( index = 0; index < count; index++ )); do
    label=$(_cialai_agents_pad "${labels[index]}" "$width")
    if [ "$index" -eq "$choice" ]; then
      mark="${esc}[38;5;205m›${esc}[0m"
      label="${esc}[1;38;5;205m${label}${esc}[0m"
    else
      mark=' '
    fi
    case ${states[index]} in
      out) tone="${esc}[31m" ;;
      free) tone="${esc}[32m" ;;
      *) tone="${esc}[2m" ;;
    esac
    printf '%s\n' "${esc}[2K${mark} ${esc}[2m$(( index + 1 ))${esc}[0m  ${label}  ${tone}${values[index]}${esc}[0m  ${esc}[2m${details[index]}${esc}[0m"
  done
  printf '%s' "${esc}[2K${esc}[2m$(_cialai_agents_text enter "${labels[choice]}")${esc}[0m"
}

# Le uma tecla do terminal e devolve em _cialai_agents_key_read: up, down,
# enter, cancel, um numero ou vazio para o que nao interessa. As setas chegam
# como ESC [ A ou, no modo de aplicacao do cursor, ESC O A; o resto da
# sequencia e consumido para um Ctrl+seta nao virar numero. O bash 3.2 so
# aceita espera inteira no read.
_cialai_agents_key() {
  local key="" rest="" seq="" wait=1
  [ "${BASH_VERSINFO[0]:-3}" -ge 4 ] && wait=0.1
  _cialai_agents_key_read=''
  IFS= read -r -s -n 1 key < /dev/tty || { _cialai_agents_key_read=cancel; return 0; }
  case $key in
    '') _cialai_agents_key_read=enter ;;
    $'\e')
      IFS= read -r -s -n 1 -t "$wait" rest < /dev/tty
      case $rest in
        '['|O)
          while IFS= read -r -s -n 1 -t "$wait" key < /dev/tty; do
            seq=$seq$key
            case $key in [A-Za-z~]) break ;; esac
            [ "${#seq}" -ge 8 ] && break
          done
          case $seq in
            *A) _cialai_agents_key_read=up ;;
            *B) _cialai_agents_key_read=down ;;
          esac ;;
        *) _cialai_agents_key_read=cancel ;;
      esac ;;
    k) _cialai_agents_key_read=up ;;
    j) _cialai_agents_key_read=down ;;
    [1-9]) _cialai_agents_key_read=$key ;;
    q|$'\x03'|$'\x04') _cialai_agents_key_read=cancel ;;
  esac
  return 0
}

# Devolve 0 com _cialai_agents_name e _cialai_agents_folder, 1 para seguir
# sem menu, 2 quando a conta pedida nao existe e 130 quando a pessoa desiste.
_cialai_agents_pick() {
  local agent=$1 wanted=$2 file="$_cialai_agents_dir/$1.tsv"
  if [ ! -r "$file" ]; then
    [ -n "$wanted" ] && return 2
    return 1
  fi
  local names=() labels=() dirs=() states=() values=() details=()
  local name label dir state value detail
  while IFS=$'\t' read -r name label dir state value detail; do
    case $name in ''|'#'*) continue ;; esac
    [ "$value" = - ] && value=''
    [ "$detail" = - ] && detail=''
    names+=("$name"); labels+=("$label"); dirs+=("$dir"); states+=("$state")
    values+=("$value"); details+=("$detail")
  done < "$file"
  local count=${#names[@]} index
  if [ -n "$wanted" ]; then
    for (( index = 0; index < count; index++ )); do
      if [ "${names[index]}" = "$wanted" ] || [ "${labels[index]}" = "$wanted" ]; then
        _cialai_agents_name=${names[index]}
        _cialai_agents_folder=${dirs[index]}
        return 0
      fi
    done
    return 2
  fi
  [ "$count" -ge 2 ] || return 1

  # Comeca na ultima conta usada nesta pasta, ou na seguinte com cota.
  local last="" key start=0 choice=0 step
  if [ -r "$_cialai_agents_dir/$agent.last" ]; then
    while IFS=$'\t' read -r key name; do
      [ "$key" = "$PWD" ] && last=$name
    done < "$_cialai_agents_dir/$agent.last"
  fi
  for (( index = 0; index < count; index++ )); do
    [ "${names[index]}" = "$last" ] && start=$index
  done
  choice=$start
  for (( step = 0; step < count; step++ )); do
    index=$(( (start + step) % count ))
    case ${states[index]} in out|none) ;; *) choice=$index; break ;; esac
  done

  local width=0
  for label in "${labels[@]}"; do [ "${#label}" -gt "$width" ] && width=${#label}; done
  printf '%s\n' $'\e[1m'"$(_cialai_agents_text question)"$'\e[0m' >&2
  _cialai_agents_draw >&2
  local _cialai_agents_key_read=''
  while :; do
    _cialai_agents_key
    case $_cialai_agents_key_read in
      enter) break ;;
      cancel) printf '\n' >&2; return 130 ;;
      up) choice=$(( choice > 0 ? choice - 1 : count - 1 )) ;;
      down) choice=$(( choice < count - 1 ? choice + 1 : 0 )) ;;
      [1-9])
        [ "$_cialai_agents_key_read" -le "$count" ] || continue
        choice=$(( _cialai_agents_key_read - 1 )) ;;
      *) continue ;;
    esac
    printf '\r\033[%dA' "$count" >&2
    _cialai_agents_draw >&2
    case $_cialai_agents_key_read in [1-9]) break ;; esac
  done
  printf '\n' >&2
  _cialai_agents_name=${names[choice]}
  _cialai_agents_folder=${dirs[choice]}
  return 0
}

_cialai_agents_remember() {
  local file="$_cialai_agents_dir/$1.last"
  [ -d "$_cialai_agents_dir" ] || return 0
  printf '%s\t%s\n' "$PWD" "$2" >> "$file" 2>/dev/null || return 0
  if [ "$(wc -l < "$file")" -gt 400 ]; then
    tail -n 200 "$file" > "$file.tmp" 2>/dev/null && mv -f "$file.tmp" "$file" 2>/dev/null
  fi
  return 0
}

_cialai_agents_call() {
  local agent=$1; shift
  if declare -F "_cialai_user_$agent" > /dev/null; then
    "_cialai_user_$agent" "$@"
  else
    command "$agent" "$@"
  fi
}

# Tira uma variavel do ambiente e grava em _cialai_agents_saved como volta-la:
# vazio quando ela nao existia, x e o valor quando era exportada, - e o valor
# quando era so do shell. No bash, local seguido de unset ainda deixa o valor
# de fora no ambiente do filho.
_cialai_agents_unset() {
  _cialai_agents_saved=''
  if [ -n "${!1+set}" ]; then
    case $(declare -p "$1" 2>/dev/null) in
      "declare -"*x*" $1="*|"declare -"*x*" $1") _cialai_agents_saved="x${!1}" ;;
      *) _cialai_agents_saved="-${!1}" ;;
    esac
  fi
  unset "$1"
}

_cialai_agents_restore() {
  case $2 in
    '') ;;
    x*) export "$1=${2#x}" ;;
    *) eval "$1=\${2#-}" ;;
  esac
}

# Roda o agente no proprio shell, nunca num subshell: um `( ... )` vira o
# grupo em primeiro plano do terminal, e o card do Cialai passa a ler o shell
# no lugar do agente e perde o perfil. A pasta da conta vai numa variavel
# local exportada, que vale ate o agente sair.
_cialai_agents_launch() {
  local agent=$1 dir_key=$2 name_key=$3 folder=$4 name=$5 status
  shift 5
  if [ "$folder" != - ]; then
    local -x "$dir_key=$folder" "$name_key=$name"
    _cialai_agents_call "$agent" "$@"
    return
  fi
  local _cialai_agents_saved saved_dir saved_name
  _cialai_agents_unset "$dir_key"; saved_dir=$_cialai_agents_saved
  _cialai_agents_unset "$name_key"; saved_name=$_cialai_agents_saved
  _cialai_agents_call "$agent" "$@"
  status=$?
  _cialai_agents_restore "$dir_key" "$saved_dir"
  _cialai_agents_restore "$name_key" "$saved_name"
  return "$status"
}

_cialai_agents_skip() {
  local agent=$1; shift
  case $1 in --version|-v|-V|--help|-h) return 0 ;; esac
  if [ "$agent" = codex ]; then
    case $1 in login|logout) return 0 ;; esac
    if [ "$1" = resume ] && [ -n "$2" ]; then
      case $2 in -*) ;; *) return 0 ;; esac
    fi
  else
    case $1 in auth|setup-token) return 0 ;; esac
    local previous="" value
    for value in "$@"; do
      case $previous in --resume|-r) case $value in -*) ;; *) return 0 ;; esac ;; esac
      case $value in --resume=?*) return 0 ;; esac
      previous=$value
    done
  fi
  return 1
}

_cialai_agents_run() {
  local agent=$1 dir_key=$2 name_key=$3 wanted="" result
  shift 3
  case $1 in
    +?*) wanted=${1#+}; shift ;;
    *)
      if [ -n "${!dir_key}" ] || [ "${CIALAI_AGENT_MENU-}" = 0 ] || ! [ -t 0 ] || ! [ -t 2 ] || _cialai_agents_skip "$agent" "$@"; then
        _cialai_agents_call "$agent" "$@"
        return
      fi ;;
  esac
  local _cialai_agents_name="" _cialai_agents_folder=""
  _cialai_agents_pick "$agent" "$wanted"
  result=$?
  case $result in
    0) ;;
    1) _cialai_agents_call "$agent" "$@"; return ;;
    2) _cialai_agents_text missing "$wanted" >&2; return 2 ;;
    *) return "$result" ;;
  esac
  _cialai_agents_remember "$agent" "$_cialai_agents_name"
  _cialai_agents_launch "$agent" "$dir_key" "$name_key" "$_cialai_agents_folder" "$_cialai_agents_name" "$@"
}

# Uma funcao do usuario com o mesmo nome continua valendo: ela passa a
# rodar depois do menu.
for _cialai_agent in codex claude; do
  if declare -F "$_cialai_agent" > /dev/null && ! declare -f "$_cialai_agent" | grep -q _cialai_agents_run; then
    eval "$(declare -f "$_cialai_agent" | sed "1s/^$_cialai_agent /_cialai_user_$_cialai_agent /")"
  fi
done
unset _cialai_agent
function codex {
  _cialai_agents_run codex CODEX_HOME CODEX_PROFILE "$@"
}
function claude {
  _cialai_agents_run claude CLAUDE_CONFIG_DIR CLAUDE_PROFILE "$@"
}
