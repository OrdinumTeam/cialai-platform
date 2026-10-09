// SPDX-License-Identifier: Apache-2.0
// Comandos rápidos do terminal do celular.
//
// Um comando rápido é texto guardado para escrever no terminal, nunca uma
// execução automática: a lista só abre a prévia, e a prévia tem Inserir, que
// escreve e para, e Executar, que escreve e manda o Enter. Os quatro exemplos
// iniciais seguem a mesma regra.
//
// Comandos que apagam, sobrescrevem ou pedem privilégio passam por uma
// confirmação a mais, e quem cadastra pode pedir a mesma confirmação para
// qualquer outro. Senha e token não entram: o salvamento é recusado quando o
// texto parece trazer um segredo, porque a lista fica em claro no
// localStorage da página.

export const QUICK_COMMANDS_KEY = 'cialai_quick_commands';
export const MAX_COMMANDS = 50;
export const MAX_COMMAND_LENGTH = 2000;
const MAX_LABEL_LENGTH = 80;

export const SEED_COMMANDS = Object.freeze([
  { id: 'seed-git-status', command: 'git status', description: 'terminal.phone.quick.seed.gitStatus' },
  { id: 'seed-git-pull', command: 'git pull', description: 'terminal.phone.quick.seed.gitPull' },
  { id: 'seed-npm-dev', command: 'npm run dev', description: 'terminal.phone.quick.seed.npmDev' },
  { id: 'seed-compose-up', command: 'docker compose up', description: 'terminal.phone.quick.seed.composeUp' },
]);

// Efeitos destrutivos ou difíceis de desfazer. A lista erra para o lado de
// pedir confirmação: um toque a mais custa pouco.
const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*[rf][a-z]*\b|--recursive|--force)/i,
  /\bgit\s+reset\s+.*--hard\b/i,
  /\bgit\s+push\b.*(\s-f\b|--force)/i,
  /\bgit\s+clean\s+.*-[a-z]*f/i,
  /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i,
  /\bgit\s+branch\s+-D\b/,
  /\bdocker(\s+compose)?\s+.*\b(prune|down\s+.*-v|rm\s+-f|rmi)\b/i,
  /\bkubectl\s+delete\b/i,
  /\b(drop|truncate)\s+(table|database|schema)\b/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+.*\bof=/i,
  /\bsudo\b/,
  /\bkill(all)?\s+-(9|KILL)\b/i,
  /\bch(mod|own)\s+-[a-z]*R/,
  /(^|[^>])>\s*\/(etc|dev|boot|usr)\//,
  /\bshutdown\b|\breboot\b/i,
];

// Texto que parece segredo. Variável sem valor, como `$TOKEN`, passa: quem
// guarda o valor é o shell, não a lista.
const SECRETS = [
  /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*[^\s$]/i,
  /--(password|passwd|token|secret|api-key)(=|\s+)[^\s$-]/i,
  /\bmysql\b.*\s-p[^\s$]/,
  /\bauthorization:\s*(bearer|basic)\s+[^\s$]/i,
  /\bbearer\s+[a-z0-9._~+/-]{12,}/i,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@$]+@/i,
  /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[a-z0-9_]{10,}/i,
  /\bsk-[a-z0-9_-]{16,}/i,
  /\bxox[abprs]-[a-z0-9-]{10,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bexport\s+\w*(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)\w*=[^\s$]/i,
];

export function isDestructive(command) {
  const text = String(command || '');
  return DESTRUCTIVE.some((pattern) => pattern.test(text));
}

export function containsSecret(command) {
  const text = String(command || '');
  return SECRETS.some((pattern) => pattern.test(text));
}

export function needsConfirmation(entry) {
  return Boolean(entry?.confirm) || isDestructive(entry?.command);
}

// Se a entrega pede o segundo toque. Executar pede quando o comando precisa
// de confirmação; Inserir também, se houver quebra de linha, porque num shell
// sem colagem entre colchetes cada quebra executa a linha anterior.
export function confirmsBefore(entry, enter) {
  return needsConfirmation(entry) && (enter || /[\r\n]/.test(String(entry?.command || '')));
}

// Erro de validação como chave de tradução, ou `null` quando pode salvar.
export function validateCommand(entry) {
  const command = String(entry?.command || '').trim();
  if (!command) return 'terminal.phone.quick.error.empty';
  if (command.length > MAX_COMMAND_LENGTH) return 'terminal.phone.quick.error.tooLong';
  if (containsSecret(command) || containsSecret(entry?.label) || containsSecret(entry?.description)) return 'terminal.phone.quick.error.secret';
  return null;
}

export function quickCommandsStorage() {
  try { return typeof window !== 'undefined' ? window.localStorage : null; }
  catch (_error) { return null; }
}

function clean(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) return null;
  const command = typeof entry.command === 'string' ? entry.command.trim() : '';
  if (!command || command.length > MAX_COMMAND_LENGTH || containsSecret(command)) return null;
  const text = (value) => (typeof value === 'string' ? value.trim().slice(0, MAX_LABEL_LENGTH) : '');
  return { id: entry.id, command, label: text(entry.label), description: text(entry.description), confirm: entry.confirm === true };
}

export function normalizeCommands(value) {
  if (!Array.isArray(value)) return SEED_COMMANDS.map((entry) => ({ label: '', confirm: false, ...entry }));
  const seen = new Set();
  return value.map(clean).filter((entry) => entry && !seen.has(entry.id) && seen.add(entry.id)).slice(0, MAX_COMMANDS);
}

export function readCommands(storage) {
  try { return normalizeCommands(JSON.parse(storage?.getItem(QUICK_COMMANDS_KEY) || 'null')); }
  catch (_error) { return normalizeCommands(null); }
}

export function writeCommands(storage, commands) {
  const normalized = normalizeCommands(commands);
  try { storage?.setItem(QUICK_COMMANDS_KEY, JSON.stringify(normalized)); }
  catch (_error) { /* sem storage */ }
  return normalized;
}

const newId = () => `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Cria ou atualiza. Devolve `{ commands }` ou `{ error }` sem mudar nada.
export function saveCommand(commands, entry, makeId = newId) {
  const error = validateCommand(entry);
  if (error) return { error };
  if (!entry.id && commands.length >= MAX_COMMANDS) return { error: 'terminal.phone.quick.error.full' };
  const next = clean({ ...entry, id: entry.id || makeId() });
  const exists = commands.some((item) => item.id === next.id);
  return { commands: exists ? commands.map((item) => (item.id === next.id ? next : item)) : [...commands, next] };
}

export function removeCommand(commands, id) {
  return commands.filter((item) => item.id !== id);
}

export function moveCommand(commands, id, delta) {
  const from = commands.findIndex((item) => item.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= commands.length) return commands;
  const next = [...commands];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

// Busca por rótulo, descrição e texto do comando, sem diferenciar acentos.
export function filterCommands(commands, query, describe = (entry) => entry.description) {
  const fold = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const needle = fold(query).trim();
  if (!needle) return commands;
  return commands.filter((entry) => [entry.label, entry.command, describe(entry)].some((value) => fold(value).includes(needle)));
}
