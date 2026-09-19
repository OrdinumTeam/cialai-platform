// SPDX-License-Identifier: Apache-2.0
// Indices de demonstracao do grafo da documentacao, no formato exato do
// `DocScan` que o Rust devolve. Servem as capturas do `wksnap` e a verificacao
// em navegador, que rodam com `?terminais=demo` e sem o app por tras.
//
// O cenario `real` repete a distribuicao medida no proprio repositorio: doze
// ramos, um deles dominante, uma pasta com 271 documentos diretos e dez niveis
// de profundidade. Nada e sorteado: a mesma URL desenha sempre o mesmo grafo.
//
// Cenario pela URL: `docgraph_case=real|small|empty|partial|error|indexing`.
// Sem o parametro, o cenario sai do nome da raiz, para a troca de raiz durante
// a varredura poder ser observada na verificacao.

import { STRINGS } from './copy.js';

const SMALL = [
  'README.md',
  'programas/azul/README.md',
  'programas/azul/arquitetura.md',
  'programas/azul/tarefas.md',
  'programas/verde/docs/instalacao.md',
  'docs/guia/primeiros-passos.md',
  'docs/guia/Relatório Ação.md',
  'docs/api/referencia.md',
];

function series(prefix, count, name = 'pagina') {
  return Array.from({ length: count }, (_, index) => `${prefix}/${name}-${String(index + 1).padStart(3, '0')}.md`);
}

function realPaths() {
  const pages = 'docs/integrations/apify/reference/pages';
  return [
    'README.md',
    ...series(`${pages}/api/v2`, 271, 'endpoint'),
    ...series(`${pages}/api`, 29, 'visao'),
    ...series(`${pages}/integrations`, 78, 'conector'),
    ...series(`${pages}/academy/node-js`, 26, 'aula'),
    ...series(`${pages}/academy/scraping-basics-javascript`, 14, 'licao'),
    ...series(`${pages}/academy/scraping-basics-python`, 13, 'licao'),
    ...series(`${pages}/academy/platform/deploying/getting-started`, 12, 'passo'),
    ...series(`${pages}/academy`, 19, 'trilha'),
    ...series(`${pages}/actors/development`, 34, 'guia'),
    ...series(`${pages}/actors/running`, 18, 'guia'),
    ...series(`${pages}/actors`, 11, 'conceito'),
    ...series(`${pages}/legal`, 15, 'termo'),
    ...series(`${pages}/platform/storage`, 22, 'recurso'),
    ...series(`${pages}/platform/proxy`, 17, 'recurso'),
    ...series('docs/application', 9, 'tela'),
    ...series('docs/infrastructure/aws', 21, 'recurso'),
    ...series('docs/infrastructure/map', 6, 'camada'),
    ...series('docs/architecture', 7, 'decisao'),
    ...series('docs/financeiro', 12, 'rotina'),
    ...series('docs/apps', 8, 'loja'),
    'docs/README.md',
    ...series('storage/ordinum_skills/frontend/clean_corporate_style', 14, 'regra'),
    ...series('storage/ordinum_skills/backend', 18, 'regra'),
    ...series('storage/ordinum_agents/meta_whatsapp_compliance', 9, 'politica'),
    ...series('storage/documents/modelos', 23, 'modelo'),
    ...series('tools/ia', 12, 'nota'),
    ...series('tools/osint', 9, 'nota'),
    ...series('tools/trading', 9, 'nota'),
    ...series('ios/docs', 8, 'tela'),
    'ios/README.md', 'ios/app/README.md', 'ios/app/docs/build.md',
    ...series('infra/oc-0012', 4, 'etapa'),
    ...series('.superpowers/planos', 4, 'plano'),
    'tracking/README.md', 'tracking/embed/LEIAME.md',
    'macos/README.md', 'macos/tools/README.md',
    'plan/16-09-2026-notch-ia.md', 'plan/plan.md',
    'leads/ong/README.md',
    'frontend/README.md',
    'backend/node/README.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
  ];
}

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) { value ^= text.charCodeAt(index); value = Math.imul(value, 16777619); }
  return (value >>> 0).toString(16).padStart(8, '0');
}

function result(root, paths, extra = {}) {
  const docs = [...paths].sort().map((relative, index) => ({ relative, size: 800 + ((index * 37) % 9000), modifiedMs: 1789000000000 - index * 60000, symlink: false, target: null }));
  const dirs = new Set();
  docs.forEach((doc) => { let cursor = doc.relative; while (cursor.includes('/')) { cursor = cursor.slice(0, cursor.lastIndexOf('/')); dirs.add(cursor); } });
  const issues = extra.issues || [];
  return {
    key: '', token: '', root, canonicalRoot: root,
    docs,
    dirs: docs.length ? dirs.size + 1 : 0,
    visited: docs.length * 5 + 40,
    elapsedMs: 12,
    partial: Boolean(issues.length || extra.stopped),
    stopped: extra.stopped || null,
    issues,
    issuesTotal: extra.issuesTotal ?? issues.length,
    excluded: { symlinkDirs: 0, outsideRoot: extra.outsideRoot || 0, brokenLinks: 0, invalidNames: 0, vanished: 0, cacheDirs: 0 },
    fingerprint: hash(`${docs.map((doc) => doc.relative).join('|')}#${issues.length}#${extra.stopped || ''}`),
  };
}

function caseFromUrl() {
  try { return new URLSearchParams(window.location.search).get('docgraph_case') || ''; } catch (_error) { return ''; }
}

// Documentos acrescentados ou retirados pela verificacao, para simular o disco
// mudando entre uma varredura e outra.
const mutations = { added: new Set(), removed: new Set() };

export function mutateDemo({ add = [], remove = [], reset = false } = {}) {
  if (reset) { mutations.added.clear(); mutations.removed.clear(); }
  add.forEach((path) => { mutations.added.add(path); mutations.removed.delete(path); });
  remove.forEach((path) => { mutations.removed.add(path); mutations.added.delete(path); });
}

export function buildDemoScan(root, forced = '') {
  const name = String(root || '').replace(/\/+$/, '').split('/').pop() || '';
  const scenario = forced || caseFromUrl() || (name === 'ordinum-control' ? 'real' : name === 'advoris' ? 'empty' : 'small');
  if (scenario === 'error') {
    const error = new Error(STRINGS.error);
    error.code = 'not_found';
    throw error;
  }
  if (scenario === 'indexing') return new Promise(() => {});
  if (scenario === 'empty') return result(root, []);
  let paths = scenario === 'real' ? realPaths() : SMALL;
  if (scenario === 'partial') {
    return result(root, paths, {
      issues: [{ relative: 'docs/financeiro/privado', code: 'denied' }, { relative: 'storage/db', code: 'denied' }, { relative: 'tools/ia/cache', code: 'io' }],
      issuesTotal: 3,
      outsideRoot: 1,
    });
  }
  paths = paths.filter((path) => !mutations.removed.has(path)).concat([...mutations.added]);
  return result(root, paths);
}
