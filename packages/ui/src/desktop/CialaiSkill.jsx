// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useState } from 'react';
import { invoke, isTauri } from '../lib/native.js';
import { translate as t } from './i18n.js';
const STATES = { installed: 'desktop.brotos.skillInstalled', outdated: 'desktop.brotos.skillOutdated', kept: 'desktop.brotos.skillKept', available: 'desktop.brotos.skillAvailable', missing: 'desktop.brotos.skillMissing' };
export default function CialaiSkill() {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { if (isTauri()) invoke('skill_status').then(setItems).catch(() => setError(true)); }, []);
  const change = async (agent, remove, removeShared = false) => {
    setBusy(true); setError(false);
    try { setItems(await invoke('skill_change', { agent, remove, removeShared })); } catch { setError(true); } finally { setBusy(false); }
  };
  if (!isTauri()) return null;
  return <section className="broto-skill"><h4>{t('desktop.brotos.skillTitle')}</h4>{items.map(item => <div className="broto-skill__row" key={item.agent}><strong>{item.agent === 'claude' ? 'Claude Code' : 'Codex'}</strong><span>{t(STATES[item.state] || STATES.missing)}</span>{item.shared && <small>{t('desktop.brotos.skillShared')}</small>}{!['missing', 'kept'].includes(item.state) && (!item.shared || items.find(other => other.shared)?.agent === item.agent) && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => change(item.agent, item.state === 'installed', item.shared === true)}>{t(item.state === 'installed' ? (item.shared ? 'desktop.brotos.skillRemoveShared' : 'desktop.brotos.skillRemove') : 'desktop.brotos.skillInstall')}</button>}</div>)}{error && <p role="alert">{t('desktop.brotos.error')}</p>}</section>;
}
