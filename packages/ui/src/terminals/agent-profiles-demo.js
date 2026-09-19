// SPDX-License-Identifier: Apache-2.0
// Contas fictícias para as capturas e para a verificação em navegador, com
// `?terminais=demo`. Fora do modo de demonstração nada disto é usado: a tela
// pede as contas ao computador.
//
// O conjunto cobre de propósito o que a tela precisa distinguir, e que uma
// máquina de verdade raramente tem tudo ao mesmo tempo: leitura boa nos dois
// provedores, leitura velha, login pendente, erro de leitura, conta sem
// limite medido, nome comprido e muitas contas no mesmo provedor.
//
// O formato é o mesmo de `agent_profiles`, com a leitura de uso no formato da
// loja da Barra de IA.

const HOUR = 3_600_000;

// Rótulo de janela e estado de leitura seguem os códigos do contrato, como
// em `notch/fixtures.js`: o código chega por parâmetro, e a interface o
// traduz. Nada aqui é texto visível escrito à mão.
function window_(id, label, usedFraction, extra = {}) {
  return { id, label, usedFraction, ...extra };
}

function statusOf(kind, extra = {}) {
  return { kind, ...extra };
}

// `message` de um estado tambem e codigo do contrato, nao texto.
function messageOf(message, extra = {}) {
  return { message, ...extra };
}

function reading(over = {}) {
  return {
    id: 'demo',
    provider: 'claude',
    label: 'demo',
    configDir: '',
    fidelity: 'official',
    status: statusOf('ok'),
    windows: [],
    headlineId: null,
    weeklyId: null,
    fetchedAtMs: Date.now() - 40_000,
    source: 'cli',
    ...over,
  };
}

// A demonstração só liga pela mesma chave que o estúdio usa.
export function demoProfilesEnabled(search = typeof window !== 'undefined' ? window.location.search : '') {
  try {
    return new URLSearchParams(search).get('terminais') === 'demo';
  } catch (_error) {
    return false;
  }
}

export function demoProfiles(now = Date.now()) {
  return [
    {
      id: 'claude',
      agent: 'claude',
      label: 'amorim',
      account: 'amorim@exemplo.com.br',
      plan: 'max',
      isDefault: true,
      active: true,
      needsLogin: false,
      usage: reading({
        id: 'claude',
        plan: 'max',
        headlineId: 'session',
        weeklyId: 'weekly_all',
        windows: [
          window_('session', 'session', 0.41, { resetsAtMs: now + 2 * HOUR }),
          window_('weekly_all', 'weeklyAll', 0.12, { resetsAtMs: now + 96 * HOUR }),
        ],
      }),
    },
    {
      id: 'claude-plataforma-de-conteudo',
      agent: 'claude',
      label: 'plataforma-de-conteudo',
      account: 'plataforma.de.conteudo@exemplo.com.br',
      plan: 'pro',
      isDefault: false,
      active: false,
      needsLogin: false,
      usage: reading({
        id: 'claude-plataforma-de-conteudo',
        plan: 'pro',
        headlineId: 'session',
        windows: [window_('session', 'session', 0.93, { resetsAtMs: now + 40 * 60_000 })],
      }),
    },
    {
      id: 'claude-antiga',
      agent: 'claude',
      label: 'antiga',
      plan: 'pro',
      isDefault: false,
      active: false,
      needsLogin: false,
      usage: reading({
        id: 'claude-antiga',
        plan: 'pro',
        status: statusOf('stale', { sinceMs: now - 3 * HOUR }),
        headlineId: 'session',
        fetchedAtMs: now - 3 * HOUR,
        windows: [window_('session', 'session', 0.58)],
      }),
    },
    {
      id: 'claude-nova',
      agent: 'claude',
      label: 'nova',
      isDefault: false,
      active: false,
      needsLogin: true,
      usage: reading({ id: 'claude-nova', status: statusOf('needsAuth'), fetchedAtMs: 0 }),
    },
    {
      id: 'codex',
      agent: 'codex',
      label: 'amorim',
      account: 'amorim@exemplo.com.br',
      plan: 'plus',
      isDefault: true,
      active: true,
      needsLogin: false,
      usage: reading({
        id: 'codex',
        provider: 'codex',
        plan: 'plus',
        headlineId: 'primary',
        weeklyId: 'secondary',
        source: 'rollout',
        windows: [
          window_('primary', 'duration', 0.03, { durationMs: 5 * HOUR, resetsAtMs: now + 4 * HOUR }),
          window_('secondary', 'duration', 0.09, { durationMs: 168 * HOUR }),
        ],
      }),
    },
    {
      id: 'codex-relatorios',
      agent: 'codex',
      label: 'relatorios',
      plan: 'pro',
      isDefault: false,
      active: false,
      needsLogin: false,
      usage: reading({
        id: 'codex-relatorios',
        provider: 'codex',
        plan: 'pro',
        status: statusOf('error', messageOf('http', { detail: '503' })),
        windows: [],
      }),
    },
    {
      id: 'codex-equipe',
      agent: 'codex',
      label: 'equipe',
      isDefault: false,
      active: false,
      needsLogin: false,
      usage: reading({
        id: 'codex-equipe',
        provider: 'codex',
        status: statusOf('unsupported', messageOf('nothingMetered')),
        windows: [],
      }),
    },
  ];
}
