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
//
// No escopo Projeto inteiro entram tambem codigo, estilo e imagens, e as
// citacoes passam a ligar codigo a codigo. As ligacoes vem como pares de
// indices na lista ordenada, como o Rust manda.

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

// Codigo do caso pequeno, so no escopo Projeto inteiro.
const SMALL_CODE = [
  'package.json',
  'index.html',
  'src/main.js',
  'src/app.js',
  'src/ui/button.jsx',
  'src/ui/theme.css',
  'src/lib/format.js',
  'src/lib/dates.js',
  'src/server/index.py',
  'src/server/routes.py',
  'assets/logo.svg',
  'assets/hero.png',
  'crates/core/Cargo.toml',
  'crates/core/src/lib.rs',
  'crates/core/src/parse.rs',
  '.gitignore',
];

// Quem cita quem no caso pequeno. As duas ultimas linhas so existem no
// escopo Projeto inteiro, porque uma das pontas nao e Markdown.
const SMALL_LINKS = [
  ['README.md', 'docs/guia/primeiros-passos.md'],
  ['README.md', 'docs/api/referencia.md'],
  ['README.md', 'programas/azul/README.md'],
  ['programas/azul/README.md', 'programas/azul/arquitetura.md'],
  ['programas/azul/README.md', 'programas/azul/tarefas.md'],
  ['programas/azul/tarefas.md', 'programas/azul/arquitetura.md'],
  ['docs/guia/primeiros-passos.md', 'docs/api/referencia.md'],
  ['docs/guia/primeiros-passos.md', 'programas/verde/docs/instalacao.md'],
  ['docs/api/referencia.md', 'docs/guia/Relatório Ação.md'],
  ['index.html', 'src/main.js'],
  ['index.html', 'src/ui/theme.css'],
  ['index.html', 'assets/logo.svg'],
  ['src/main.js', 'src/app.js'],
  ['src/app.js', 'src/ui/button.jsx'],
  ['src/app.js', 'src/lib/format.js'],
  ['src/ui/button.jsx', 'src/ui/theme.css'],
  ['src/ui/button.jsx', 'src/lib/format.js'],
  ['src/lib/format.js', 'src/lib/dates.js'],
  ['src/ui/theme.css', 'assets/hero.png'],
  ['src/server/index.py', 'src/server/routes.py'],
  ['crates/core/src/lib.rs', 'crates/core/src/parse.rs'],
  ['docs/api/referencia.md', 'src/server/routes.py'],
  ['README.md', 'assets/logo.svg'],
];

function series(prefix, count, name = 'pagina', extension = 'md') {
  return Array.from({ length: count }, (_, index) => `${prefix}/${name}-${String(index + 1).padStart(3, '0')}.${extension}`);
}

// Codigo do caso grande, so no escopo Projeto inteiro.
function realCode() {
  return [
    ...series('frontend/src/components', 48, 'componente', 'jsx'),
    ...series('frontend/src/screens', 22, 'tela', 'jsx'),
    ...series('frontend/src/styles', 12, 'tema', 'css'),
    ...series('frontend/src/lib', 30, 'util', 'js'),
    ...series('frontend/public/images', 18, 'imagem', 'png'),
    ...series('backend/node/src/routes', 26, 'rota', 'ts'),
    ...series('backend/node/src/services', 19, 'servico', 'ts'),
    ...series('tools/osint/scripts', 14, 'coleta', 'py'),
    ...series('ios/app/Sources', 21, 'View', 'swift'),
    'frontend/package.json', 'backend/node/package.json', 'frontend/index.html',
  ];
}

// Ligacoes do caso grande, sem sorteio: cada arquivo cita o seguinte da mesma
// pasta, e um a cada cinco cita outro longe dele, pela mesma conta de sempre.
function realLinks(paths, allowed) {
  const pairs = [];
  const dirOf = (path) => path.slice(0, path.lastIndexOf('/') + 1);
  paths.forEach((path, index) => {
    if (!allowed(path)) return;
    const next = paths[index + 1];
    if (next && dirOf(next) === dirOf(path) && allowed(next)) pairs.push([path, next]);
    if (index % 5 === 0) {
      const far = paths[(index * 37 + 11) % paths.length];
      if (far !== path && allowed(far)) pairs.push([path, far]);
    }
  });
  return pairs;
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

const DAY_MS = 86400000;

// Tamanho e data saem do caminho: o mesmo arquivo pesa sempre o mesmo, e as
// datas cobrem de hoje a pouco mais de um ano, para o modo de cor por data ter
// o que mostrar.
function facts(relative, index) {
  const value = Number.parseInt(hash(relative).slice(0, 6), 16);
  const markdown = relative.endsWith('.md');
  const size = markdown ? 800 + ((index * 37) % 9000) : 300 + (value % 6000) * (1 + ((value >> 13) % 8));
  const days = [0, 2, 5, 12, 20, 45, 90, 200, 420][value % 9];
  return { size, modifiedMs: Date.now() - days * DAY_MS - (value % 3600) * 1000 };
}

function result(root, paths, extra = {}) {
  const docs = [...paths].sort().map((relative, index) => ({ relative, ...facts(relative, index), symlink: false, target: null }));
  const position = new Map(docs.map((doc, index) => [doc.relative, index]));
  const links = [];
  (extra.links || []).forEach(([from, to]) => {
    if (position.has(from) && position.has(to) && from !== to) links.push([position.get(from), position.get(to)]);
  });
  const dirs = new Set();
  docs.forEach((doc) => { let cursor = doc.relative; while (cursor.includes('/')) { cursor = cursor.slice(0, cursor.lastIndexOf('/')); dirs.add(cursor); } });
  const issues = extra.issues || [];
  return {
    key: '', token: '', root, canonicalRoot: root,
    scope: extra.scope === 'project' ? 'project' : 'docs',
    docs,
    links,
    linksPartial: false,
    linksRead: docs.length,
    dirs: docs.length ? dirs.size + 1 : 0,
    visited: docs.length * 5 + 40,
    elapsedMs: 12,
    partial: Boolean(issues.length || extra.stopped),
    stopped: extra.stopped || null,
    issues,
    issuesTotal: extra.issuesTotal ?? issues.length,
    excluded: { symlinkDirs: 0, outsideRoot: extra.outsideRoot || 0, brokenLinks: 0, invalidNames: 0, vanished: 0, cacheDirs: 0 },
    fingerprint: hash(`${docs.map((doc) => doc.relative).join('|')}#${links.join(';')}#${issues.length}#${extra.stopped || ''}`),
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

export function buildDemoScan(root, forced = '', scope = 'docs') {
  const name = String(root || '').replace(/\/+$/, '').split('/').pop() || '';
  const scenario = forced || caseFromUrl() || (name === 'ordinum-control' ? 'real' : name === 'advoris' ? 'empty' : 'small');
  const project = scope === 'project';
  if (scenario === 'error') {
    const error = new Error(STRINGS.error);
    error.code = 'not_found';
    throw error;
  }
  if (scenario === 'indexing') return new Promise(() => {});
  if (scenario === 'empty') return result(root, [], { scope });
  let paths = scenario === 'real' ? realPaths() : SMALL;
  if (project) paths = paths.concat(scenario === 'real' ? realCode() : SMALL_CODE);
  // No escopo Documentacao so Markdown cita Markdown.
  const allowed = project ? () => true : (path) => path.endsWith('.md');
  const linksFor = (list) => (scenario === 'real' ? realLinks([...list].sort(), allowed) : SMALL_LINKS.filter(([from, to]) => allowed(from) && allowed(to)));
  if (scenario === 'partial') {
    return result(root, paths, {
      scope,
      links: linksFor(paths),
      issues: [{ relative: 'docs/financeiro/privado', code: 'denied' }, { relative: 'storage/db', code: 'denied' }, { relative: 'tools/ia/cache', code: 'io' }],
      issuesTotal: 3,
      outsideRoot: 1,
    });
  }
  paths = paths.filter((path) => !mutations.removed.has(path)).concat([...mutations.added]);
  return result(root, paths, { scope, links: linksFor(paths) });
}
