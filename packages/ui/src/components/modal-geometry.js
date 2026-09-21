// SPDX-License-Identifier: Apache-2.0
// Numeros da geometria dos dialogos, num modulo sem JSX para o Node dos
// checks conseguir importar os mesmos valores que a interface usa.
//
// A largura e o teto de altura vivem em CSS estatico, em `desktop/shell.css`,
// e nao so no `sx` do MUI. O motivo e concreto: o `sx` vira classe do emotion,
// injetada em tempo de execucao; se essa injecao falhar, o papel fica sem
// largura e sem teto e a folha se espalha pela janela, com o conteudo cortado
// em cima e embaixo. Em folha estatica a geometria sobrevive a essa falha.
// O `sx` continua, como segunda via, e `tools/check/dialog-geometry.mjs`
// garante que os dois lados nao divirjam.

export const MODAL_WIDTH = Object.freeze({ xs: 400, sm: 520, md: 700, lg: 880 });
export const MODAL_SIZES = Object.freeze(Object.keys(MODAL_WIDTH));

// Teto de altura do papel. Abaixo disto o corpo rola por dentro, e a folha
// nunca cobre a janela de ponta a ponta.
export const MODAL_MAX_HEIGHT_PX = 660;
// Folga lateral e vertical entre o papel e a borda da janela.
export const MODAL_GUTTER_X = 48;
export const MODAL_GUTTER_Y = 96;

// Unidade de viewport, e nao `100%`: a altura percentual depende de o
// contêiner do MUI ter altura propria, que tambem vem do emotion. Em `dvh` o
// teto vale sozinho, e dentro do dialogo os dois valores coincidem.
export const MODAL_MAX_HEIGHT = `min(${MODAL_MAX_HEIGHT_PX}px, calc(100dvh - ${MODAL_GUTTER_Y}px))`;
export const MODAL_MAX_WIDTH = `calc(100vw - ${MODAL_GUTTER_X}px)`;

/// Estilo do papel de um dialogo do estudio. A folha do celular, em
/// mobile.css, sobrepoe largura e margem com `!important`, entao a mesma
/// funcao serve as duas plataformas.
export function modalPaperSx({ maxWidth = 'sm', width, maxHeight } = {}) {
  return {
    width: width ?? MODAL_WIDTH[maxWidth] ?? MODAL_WIDTH.sm,
    maxWidth: MODAL_MAX_WIDTH,
    maxHeight: maxHeight ?? MODAL_MAX_HEIGHT,
  };
}

/// Marcacao do papel, lida pela folha estatica. `size` nomeia a largura; a
/// presenca do atributo ja liga o teto de altura.
export function modalPaperProps({ maxWidth = 'sm', width, maxHeight } = {}) {
  return {
    'data-modal': MODAL_WIDTH[maxWidth] ? maxWidth : 'sm',
    sx: modalPaperSx({ maxWidth, width, maxHeight }),
  };
}
