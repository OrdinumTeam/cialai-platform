// SPDX-License-Identifier: Apache-2.0
import { lazy } from 'react';
import { SquareTerminal } from 'lucide-react';

export const DEFAULT_VIEW = 'terminais';
export const VIEW_COMPONENTS = { terminais: lazy(() => import('./Terminais.jsx')) };
export const VIEWS = [
  { id: 'terminais', label: 'Terminais', sub: 'Sessões, arquivos e navegador', icon: SquareTerminal },
];

export function sanitizeView(id) {
  return VIEW_COMPONENTS[id] ? id : DEFAULT_VIEW;
}

export function getView(id) {
  return VIEWS.find((view) => view.id === sanitizeView(id)) || VIEWS[0];
}

export function groupViews(views = VIEWS) {
  const groups = [];
  for (const view of views) {
    const key = view.group || '';
    let entry = groups.find((candidate) => candidate.key === key);
    if (!entry) { entry = { key, group: view.group || null, views: [] }; groups.push(entry); }
    entry.views.push(view);
  }
  return groups;
}
