# SPDX-License-Identifier: Apache-2.0
# Cialai: menu de contas ao digitar codex ou claude nas sessoes do Cialai.
# O app grava este arquivo em ~/.cialai/shell e o reescreve quando muda.
#
# As contas vem de ~/.cialai/agents/<agente>.tsv, publicado pelo app com a
# cota de cada uma: uma linha por conta, campos separados por tab e "-" no
# lugar do vazio, na ordem nome, rotulo, pasta, estado, valor e detalhe. A
# pasta "-" e o perfil padrao, que roda sem a variavel. Sem o arquivo ou com
# uma conta so, o comando roda como sempre.
#
# O menu fica de fora quando a pasta ja vem no ambiente, quando a entrada ou
# a saida de erro nao e um terminal, com CIALAI_AGENT_MENU=0, em --version e
# --help, no login e na retomada com id, que o app digita ao reabrir uma
# conversa. O login de uma conta ja vem com a pasta escolhida pelo app.
# `codex +nome` escolhe direto, mesmo com a pasta no ambiente.

typeset -g _cialai_agents_dir="${CIALAI_AGENTS_DIR:-$HOME/.cialai/agents}"

_cialai_agents_text() {
  emulate -L zsh
  local key value text=""
  if [[ -r $_cialai_agents_dir/menu.tsv ]]; then
    while IFS=$'\t' read -r key value; do
      if [[ $key == $1 ]]; then text=$value; break; fi
    done < $_cialai_agents_dir/menu.tsv
  fi
  if [[ -z $text ]]; then
    case $1 in
      question) text='?' ;;
      enter) text='Enter: {name}' ;;
      *) text='{name}?' ;;
    esac
  fi
  print -r -- "${text//\{name\}/$2}"
}

_cialai_agents_pad() {
  emulate -L zsh
  local text=$1 pad=$(( $2 - ${#1} ))
  (( pad > 0 )) || pad=0
  print -rn -- "$text${(l:pad:)}"
}

# Devolve 0 com reply=(nome pasta), 1 para seguir sem menu, 2 quando a conta
# pedida nao existe e 130 quando a pessoa desiste.
_cialai_agents_pick() {
  emulate -L zsh
  local agent=$1 wanted=$2 file="$_cialai_agents_dir/$1.tsv"
  [[ -r $file ]] || { [[ -n $wanted ]] && return 2; return 1 }
  local -a names labels dirs states values details
  local name label dir state value detail
  while IFS=$'\t' read -r name label dir state value detail; do
    [[ -z $name || $name == '#'* ]] && continue
    names+=("$name"); labels+=("$label"); dirs+=("$dir"); states+=("$state")
    values+=("${value:#-}"); details+=("${detail:#-}")
  done < $file
  local count=${#names} index
  if [[ -n $wanted ]]; then
    for index in {1..$count}; do
      if [[ ${names[index]} == $wanted || ${labels[index]} == $wanted ]]; then
        reply=("${names[index]}" "${dirs[index]}")
        return 0
      fi
    done
    return 2
  fi
  (( count >= 2 )) || return 1

  local last="" key start=1 choice=1 step
  if [[ -r $_cialai_agents_dir/$agent.last ]]; then
    while IFS=$'\t' read -r key name; do
      [[ $key == $PWD ]] && last=$name
    done < $_cialai_agents_dir/$agent.last
  fi
  for index in {1..$count}; do
    [[ ${names[index]} == $last ]] && start=$index
  done
  choice=$start
  for step in {0..$(( count - 1 ))}; do
    index=$(( (start - 1 + step) % count + 1 ))
    if [[ ${states[index]} != (out|none) ]]; then choice=$index; break; fi
  done

  local esc=$'\e' width=0 mark tone
  for label in $labels; do (( ${#label} > width )) && width=${#label}; done
  {
    print -r -- "${esc}[1m$(_cialai_agents_text question)${esc}[0m"
    for index in {1..$count}; do
      mark=' '; (( index == choice )) && mark="${esc}[38;5;211m›${esc}[0m"
      case ${states[index]} in
        out) tone="${esc}[31m" ;;
        free) tone="${esc}[32m" ;;
        *) tone="${esc}[2m" ;;
      esac
      print -r -- "$mark $index  $(_cialai_agents_pad "${labels[index]}" $width)  $tone${values[index]}${esc}[0m  ${esc}[2m${details[index]}${esc}[0m"
    done
    print -r -- "${esc}[2m$(_cialai_agents_text enter "${labels[choice]}")${esc}[0m"
  } >&2

  local answer=""
  if (( count > 9 )); then
    read -r answer < /dev/tty || return 130
  else
    read -s -k 1 answer < /dev/tty || return 130
  fi
  case $answer in
    ($'\n'|$'\r'|'') ;;
    (<1-99>)
      (( answer <= count )) || return 130
      choice=$answer ;;
    (*) return 130 ;;
  esac
  reply=("${names[choice]}" "${dirs[choice]}")
  return 0
}

_cialai_agents_remember() {
  emulate -L zsh
  local file="$_cialai_agents_dir/$1.last"
  [[ -d $_cialai_agents_dir ]] || return 0
  print -r -- "$PWD"$'\t'"$2" >> $file 2>/dev/null || return 0
  if (( $(wc -l < $file) > 400 )); then
    tail -n 200 $file > $file.tmp 2>/dev/null && mv -f $file.tmp $file 2>/dev/null
  fi
  return 0
}

_cialai_agents_call() {
  local agent=$1; shift
  if (( $+functions[_cialai_user_$agent] )); then
    _cialai_user_$agent "$@"
  else
    command $agent "$@"
  fi
}

_cialai_agents_skip() {
  emulate -L zsh
  local agent=$1; shift
  [[ $1 == (--version|-v|-V|--help|-h) ]] && return 0
  if [[ $agent == codex ]]; then
    [[ $1 == (login|logout) ]] && return 0
    [[ $1 == resume && -n $2 && $2 != -* ]] && return 0
  else
    [[ $1 == (auth|setup-token) ]] && return 0
    local previous="" value
    for value in "$@"; do
      [[ $previous == (--resume|-r) && $value != -* ]] && return 0
      [[ $value == --resume=?* ]] && return 0
      previous=$value
    done
  fi
  return 1
}

_cialai_agents_run() {
  local agent=$1 dir_key=$2 name_key=$3 wanted="" result
  shift 3
  if [[ $1 == +?* ]]; then
    wanted=${1#+}
    shift
  elif [[ -n ${(P)dir_key} || $CIALAI_AGENT_MENU == 0 ]] || ! [[ -t 0 && -t 2 ]] || _cialai_agents_skip $agent "$@"; then
    _cialai_agents_call $agent "$@"
    return
  fi
  local -a reply
  _cialai_agents_pick $agent "$wanted"
  result=$?
  case $result in
    0) ;;
    1) _cialai_agents_call $agent "$@"; return ;;
    2) print -u2 -r -- "$(_cialai_agents_text missing "$wanted")"; return 2 ;;
    *) print -u2; return $result ;;
  esac
  _cialai_agents_remember $agent "${reply[1]}"
  if [[ ${reply[2]} == - ]]; then
    ( unset $dir_key $name_key; _cialai_agents_call $agent "$@" )
  else
    ( export "$dir_key=${reply[2]}" "$name_key=${reply[1]}"; _cialai_agents_call $agent "$@" )
  fi
}

# Uma funcao do usuario com o mesmo nome, como um claude() do .zshrc que
# acrescenta opcoes, continua valendo: ela passa a rodar depois do menu.
() {
  local agent
  for agent in codex claude; do
    if (( $+functions[$agent] )) && [[ ${functions[$agent]} != *_cialai_agents_run* ]]; then
      functions[_cialai_user_$agent]=${functions[$agent]}
    fi
  done
}
function codex {
  _cialai_agents_run codex CODEX_HOME CODEX_PROFILE "$@"
}
function claude {
  _cialai_agents_run claude CLAUDE_CONFIG_DIR CLAUDE_PROFILE "$@"
}
