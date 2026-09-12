// SPDX-License-Identifier: Apache-2.0
// Provedores de itens da paleta de comandos. Uma view registra uma funcao
// que devolve itens enquanto esta montada, como as sessoes do estudio de
// terminais, e a paleta os junta aos itens fixos ao abrir. Cada item segue
// o formato dos fixos: id, kind, label, hint, icon, shortcut e run.

const providers = new Set();

export function registerPaletteProvider(provider) {
  providers.add(provider);
  return () => providers.delete(provider);
}

export function collectPaletteItems() {
  const items = [];
  providers.forEach((provider) => {
    try {
      const result = provider();
      if (Array.isArray(result)) items.push(...result.filter(Boolean));
    } catch (error) {
      console.error('[palette]', error);
    }
  });
  return items;
}
