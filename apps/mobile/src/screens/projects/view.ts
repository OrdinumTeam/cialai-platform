// Modo de exibição da aba Projetos: cards em grade, o padrão, ou lista. A
// escolha fica no Secure Store, como a aparência, e vale para todos os
// computadores.
export type ProjectsView = 'grid' | 'list';

export const PROJECTS_VIEW_STORAGE_KEY = 'cialai.projectsView';

// Qualquer valor fora do par conhecido volta para a grade.
export function normalizeProjectsView(value: unknown): ProjectsView {
  return value === 'list' ? 'list' : 'grid';
}
