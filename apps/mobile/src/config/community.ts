// SPDX-License-Identifier: Apache-2.0
// Espaços de conversa da comunidade, os mesmos que o site publica.
//
// Endereço é dado, não texto de interface: ele fica aqui e não no catálogo de
// idiomas, para não passar pela varredura de separadores e para os três
// idiomas apontarem sempre para a mesma sala.

export type Community = {
  id: 'discord' | 'whatsapp';
  url: string;
};

export const COMMUNITIES: readonly Community[] = Object.freeze([
  { id: 'discord', url: 'https://discord.gg/Kd4yjB24wP' },
  { id: 'whatsapp', url: 'https://chat.whatsapp.com/JktntW0R31gKdvCBnLj9cQ' },
]);

/// Só endereço público de convite, e só por https. A Home abre no navegador do
/// sistema, então uma origem inesperada aqui viraria abertura de app terceiro.
export function isCommunityUrl(url: string): boolean {
  return /^https:\/\/(discord\.gg|chat\.whatsapp\.com)\/[\w-]+$/.test(url);
}
