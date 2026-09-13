// SPDX-License-Identifier: Apache-2.0
// User initiated desktop updates backed by the signed Tauri updater feed.

import React, { useEffect, useState } from 'react';
import { isTauri } from '../lib/native.js';

const initialStatus = {
  kind: 'idle',
  message: 'Busque uma nova versão quando quiser.',
};

function errorMessage(error) {
  return error?.message || String(error || 'erro desconhecido');
}

export default function Updater() {
  const native = isTauri();
  const [version, setVersion] = useState('');
  const [available, setAvailable] = useState(null);
  const [status, setStatus] = useState(initialStatus);
  const [progress, setProgress] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!native) {
      setVersion('prévia do navegador');
      return undefined;
    }
    import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((current) => { if (!cancelled) setVersion(current); })
      .catch(() => { if (!cancelled) setVersion('indisponível'); });
    return () => { cancelled = true; };
  }, [native]);

  const checkForUpdate = async () => {
    if (!native) return;
    setAvailable(null);
    setProgress(null);
    setStatus({ kind: 'checking', message: 'Buscando atualização…' });
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) {
        setStatus({ kind: 'current', message: 'O Cialai está atualizado.' });
        return;
      }
      setAvailable(update);
      setStatus({ kind: 'available', message: `Versão ${update.version} disponível.` });
    } catch (error) {
      setStatus({ kind: 'error', message: `Não foi possível buscar atualizações: ${errorMessage(error)}` });
    }
  };

  const installUpdate = async () => {
    if (!available) return;
    let received = 0;
    let total = 0;
    setStatus({ kind: 'downloading', message: `Baixando a versão ${available.version}…` });
    try {
      await available.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength || 0;
          setProgress({ received: 0, total });
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          setProgress({ received, total });
        } else if (event.event === 'Finished') {
          setStatus({ kind: 'installed', message: 'Atualização instalada. Reiniciando o Cialai…' });
        }
      });
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (error) {
      setStatus({ kind: 'error', message: `Não foi possível instalar a atualização: ${errorMessage(error)}` });
    }
  };

  const percent = progress?.total
    ? Math.min(100, Math.round((progress.received / progress.total) * 100))
    : null;
  const busy = status.kind === 'checking' || status.kind === 'downloading' || status.kind === 'installed';

  return <div className="mac-prefs__update">
    <div className="mac-prefs__row-text">
      <div className="mac-prefs__row-title">Versão atual</div>
      <div className="mac-prefs__row-desc">{version || 'Carregando…'}</div>
      <div className={`mac-prefs__row-desc${status.kind === 'error' ? ' mac-prefs__error' : ''}`} role="status" aria-live="polite">{native ? status.message : 'A busca funciona somente no aplicativo instalado.'}</div>
      {progress ? <progress aria-label="Progresso da atualização" value={progress.received} max={progress.total || undefined}>{percent === null ? 'Baixando' : `${percent}%`}</progress> : null}
    </div>
    <div className="mac-prefs__actions">
      {available ? <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={installUpdate}>Instalar versão {available.version}</button> : null}
      <button type="button" className="btn btn-secondary btn-sm" disabled={!native || busy} onClick={checkForUpdate}>Buscar atualização</button>
    </div>
  </div>;
}
