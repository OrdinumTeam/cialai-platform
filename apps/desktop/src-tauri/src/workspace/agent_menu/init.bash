# SPDX-License-Identifier: Apache-2.0
# Cialai: o bash das sessoes nasce com --init-file neste arquivo, que faz o
# que o bash faria e depois carrega o menu de contas. Um shell de login le
# /etc/profile e o primeiro entre ~/.bash_profile, ~/.bash_login e ~/.profile;
# os outros leem ~/.bashrc.
if [ "${CIALAI_BASH_LOGIN-}" = 1 ]; then
  unset CIALAI_BASH_LOGIN
  [ -r /etc/profile ] && . /etc/profile
  if [ -r ~/.bash_profile ]; then
    . ~/.bash_profile
  elif [ -r ~/.bash_login ]; then
    . ~/.bash_login
  elif [ -r ~/.profile ]; then
    . ~/.profile
  fi
else
  [ -r ~/.bashrc ] && . ~/.bashrc
fi
[ -r "${BASH_SOURCE[0]%/*}/../agents.bash" ] && . "${BASH_SOURCE[0]%/*}/../agents.bash"
