// SPDX-License-Identifier: Apache-2.0
// Assinaturas finas do runtime para os componentes do estudio. Cada
// componente redesenha so nos eventos que lhe dizem respeito: um card na
// atividade da propria sessao, o explorador na arvore da propria sessao, a
// lista quando a lista muda. A saida do terminal nunca chega a quem nao a
// mostra.

import { useEffect, useReducer, useRef } from 'react';
import { subscribe } from './runtime.js';

function matches(event, types, id) {
  if (!event || !types.includes(event.type)) return false;
  if (id && event.id && event.id !== id) return false;
  return true;
}

// Redesenha quando chega um evento de um dos tipos, opcionalmente so da
// sessao `id`.
export function useRuntimeEvents(types, id = null) {
  const [, force] = useReducer((value) => value + 1, 0);
  const key = types.join(',');
  useEffect(() => subscribe((event) => {
    if (matches(event, key.split(','), id)) force();
  }), [key, id]);
}

// Redesenha so quando o valor derivado muda, mesmo que o evento chegue com
// frequencia: o explorador acompanha o diretorio do shell sem redesenhar a
// arvore a cada amostra de metrica.
export function useRuntimeValue(types, id, selector) {
  const [, force] = useReducer((value) => value + 1, 0);
  const last = useRef(selector());
  const key = types.join(',');
  useEffect(() => subscribe((event) => {
    if (!matches(event, types, id)) return;
    const next = selector();
    if (next !== last.current) {
      last.current = next;
      force();
    }
  }), [key, id, selector]);
  return last.current;
}
