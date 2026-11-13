# SPDX-License-Identifier: Apache-2.0
# Cialai: carrega o .zshrc do usuario e depois o menu de contas; detalhes em
# .zshenv.
_cialai_zdotdir_user
# O /etc/zshrc do macOS monta o historico com o ZDOTDIR desta pasta.
[[ ${HISTFILE-} == $_cialai_zsh_dir/.zsh_history ]] && HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history
[[ -r ${ZDOTDIR:-$HOME}/.zshrc ]] && source ${ZDOTDIR:-$HOME}/.zshrc
_cialai_zdotdir_keep
[[ -r $_cialai_zsh_dir/../agents.zsh ]] && source $_cialai_zsh_dir/../agents.zsh
if [[ -o login ]]; then
  ZDOTDIR=$_cialai_zsh_dir
else
  _cialai_zdotdir_done
fi
