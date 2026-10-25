// SPDX-License-Identifier: Apache-2.0
// Publica as contas do Codex e do Claude Code para o menu que o shell das
// sessões mostra ao digitar codex ou claude. A interface manda o texto já
// traduzido, com a cota e a hora da volta, e o id de cada conta; o Rust tira
// a pasta da própria pasta pessoal e grava em ~/.cialai/agents.

import { invoke, isTauri } from '../lib/native.js';
import { AGENTS, menuEntries } from './agent-profiles-model.js';
import { getLocale, translate } from './i18n.js';

// O mesmo ritmo com que os cards releem as contas: no macOS cada leitura
// pergunta ao chaveiro se cada conta nomeada do Claude Code tem credencial.
const PUBLISH_MS = 60_000;

export async function publishAgentMenu() {
  if (!isTauri()) return;
  const profiles = await invoke('agent_profiles');
  const context = { now: Date.now(), locale: getLocale(), t: translate };
  const strings = {
    question: translate('agentProfiles.tutorial.question'),
    enter: translate('agentProfiles.tutorial.enterUses', { name: '{name}' }),
    missing: translate('agentProfiles.menuMissing', { name: '{name}' }),
  };
  for (const agent of AGENTS) {
    await invoke('agent_menu_publish', { agent: agent.id, entries: menuEntries(profiles, agent.id, context), strings });
  }
}

// Laço da janela principal: a cota muda com o uso, então a lista é refeita
// de tempos em tempos enquanto o app está aberto.
export function startAgentMenuPublisher() {
  if (!isTauri()) return () => {};
  let stopped = false;
  let timer = null;
  const tick = async () => {
    try { await publishAgentMenu(); } catch (error) { console.error('[agent-menu]', error); }
    if (!stopped) timer = setTimeout(tick, PUBLISH_MS);
  };
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}
