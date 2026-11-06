// SPDX-License-Identifier: Apache-2.0
// O que o xterm precisa saber do PTY do Windows. O ConPTY reflui as linhas por
// conta propria e, quando o terminal ganha linhas, abre linhas vazias embaixo
// em vez de devolver o historico. Sem saber disso o xterm reflui por cima, e a
// saida de quem desenha a tela, como o Claude Code, mistura linhas. A partir
// do build 21376 o ConPTY deixa o refluxo com o terminal, e o xterm so o
// mantem ligado quando sabe o build.
//
// Vale so para o PTY deste computador: o de um Broto pode ser de outro
// sistema, e a pagina do celular nao sabe o sistema do computador.

export function windowsPty(info, { phone = false, remote = false } = {}) {
  if (phone || remote || info?.os !== 'windows') return {};
  const build = Number(info.osBuild);
  return Number.isInteger(build) && build > 0 ? { backend: 'conpty', buildNumber: build } : { backend: 'conpty' };
}
