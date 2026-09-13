// SPDX-License-Identifier: Apache-2.0
// User initiated desktop updates backed by the signed Tauri updater feed.

import React, { useEffect, useState } from 'react';
import { isTauri } from '../lib/native.js';
import { translate } from './i18n.js';

const initialStatus = {
  kind: 'idle',
  message: '',
};

function errorMessage(error) {
  return error?.message || String(error || translate('desktop.common.unknownError'));
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
      setVersion(translate('desktop.updater.browserPreview'));
      return undefined;
    }
    import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((current) => { if (!cancelled) setVersion(current); })
      .catch(() => { if (!cancelled) setVersion(translate('desktop.common.unavailable')); });
    return () => { cancelled = true; };
  }, [native]);

  const checkForUpdate = async () => {
    if (!native) return;
    setAvailable(null);
    setProgress(null);
    setStatus({ kind: 'checking', message: translate('desktop.updater.checking') });
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) {
        setStatus({ kind: 'current', message: translate('desktop.updater.current') });
        return;
      }
      setAvailable(update);
      setStatus({ kind: 'available', message: translate('desktop.updater.available', { version: update.version }) });
    } catch (error) {
      setStatus({ kind: 'error', message: translate('desktop.updater.checkError', { error: errorMessage(error) }) });
    }
  };

  const installUpdate = async () => {
    if (!available) return;
    let received = 0;
    let total = 0;
    setStatus({ kind: 'downloading', message: translate('desktop.updater.downloading', { version: available.version }) });
    try {
      await available.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength || 0;
          setProgress({ received: 0, total });
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          setProgress({ received, total });
        } else if (event.event === 'Finished') {
          setStatus({ kind: 'installed', message: translate('desktop.updater.installed') });
        }
      });
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (error) {
      setStatus({ kind: 'error', message: translate('desktop.updater.installError', { error: errorMessage(error) }) });
    }
  };

  const percent = progress?.total
    ? Math.min(100, Math.round((progress.received / progress.total) * 100))
    : null;
  const busy = status.kind === 'checking' || status.kind === 'downloading' || status.kind === 'installed';

  return <div className="mac-prefs__update">
    <div className="mac-prefs__row-text">
      <div className="mac-prefs__row-title">{translate('desktop.updater.currentVersion')}</div>
      <div className="mac-prefs__row-desc">{version || translate('desktop.common.loading')}</div>
      <div className={`mac-prefs__row-desc${status.kind === 'error' ? ' mac-prefs__error' : ''}`} role="status" aria-live="polite">{native ? (status.message || translate('desktop.updater.idle')) : translate('desktop.updater.installedOnly')}</div>
      {progress ? <progress aria-label={translate('desktop.updater.progress')} value={progress.received} max={progress.total || undefined}>{percent === null ? translate('desktop.updater.downloadingShort') : `${percent}%`}</progress> : null}
    </div>
    <div className="mac-prefs__actions">
      {available ? <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={installUpdate}>{translate('desktop.updater.install', { version: available.version })}</button> : null}
      <button type="button" className="btn btn-secondary btn-sm" disabled={!native || busy} onClick={checkForUpdate}>{translate('desktop.updater.check')}</button>
    </div>
  </div>;
}
