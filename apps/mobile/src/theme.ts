import { useColorScheme } from 'react-native';

const light = {
  background: '#F7F5F6',
  surface: '#FFFFFF',
  label: '#171114',
  secondaryLabel: '#6B6065',
  tertiaryLabel: '#91868B',
  separator: 'rgba(73, 43, 57, 0.18)',
  field: '#FFFFFF',
  accent: '#B71867',
  accentPressed: '#8F124F',
  accentText: '#FFFFFF',
  danger: '#D92D20',
  success: '#248A3D',
  warning: '#B25F00',
  overlay: 'rgba(255, 255, 255, 0.94)',
  shadow: '#000000'
} as const;

const dark = {
  background: '#100B0E',
  surface: '#21171C',
  label: '#FFFFFF',
  secondaryLabel: '#C8BBC1',
  tertiaryLabel: '#998C92',
  separator: 'rgba(224, 190, 205, 0.22)',
  field: '#21171C',
  accent: '#FF7AB2',
  accentPressed: '#FF9AC5',
  accentText: '#32101F',
  danger: '#FF6961',
  success: '#30D158',
  warning: '#FFB340',
  overlay: 'rgba(33, 23, 28, 0.94)',
  shadow: '#000000'
} as const;

export function usePalette() {
  return useColorScheme() === 'dark' ? dark : light;
}
