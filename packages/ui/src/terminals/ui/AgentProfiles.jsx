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
//
// O mesmo componente serve o computador e o celular, com a mesma lista, as
// mesmas ações e os mesmos números. O que muda é a apresentação: no celular a
// conta vira um cartão de três linhas, para nome, plano e uso caberem na
// largura do aparelho sem rolagem lateral; no computador as mesmas partes
// ficam lado a lado.
//
// O uso vem do mesmo lugar para os dois provedores, a loja da Barra de IA, e
// cada percentual aparece com o nome da janela a que pertence. Sem leitura o
// número não vira zero: vira o estado da leitura.
import React, { useCallback, useEffect, useState } from 'react';
import { Check, CirclePlus, RefreshCw } from 'lucide-react';
import { invoke } from '../../lib/native.js';
import { demoProfiles, demoProfilesEnabled } from '../agent-profiles-demo.js';
import { DASH, ageCopy, percentText, qualifierFor, resetCopy, statusMessage, windowLabel } from '../../notch/copy.js';
import { translate } from '../../shared/i18n.js';

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

// Janela do anel do perfil, que é a declarada pelo provedor. Nenhuma outra é
// promovida ao lugar dela: sem a declarada, o perfil fica sem número.
export function headlineWindow(usage) {
  const id = usage?.headlineId;
  if (!id) return null;
  return (usage.windows || []).find((window) => window.id === id) || null;
}

// A janela semanal só aparece quando não repete a do anel.
export function weeklyWindow(usage) {
  const id = usage?.weeklyId;
  if (!id || id === usage?.headlineId) return null;
  return (usage.windows || []).find((window) => window.id === id) || null;
}

// Tom do número: neutro até 75 por cento, atenção até 90, alarme acima disso.
export function usageTone(fraction) {
  if (!Number.isFinite(fraction)) return 'none';
  if (fraction >= 0.9) return 'bad';
  if (fraction >= 0.75) return 'warn';
  return 'ok';
}

// O que a linha mostra no lugar do número quando não há leitura. Ausência de
// informação nunca vira zero por cento. O login pendente aparece só aqui: um
// selo repetindo a mesma frase ao lado do nome espremia a identificação.
export function readingState(profile) {
  const usage = profile?.usage;
  if (profile?.needsLogin) return 'needsLogin';
  if (!usage) return 'unavailable';
  const kind = usage.status?.kind;
  if (kind === 'needsAuth' || kind === 'signedOutByOwner') return 'needsLogin';
  if (kind === 'accessDenied' || kind === 'error') return 'error';
  if (kind === 'unsupported') return 'unmetered';
  if (!usage.windows?.length) return usage.fetchedAtMs ? 'unavailable' : 'reading';
  return kind === 'stale' ? 'stale' : 'ok';
}

const STATE_KEYS = Object.freeze({
  reading: 'terminal.profiles.reading',
  unavailable: 'terminal.profiles.unavailable',
  needsLogin: 'terminal.profiles.needsLogin',
  error: 'terminal.profiles.readError',
  unmetered: 'terminal.profiles.unmetered',
});

// Dica completa da conta: cada janela com o rótulo dela, a renovação quando o
// provedor a publica, a fonte da leitura e a idade do número.
function usageTitle(profile) {
  const usage = profile.usage;
  const lines = [];
  if (profile.account) lines.push(profile.account);
  if (profile.plan) lines.push(translate('terminal.profiles.planNamed', { plan: profile.plan }));
  if (usage?.windows?.length) {
    lines.push('');
    usage.windows.forEach((window) => {
      const reset = resetCopy(window.resetsAtMs);
      lines.push(translate(reset ? 'terminal.profiles.windowRenews' : 'terminal.profiles.windowUsed', {
        label: windowLabel(window),
        usage: `${qualifierFor(usage.fidelity)}${percentText(window.usedFraction)}%`,
        reset,
      }));
    });
  } else if (usage) {
    lines.push('', statusMessage(usage));
  }
  const age = usage?.fetchedAtMs ? ageCopy(usage.fetchedAtMs) : '';
  if (age) lines.push('', age);
  return lines.join('\n').trim() || undefined;
}

function UsageCell({ profile }) {
  const usage = profile.usage;
  const state = readingState(profile);
  const headline = headlineWindow(usage);
  const weekly = weeklyWindow(usage);
  const title = usageTitle(profile);
  if (state !== 'ok' && state !== 'stale') {
    return (
      <span className={`agent-profiles__state agent-profiles__state--${state}`} title={usage ? statusMessage(usage) : undefined}>
        {translate(STATE_KEYS[state] || STATE_KEYS.unavailable)}
      </span>
    );
  }
  const qualifier = qualifierFor(usage.fidelity);
  return (
    <span className={`agent-profiles__usage${state === 'stale' ? ' is-stale' : ''}`} title={title}>
      {headline ? (
        <span className={`agent-profiles__window agent-profiles__window--${usageTone(headline.usedFraction)}`}>
          <em>{windowLabel(headline)}</em>
          <strong>{Number.isFinite(headline.usedFraction) ? `${qualifier}${percentText(headline.usedFraction)}%` : DASH}</strong>
        </span>
      ) : null}
      {weekly ? (
        <span className={`agent-profiles__window agent-profiles__window--${usageTone(weekly.usedFraction)}`}>
          <em>{windowLabel(weekly)}</em>
          <strong>{Number.isFinite(weekly.usedFraction) ? `${qualifier}${percentText(weekly.usedFraction)}%` : DASH}</strong>
        </span>
      ) : null}
      {state === 'stale' ? <span className="agent-profiles__stale">{translate('terminal.profiles.stale')}</span> : null}
    </span>
  );
}

export default function AgentProfiles({ onCreate, onSelected }) {
  const [profiles, setProfiles] = useState(null);
  const [busy, setBusy] = useState('');
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    // Modo de demonstração: contas fictícias, para as capturas e para a
    // verificação em navegador, que não têm computador por trás.
    if (demoProfilesEnabled()) { setProfiles(demoProfiles()); setError(null); return; }
    invoke('agent_profiles')
      .then((list) => { setProfiles(Array.isArray(list) ? list : []); setError(null); })
      .catch((cause) => { setProfiles([]); setError(cause?.message || String(cause)); });
  }, []);
  useEffect(load, [load]);

  // Reler as contas pede ao computador uma leitura nova de todas elas, e só
  // depois busca a lista: sem isso o botão devolvia o mesmo número de antes.
  const reload = async () => {
    if (demoProfilesEnabled()) { load(); return; }
    setReloading(true);
    try { await invoke('agent_profiles_refresh'); }
    catch (_cause) { /* a lista ainda vale com o último valor conhecido */ }
    finally { setReloading(false); load(); }
  };

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
      <p className="agent-profiles__note agent-profiles__note--quiet">{translate('terminal.profiles.usageNote')}</p>
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
          {group.profiles.map((profile) => (
            <div key={profile.id} className={`agent-profiles__row${profile.active ? ' is-active' : ''}`}>
              <div className="agent-profiles__identity">
                <span className="agent-profiles__name" title={profile.account || profile.label}>{profile.label}</span>
                <span className="agent-profiles__tags">
                  {profile.isDefault ? <em className="agent-profiles__tag">{translate('terminal.profiles.default')}</em> : null}
                  {profile.plan ? <em className="agent-profiles__tag agent-profiles__tag--plan">{profile.plan}</em> : null}
                </span>
              </div>
              <UsageCell profile={profile} />
              {profile.active ? (
                <span className="agent-profiles__current"><Check size={15} strokeWidth={2} aria-hidden="true" />{translate('terminal.profiles.inUse')}</span>
              ) : (
                <button
                  type="button"
                  className="agent-profiles__use"
                  disabled={busy === profile.id}
                  aria-label={translate('terminal.profiles.useFor', { name: profile.label })}
                  title={translate('terminal.profiles.useFor', { name: profile.label })}
                  onClick={() => select(profile)}
                >
                  {translate('terminal.profiles.use')}
                </button>
              )}
            </div>
          ))}
        </section>
      ))}
      <button type="button" className="agent-profiles__refresh" disabled={reloading} onClick={reload}>
        <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />{translate(reloading ? 'terminal.profiles.refreshing' : 'terminal.profiles.refresh')}
      </button>
    </div>
  );
}
