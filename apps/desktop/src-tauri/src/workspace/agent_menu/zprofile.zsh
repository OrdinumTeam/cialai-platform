# SPDX-License-Identifier: Apache-2.0
# Cialai: carrega o .zprofile do usuario; detalhes em .zshenv.
_cialai_zdotdir_user
[[ -r ${ZDOTDIR:-$HOME}/.zprofile ]] && source ${ZDOTDIR:-$HOME}/.zprofile
_cialai_zdotdir_keep
