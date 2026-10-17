// SPDX-License-Identifier: Apache-2.0
// Nome do perfil no selo do card de sessao.
//
// O apelido dado na Barra de IA vence, inclusive na pasta padrao: e o mesmo
// nome que a pessoa ve nos aneis. Sem apelido vale o nome que o terminal
// exporta em CLAUDE_PROFILE ou CODEX_PROFILE, e a pasta padrao fica sem selo,
// porque numa maquina com uma conta so ele nao diria nada.

const DEFAULT_PROFILES = Object.freeze({ 'Claude Code': 'claude', Codex: 'codex' });

export function activityProfile(activity) {
  return activity?.profile || DEFAULT_PROFILES[activity?.agent || activity?.foreground?.agent] || null;
}

export function profileBadge(activity, account) {
  const profile = activityProfile(activity);
  if (!profile) return null;
  const alias = typeof account?.alias === 'string' ? account.alias.trim() : '';
  if (alias) return alias;
  if (Object.values(DEFAULT_PROFILES).includes(profile)) return null;
  return activity.profileName || null;
}
