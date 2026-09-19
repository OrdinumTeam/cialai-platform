// SPDX-License-Identifier: Apache-2.0
// Indicador de atividade de uma sessão. Três barras que respiram enquanto há
// processamento de verdade, um ponto parado no resto do tempo. O card da
// lista, o cabeçalho do computador e o cabeçalho do celular usam este mesmo
// componente, alimentado pelo mesmo `deriveActivity`, para nunca discordarem.
import React from 'react';

export default function ActivityIndicator({ tone = 'ok', animated = false, className = '' }) {
  const extra = className ? ` ${className}` : '';
  if (animated) {
    return (
      <span className={`terminais-activity terminais-activity--${tone}${extra}`} aria-hidden="true">
        <i /><i /><i />
      </span>
    );
  }
  return <span className={`dot terminais-card__dot terminais-card__dot--${tone}${extra}`} aria-hidden="true" />;
}
