import { createContext, useContext, type ReactNode } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { useTokens } from '../theme';

// Verdadeiro quando a barra inferior está na tela: ela já ocupa a área segura
// de baixo, então a tela não reserva esse espaço de novo.
export const BottomNavigationContext = createContext(false);

const WITH_BOTTOM: readonly Edge[] = ['top', 'right', 'bottom', 'left'];
const WITHOUT_BOTTOM: readonly Edge[] = ['top', 'right', 'left'];

type Props = { children: ReactNode; style?: StyleProp<ViewStyle> };

// Raiz das telas nativas: fundo do tema e áreas seguras do aparelho.
export function Screen({ children, style }: Props) {
  const { colors } = useTokens();
  const withNavigation = useContext(BottomNavigationContext);
  return (
    <SafeAreaView edges={withNavigation ? WITHOUT_BOTTOM : WITH_BOTTOM}
      style={[styles.root, { backgroundColor: colors.background }, style]}>
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
