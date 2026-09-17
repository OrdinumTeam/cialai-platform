import { useSyncExternalStore } from 'react';

// Anel com as últimas linhas de diagnóstico do app e do núcleo. O app registra o
// que decide, como o código HTTP de uma sondagem que falhou e o motivo de cada
// tela sem conexão; o núcleo chega pelo evento `log`. Ajustes mostra o anel no
// diagnóstico avançado, para o motivo de uma queda ser lido no próprio aparelho.
export type DiagnosticLevel = 'error' | 'info' | 'debug';
export type DiagnosticLine = { at: number; level: DiagnosticLevel; message: string };

export const DIAGNOSTIC_LOG_CAPACITY = 80;

let lines: readonly DiagnosticLine[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly DiagnosticLine[]) {
  lines = next;
  for (const listener of listeners) listener();
}

export function recentDiagnostics(): readonly DiagnosticLine[] {
  return lines;
}

export function subscribeDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function appendDiagnostic(line: DiagnosticLine): void {
  const kept = lines.length >= DIAGNOSTIC_LOG_CAPACITY ? lines.slice(lines.length - DIAGNOSTIC_LOG_CAPACITY + 1) : lines;
  publish([...kept, line]);
}

export function clearDiagnostics(): void {
  publish([]);
}

// Linha decidida pelo app; o prefixo distingue do que o núcleo emite.
export function logApp(level: DiagnosticLevel, message: string, at = Date.now()): void {
  appendDiagnostic({ at, level, message: `app: ${message}` });
}

// Linha do núcleo, repassada como veio.
export function logCore(level: DiagnosticLevel, message: string, at = Date.now()): void {
  appendDiagnostic({ at, level, message });
}

export function useDiagnosticLog(): readonly DiagnosticLine[] {
  return useSyncExternalStore(subscribeDiagnostics, recentDiagnostics, recentDiagnostics);
}

const pad = (value: number) => String(value).padStart(2, '0');

// Hora local sem depender do Intl do aparelho, para a leitura ser a mesma em teste.
export function formatDiagnosticTime(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
