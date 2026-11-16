// SPDX-License-Identifier: Apache-2.0
// Ícones das teclas e das ações do terminal do celular, num lugar só. A barra
// inferior e o teclado especial leem deste mapa, então a mesma tecla tem o
// mesmo desenho nos dois, com o mesmo tamanho e a mesma espessura de traço.
//
// As chaves são os ids do catálogo de `keyboard-prefs.js`, os nomes dos
// modificadores e as ações da barra que abrem um painel. Tecla sem entrada
// aqui aparece com o próprio rótulo, como Home ou Ctrl D.
import React from 'react';
import {
  ArrowBigUp, ArrowDown, ArrowLeft, ArrowLeftToLine, ArrowRight, ArrowRightToLine, ArrowUp, ChevronUp, Clipboard, ClipboardPaste,
  Command, CornerDownLeft, Delete, History, Keyboard, MessageSquareText, Option, Square, SquareTerminal, Zap, createLucideIcon,
} from 'lucide-react';

// Esc é o ⎋ dos teclados: a seta que sai de dentro de um círculo aberto. O
// lucide não tem esse glifo, e o de desfazer diria outra coisa. Este segue a
// grade de 24, o traço e as pontas arredondadas dele; a abertura larga afasta
// a seta do arco, para não parecer uma seta de girar.
export const EscapeKey = createLucideIcon('escape-key', [
  ['path', { d: 'M14.8 6.1A7.5 7.5 0 1 1 6.1 14.8', key: 'ring' }],
  ['path', { d: 'M3 8V3h5', key: 'head' }],
  ['path', { d: 'm3 3 9 9', key: 'shaft' }],
]);

export const KEY_ICON_SIZE = 22;
export const KEY_ICON_STROKE = 2;

export const KEY_ICONS = Object.freeze({
  Enter: CornerDownLeft,
  Escape: EscapeKey,
  // Ctrl C interrompe o processo: é o quadrado de parar, nunca o de copiar.
  CtrlC: Square,
  CtrlV: Clipboard,
  Paste: ClipboardPaste,
  Tab: ArrowRightToLine,
  ShiftTab: ArrowLeftToLine,
  Backspace: Delete,
  CtrlR: History,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ctrl: ChevronUp,
  alt: Option,
  shift: ArrowBigUp,
  meta: Command,
  // Ações da barra: teclado especial, comandos rápidos e caixa de texto, e o
  // teclado do aparelho no rodapé do painel.
  keys: SquareTerminal,
  quick: Zap,
  compose: MessageSquareText,
  native: Keyboard,
});

export const hasKeyIcon = (id) => Boolean(KEY_ICONS[id]);

export function KeyIcon({ id, size = KEY_ICON_SIZE, className }) {
  const Icon = KEY_ICONS[id];
  return Icon ? <Icon size={size} strokeWidth={KEY_ICON_STROKE} className={className} aria-hidden="true" /> : null;
}
