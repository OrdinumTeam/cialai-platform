// SPDX-License-Identifier: Apache-2.0
// Icones que uma sessao pode receber, todos de linha, da mesma biblioteca do
// resto da interface. A ordem e a da grade do seletor: trabalho de codigo
// primeiro, depois infraestrutura, ferramentas, documentos e afeto.
//
// O id e o que fica gravado na sessao e viaja ao Rust e ao celular. Ids
// novos entram no fim; os de cima nao mudam, para sessoes ja gravadas
// manterem o icone. `null` e o icone padrao, que sai do que roda na sessao.

import {
  BookOpen, Bot, Brain, Briefcase, ChartLine, Cloud, Code, Coffee, Container, Database, FileText, Flame,
  FlaskConical, GitBranch, Globe, Heart, Monitor, Package, Palette, Rocket, Server, Shield, Smartphone, Sparkles,
  SquareTerminal, Star, Workflow, Wrench, Zap, Bug,
} from 'lucide-react';

export const SESSION_ICONS = Object.freeze([
  { id: 'terminal', Icon: SquareTerminal },
  { id: 'code', Icon: Code },
  { id: 'bug', Icon: Bug },
  { id: 'rocket', Icon: Rocket },
  { id: 'database', Icon: Database },
  { id: 'server', Icon: Server },
  { id: 'globe', Icon: Globe },
  { id: 'smartphone', Icon: Smartphone },
  { id: 'monitor', Icon: Monitor },
  { id: 'package', Icon: Package },
  { id: 'git-branch', Icon: GitBranch },
  { id: 'container', Icon: Container },
  { id: 'flask', Icon: FlaskConical },
  { id: 'wrench', Icon: Wrench },
  { id: 'shield', Icon: Shield },
  { id: 'cloud', Icon: Cloud },
  { id: 'zap', Icon: Zap },
  { id: 'workflow', Icon: Workflow },
  { id: 'book', Icon: BookOpen },
  { id: 'file-text', Icon: FileText },
  { id: 'palette', Icon: Palette },
  { id: 'sparkles', Icon: Sparkles },
  { id: 'bot', Icon: Bot },
  { id: 'brain', Icon: Brain },
  { id: 'chart', Icon: ChartLine },
  { id: 'briefcase', Icon: Briefcase },
  { id: 'star', Icon: Star },
  { id: 'heart', Icon: Heart },
  { id: 'flame', Icon: Flame },
  { id: 'coffee', Icon: Coffee },
].map((entry) => Object.freeze({ ...entry, labelKey: `terminal.icon.${entry.id}` })));

const BY_ID = new Map(SESSION_ICONS.map((entry) => [entry.id, entry]));

/// O id quando ele existe no registro, senao null, que e o icone padrao.
export function validIcon(id) {
  return typeof id === 'string' && BY_ID.has(id) ? id : null;
}

export function sessionIconEntry(id) {
  return BY_ID.get(validIcon(id)) || null;
}

/// O agente reconhecido em primeiro plano, ou em segundo quando o terminal
/// voltou ao prompt, como `claude` ou `codex`. Sem agente, null.
export function sessionAgentKind(session) {
  const activity = session?.activity;
  const name = activity?.foreground?.agent || activity?.agent || '';
  if (/claude/i.test(name)) return 'claude';
  if (/codex/i.test(name)) return 'codex';
  return null;
}

/// O que o icone da sessao desenha: o escolhido, ou o padrao adequado. O
/// padrao e o glifo do agente que roda na sessao, ou o terminal.
export function resolveSessionIcon(session) {
  const entry = sessionIconEntry(session?.icon);
  if (entry) return { kind: 'custom', id: entry.id, Icon: entry.Icon };
  const agent = sessionAgentKind(session);
  if (agent) return { kind: 'agent', id: null, agent };
  return { kind: 'default', id: null, Icon: SquareTerminal };
}
