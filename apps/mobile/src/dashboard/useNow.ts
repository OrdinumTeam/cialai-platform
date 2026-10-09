import { useEffect, useState } from 'react';

// Relógio da tela: "renova em" e "atualizado há" andam sozinhos a cada meio minuto.
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
