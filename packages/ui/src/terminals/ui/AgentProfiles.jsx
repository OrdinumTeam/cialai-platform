// SPDX-License-Identifier: Apache-2.0
// Contas dos agentes, para trocar a que os terminais novos vão usar sem
// digitar comando no terminal.
//
// Uma conta é uma pasta de configuração. O Cialai só escolhe qual pasta o
// agente vai usar: nunca troca `auth.json` de lugar, nunca copia credencial e
// nunca mostra nada de dentro de um arquivo de credencial. O cliente também
// não envia caminho nenhum, só o id do perfil; o computador resolve o resto.
//
// A troca vale para sessões novas. Uma tarefa em execução continua na conta em
// que começou, e a tela diz isso.
import React, { useCallback, useEffect, useState } from 'react';
import { Check, CirclePlus, RefreshCw } from 'lucide-react';
import { invoke } from '../../lib/native.js';
import { fmtPlan } from '../files.js';
import { planTone } from './SessionCard.jsx';
import { getLocale, translate } from '../../shared/i18n.js';

// Os dois agentes, na ordem em que aparecem. O rótulo vem do dicionário, que
// guarda o nome do produto igual nos três idiomas.
export const AGENTS = Object.freeze(['claude', 'codex']);

// Agrupa por agente preservando a ordem em que o computador devolveu, que já
// é o padrão primeiro e os nomeados em seguida.
export function groupProfiles(list) {
  return AGENTS
    .map((id) => ({ id, profiles: (list || []).filter((profile) => profile.agent === id) }))
    .filter((group) => group.profiles.length);
}

export default function AgentProfiles({ onCreate, onSelected }) {
  const [profiles, setProfiles] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    invoke('agent_profiles')
      .then((list) => { setProfiles(Array.isArray(list) ? list : []); setError(null); })
      .catch((cause) => { setProfiles([]); setError(cause?.message || String(cause)); });
  }, []);
  useEffect(load, [load]);

  const select = async (profile) => {
    setBusy(profile.id);
    try {
      await invoke('agent_profile_select', { agent: profile.agent, id: profile.id });
      load();
      onSelected?.(profile);
    } catch (cause) {
      setError(cause?.message || String(cause));
    } finally {
      setBusy('');
    }
  };

  const groups = groupProfiles(profiles);
  return (
    <div className="agent-profiles">
      <p className="agent-profiles__note">{translate('terminal.profiles.runningStays')}</p>
      {error ? <p className="agent-profiles__error" role="alert">{error}</p> : null}
      {profiles == null ? <p className="agent-profiles__empty">{translate('terminal.profiles.loading')}</p> : null}
      {profiles != null && !groups.length ? <p className="agent-profiles__empty">{translate('terminal.profiles.none')}</p> : null}
      {groups.map((group) => (
        <section key={group.id} className="agent-profiles__group">
          <header className="agent-profiles__head">
            <h3>{translate(`terminal.profiles.agent.${group.id}`)}</h3>
            {onCreate ? (
              <button type="button" className="agent-profiles__create" onClick={() => onCreate(group.id, load)}>
                <CirclePlus size={15} strokeWidth={1.75} aria-hidden="true" />{translate('terminal.profiles.create')}
              </button>
            ) : null}
          </header>
          {group.profiles.map((profile) => {
            const window = profile.windows?.[0] || null;
            return (
              <div key={profile.id} className={`agent-profiles__row${profile.active ? ' is-active' : ''}`}>
                <span className="agent-profiles__name">
                  {profile.label}
                  {profile.isDefault ? <em className="agent-profiles__tag">{translate('terminal.profiles.default')}</em> : null}
                  {profile.needsLogin ? <em className="agent-profiles__tag is-warn">{translate('terminal.profiles.needsLogin')}</em> : null}
                </span>
                {profile.plan ? <span className="agent-profiles__plan">{profile.plan}</span> : null}
                {window ? (
                  <span className={`agent-profiles__used agent-profiles__used--${planTone(window.usedPercent)}`} title={translate('terminal.profiles.windowUsed', { label: window.label, usage: fmtPlan(window.usedPercent) })}>
                    {fmtPlan(window.usedPercent)}
                  </span>
                ) : null}
                {profile.active ? (
                  <span className="agent-profiles__current"><Check size={15} strokeWidth={2} aria-hidden="true" />{translate('terminal.profiles.inUse')}</span>
                ) : (
                  <button type="button" className="agent-profiles__use" disabled={busy === profile.id} onClick={() => select(profile)}>
                    {translate('terminal.profiles.useForNew')}
                  </button>
                )}
              </div>
            );
          })}
        </section>
      ))}
      <button type="button" className="agent-profiles__refresh" onClick={load}>
        <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />{translate('terminal.profiles.refresh')}
      </button>
    </div>
  );
}
