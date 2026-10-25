# SPDX-License-Identifier: Apache-2.0
# Cialai: menu de contas ao digitar codex ou claude nas sessoes do Cialai.
# O app grava este arquivo em ~/.cialai/shell e o reescreve quando muda.
# Mesmo contrato de agents.zsh, escrito para o bash 3.2 do macOS: sem
# arrays associativos, sem mapfile e sem expansoes de caixa.

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
      enter) text='Enter: {name}' ;;
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

  local esc=$'\e' width=0 mark tone
  for label in "${labels[@]}"; do [ "${#label}" -gt "$width" ] && width=${#label}; done
  {
    printf '%s\n' "${esc}[1m$(_cialai_agents_text question)${esc}[0m"
    for (( index = 0; index < count; index++ )); do
      mark=' '; [ "$index" -eq "$choice" ] && mark="${esc}[38;5;211m›${esc}[0m"
      case ${states[index]} in
        out) tone="${esc}[31m" ;;
        free) tone="${esc}[32m" ;;
        *) tone="${esc}[2m" ;;
      esac
      printf '%s %d  %s  %s  %s\n' "$mark" $(( index + 1 )) "$(_cialai_agents_pad "${labels[index]}" "$width")" "$tone${values[index]}${esc}[0m" "${esc}[2m${details[index]}${esc}[0m"
    done
    printf '%s\n' "${esc}[2m$(_cialai_agents_text enter "${labels[choice]}")${esc}[0m"
  } >&2

  local answer=""
  if [ "$count" -gt 9 ]; then
    IFS= read -r answer < /dev/tty || return 130
  else
    IFS= read -r -s -n 1 answer < /dev/tty || return 130
  fi
  case $answer in
    '') ;;
    *[!0-9]*) return 130 ;;
    *)
      [ "$answer" -ge 1 ] && [ "$answer" -le "$count" ] || return 130
      choice=$(( answer - 1 )) ;;
  esac
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
    *) printf '\n' >&2; return "$result" ;;
  esac
  _cialai_agents_remember "$agent" "$_cialai_agents_name"
  if [ "$_cialai_agents_folder" = - ]; then
    ( unset "$dir_key" "$name_key"; _cialai_agents_call "$agent" "$@" )
  else
    ( export "$dir_key=$_cialai_agents_folder" "$name_key=$_cialai_agents_name"; _cialai_agents_call "$agent" "$@" )
  fi
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
