# SPDX-License-Identifier: Apache-2.0
# Cialai: carrega o .zlogin do usuario e devolve o ZDOTDIR dele; detalhes em
# .zshenv.
_cialai_zdotdir_user
[[ -r ${ZDOTDIR:-$HOME}/.zlogin ]] && source ${ZDOTDIR:-$HOME}/.zlogin
_cialai_zdotdir_done
