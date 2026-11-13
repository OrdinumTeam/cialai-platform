# SPDX-License-Identifier: Apache-2.0
# Cialai: o zsh das sessoes nasce com ZDOTDIR nesta pasta. Cada arquivo daqui
# devolve o ZDOTDIR do usuario, carrega o arquivo dele com o mesmo nome e
# aponta o ZDOTDIR de novo para esta pasta, para o zsh ler o proximo. Depois
# do .zshrc entra o menu de contas e o ZDOTDIR volta a ser o do usuario.

_cialai_zsh_dir=$ZDOTDIR

_cialai_zdotdir_user() {
  if [[ -n ${CIALAI_USER_ZDOTDIR-} ]]; then
    ZDOTDIR=$CIALAI_USER_ZDOTDIR
  else
    unset ZDOTDIR
  fi
}

# O arquivo do usuario pode trocar o ZDOTDIR, e a troca vale para os proximos.
_cialai_zdotdir_keep() {
  if [[ -n ${ZDOTDIR-} ]]; then
    export CIALAI_USER_ZDOTDIR=$ZDOTDIR
  else
    unset CIALAI_USER_ZDOTDIR
  fi
  ZDOTDIR=$_cialai_zsh_dir
}

_cialai_zdotdir_done() {
  _cialai_zdotdir_user
  unset CIALAI_USER_ZDOTDIR _cialai_zsh_dir
  unfunction _cialai_zdotdir_user _cialai_zdotdir_keep _cialai_zdotdir_done
}

_cialai_zdotdir_user
[[ -r ${ZDOTDIR:-$HOME}/.zshenv ]] && source ${ZDOTDIR:-$HOME}/.zshenv
_cialai_zdotdir_keep
