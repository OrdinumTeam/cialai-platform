// SPDX-License-Identifier: Apache-2.0
// Shared organization colors. null means no assigned color.
export const ORGANIZATION_COLORS = [
  { id: 'azul', light: '#1a4fa0', dark: '#4a8ae6' },
  { id: 'verde', light: '#1f9d5b', dark: '#3ccf76' },
  { id: 'ciano', light: '#0891b2', dark: '#22d3ee' },
  { id: 'roxo', light: '#7c3aed', dark: '#a78bfa' },
  { id: 'rosa', light: '#db2777', dark: '#f472b6' },
  { id: 'laranja', light: '#ea580c', dark: '#fb923c' },
  { id: 'amarelo', light: '#b7791f', dark: '#facc15' },
  { id: 'vermelho', light: '#dc2626', dark: '#f87171' },
  { id: 'cinza', light: '#6b7280', dark: '#9ca3af' },
  // Segunda fileira, acrescentada em 09/2026. Os ids acima nao mudam, para
  // sessões já gravadas manterem a cor.
  { id: 'indigo', light: '#4338ca', dark: '#818cf8' },
  { id: 'marinho', light: '#1e3a8a', dark: '#8da2fb' },
  { id: 'turquesa', light: '#0f766e', dark: '#2dd4bf' },
  { id: 'menta', light: '#059669', dark: '#6ee7b7' },
  { id: 'lima', light: '#4d7c0f', dark: '#a3e635' },
  { id: 'ambar', light: '#b45309', dark: '#fbbf24' },
  { id: 'coral', light: '#e11d48', dark: '#fb7185' },
  { id: 'magenta', light: '#a21caf', dark: '#e879f9' },
  { id: 'lavanda', light: '#7c6fcd', dark: '#c7bfff' },
];

export function organizationColorStyle(color) {
  const entry = ORGANIZATION_COLORS.find((item) => item.id === color);
  return entry ? { '--organization-light': entry.light, '--organization-dark': entry.dark } : undefined;
}
