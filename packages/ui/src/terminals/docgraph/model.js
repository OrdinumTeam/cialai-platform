// SPDX-License-Identifier: Apache-2.0
// Modelo puro do grafo da documentacao: a hierarquia podada, as contagens, a
// diferenca entre dois indices, a expansao padrao, o que esta a vista e os
// grupos de cor. Nada aqui toca o disco, o DOM ou o Tauri, entao o script
// `scripts/check-docgraph.mjs` importa e testa tudo direto no Node.
//
// A regra de poda mora em `buildTree`: os nos sao os Markdown devolvidos pela
// varredura do Rust mais os ancestrais de cada um ate a raiz. Uma pasta sem
// Markdown em nenhum descendente nunca vira no, porque ninguem a cita. Recolher
// uma pasta so muda a cena visivel; o indice e as contagens nao mudam.
//
// Ids: o caminho relativo com `/`, exatamente como esta no disco, e `.` para a
// raiz, como `relativePath()` de `files.js`. Nada de minusculas nem de NFC no
// id: dois `README.md` em pastas diferentes sao nos diferentes e a caixa do
// sistema de arquivos e preservada. A forma dobrada de `foldKey` serve so a
// busca, a ordenacao e ao pareamento de renomeacao.

export const ROOT_ID = '.';

// Tons dos grupos, na ordem em que sao entregues. Saiu do validador da skill
// dataviz sobre a paleta compartilhada: sem o azul de acento e sem os tons de
// estado, e o maior conjunto que passa em daltonismo e em visao normal, em
// todos os pares e nos dois temas. O excedente usa o neutro.
export const GROUP_TONES = ['ciano', 'rosa', 'indigo', 'lima'];
export const NEUTRAL_TONE = 'cinza';

// Marcas visiveis por padrao: acima disso a expansao para de descer.
export const VISIBLE_BUDGET = 1500;

/* ── caminhos e texto ─────────────────────────────────────────────── */

// Sem acento e em minusculas: "Relatório" e "relatorio" casam, e um nome em
// NFD casa com a busca digitada em NFC.
export function foldKey(text) {
  return String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function parentId(id) {
  if (id === ROOT_ID) return null;
  const index = id.lastIndexOf('/');
  return index < 0 ? ROOT_ID : id.slice(0, index);
}

export function nameOf(id) {
  if (id === ROOT_ID) return '';
  const index = id.lastIndexOf('/');
  return index < 0 ? id : id.slice(index + 1);
}

// O caminho absoluto sai sempre da raiz da sessao como ela esta no explorador,
// nunca da raiz canonizada: `findTab` compara a string exata, e uma raiz
// diferente abriria uma segunda aba para o mesmo arquivo.
export function absPath(root, id) {
  const base = String(root || '').replace(/\/+$/, '');
  return id === ROOT_ID ? base || '/' : `${base}/${id}`;
}

export function idOfPath(root, path) {
  const base = String(root || '').replace(/\/+$/, '');
  const target = String(path || '').replace(/\/+$/, '');
  if (target === base) return ROOT_ID;
  if (!target.startsWith(`${base}/`)) return null;
  return target.slice(base.length + 1);
}

function validRelative(relative) {
  if (typeof relative !== 'string' || !relative || relative.startsWith('/')) return false;
  return relative.split('/').every((part) => part && part !== '.' && part !== '..');
}

function compareNodes(a, b) {
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/* ── arvore ───────────────────────────────────────────────────────── */

function makeDir(id, parent, depth, rootName) {
  const name = id === ROOT_ID ? rootName : nameOf(id);
  return {
    id, kind: id === ROOT_ID ? 'root' : 'dir', name, parent, depth,
    dirs: [], docs: [], docCount: 0, partial: false,
    key: foldKey(name), pathKey: id === ROOT_ID ? '' : foldKey(id),
  };
}

// Monta a hierarquia podada a partir do resultado da varredura. Entradas
// invalidas ou repetidas sao rejeitadas e contadas, nunca levadas adiante.
export function buildTree(scan, { rootName = '' } = {}) {
  const nodes = new Map();
  nodes.set(ROOT_ID, makeDir(ROOT_ID, null, 0, rootName));
  let rejected = 0;
  const docs = Array.isArray(scan?.docs) ? scan.docs : [];
  docs.forEach((entry) => {
    const relative = entry?.relative;
    if (!validRelative(relative) || nodes.has(relative)) { rejected += 1; return; }
    const parts = relative.split('/');
    // Um arquivo nao pode ser pasta de outro. Confere antes de criar qualquer
    // ancestral, para uma entrada recusada nao deixar pasta vazia para tras.
    const chain = [];
    for (let index = 0; index < parts.length - 1; index += 1) chain.push(parts.slice(0, index + 1).join('/'));
    if (chain.some((id) => nodes.get(id)?.kind === 'doc')) { rejected += 1; return; }
    // Garante cada ancestral, da raiz para baixo.
    let cursor = ROOT_ID;
    chain.forEach((id, index) => {
      if (!nodes.has(id)) {
        nodes.set(id, makeDir(id, cursor, index + 1, rootName));
        nodes.get(cursor).dirs.push(id);
      }
      cursor = id;
    });
    const name = parts[parts.length - 1];
    nodes.set(relative, {
      id: relative, kind: 'doc', name, parent: cursor, depth: parts.length,
      size: Number(entry.size) || 0, modifiedMs: entry.modifiedMs ?? null,
      symlink: Boolean(entry.symlink), target: entry.target ?? null,
      key: foldKey(name), pathKey: foldKey(relative),
    });
    nodes.get(cursor).docs.push(relative);
  });

  // Contagem total de descendentes, de baixo para cima, e ordem estavel.
  const dirs = [...nodes.values()].filter((node) => node.kind !== 'doc');
  dirs.sort((a, b) => b.depth - a.depth);
  dirs.forEach((dir) => {
    dir.docCount += dir.docs.length;
    if (dir.parent !== null) nodes.get(dir.parent).docCount += dir.docCount;
  });
  dirs.forEach((dir) => {
    dir.dirs.sort((a, b) => compareNodes(nodes.get(a), nodes.get(b)));
    dir.docs.sort((a, b) => compareNodes(nodes.get(a), nodes.get(b)));
  });

  const docCount = nodes.get(ROOT_ID).docCount;
  const tree = {
    nodes,
    docCount,
    // Pastas contando a raiz. Sem documentos nao ha grafo, nem a raiz conta.
    dirCount: docCount ? dirs.length : 0,
    fingerprint: scan?.fingerprint || '',
    partial: Boolean(scan?.partial),
    stopped: scan?.stopped || null,
    issuesTotal: Number(scan?.issuesTotal) || 0,
    rejected,
  };
  attachIssues(tree, scan?.issues, tree.issuesTotal, tree.stopped);
  return tree;
}

// A pasta que falhou nunca e um no, porque dela nada foi lido. O aviso vai
// para o ancestral mais proximo que existe no grafo. A raiz leva o aviso
// quando a varredura parou no teto ou no prazo, ou quando ha mais ocorrencias
// do que as detalhadas.
export function attachIssues(tree, issues, issuesTotal = 0, stopped = null) {
  const byNode = new Map();
  const list = Array.isArray(issues) ? issues : [];
  list.forEach((issue) => {
    let cursor = typeof issue?.relative === 'string' && issue.relative ? issue.relative : ROOT_ID;
    while (cursor !== ROOT_ID && !(tree.nodes.has(cursor) && tree.nodes.get(cursor).kind !== 'doc')) cursor = parentId(cursor);
    const node = tree.nodes.get(cursor);
    node.partial = true;
    if (!byNode.has(cursor)) byNode.set(cursor, []);
    byNode.get(cursor).push({ relative: issue.relative || '', code: issue.code || 'io' });
  });
  if (stopped || issuesTotal > list.length) tree.nodes.get(ROOT_ID).partial = true;
  tree.issuesByNode = byNode;
  return byNode;
}

export function ancestorsOf(tree, id) {
  const result = [];
  let cursor = tree.nodes.get(id)?.parent ?? null;
  while (cursor !== null) { result.unshift(cursor); cursor = tree.nodes.get(cursor).parent; }
  return result;
}

/* ── adocao e diferenca ───────────────────────────────────────────── */

// Um indice completo nao e trocado por um que parou no teto ou no prazo: o que
// cabe dentro do prazo muda de uma varredura para outra, e um documento que
// ficou de fora pareceria removido. O anterior fica, marcado como
// desatualizado. Ocorrencias de pasta sem permissao sao deterministicas e nao
// impedem a troca.
export function shouldAdopt(previous, next) {
  if (!previous) return true;
  if (!next?.stopped) return true;
  return Boolean(previous.stopped);
}

function subtreeShape(tree, id) {
  const prefix = `${id}/`;
  const docs = [];
  tree.nodes.forEach((node) => { if (node.kind === 'doc' && node.id.startsWith(prefix)) docs.push(node.id.slice(prefix.length)); });
  return docs.sort().join('\n');
}

// Compara dois indices. `renamed` pareia o que so mudou de nome, para a
// posicao acompanhar: documento com a mesma forma dobrada, ou unico a sair e
// unico a entrar na mesma pasta, e pasta com exatamente a mesma subarvore.
export function diffIndex(previous, next) {
  const before = previous?.nodes || new Map();
  const after = next?.nodes || new Map();
  const added = { docs: [], dirs: [] };
  const removed = { docs: [], dirs: [] };
  after.forEach((node, id) => { if (!before.has(id)) added[node.kind === 'doc' ? 'docs' : 'dirs'].push(id); });
  before.forEach((node, id) => { if (!after.has(id)) removed[node.kind === 'doc' ? 'docs' : 'dirs'].push(id); });

  const renamed = [];
  const usedAdded = new Set();
  // Pastas: mesma pasta-mae e mesma subarvore de documentos.
  removed.dirs.forEach((from) => {
    const shape = subtreeShape(previous, from);
    if (!shape) return;
    const candidates = added.dirs.filter((to) => !usedAdded.has(to) && parentId(to) === parentId(from) && subtreeShape(next, to) === shape);
    if (candidates.length === 1) { usedAdded.add(candidates[0]); renamed.push({ from, to: candidates[0], kind: 'dir' }); }
  });
  const insideRenamed = (id, side) => renamed.some((pair) => pair.kind === 'dir' && id.startsWith(`${pair[side]}/`));
  // Documentos: por pasta, fora das pastas ja pareadas.
  const leftDocs = removed.docs.filter((id) => !insideRenamed(id, 'from'));
  const rightDocs = added.docs.filter((id) => !insideRenamed(id, 'to'));
  const byParent = new Map();
  leftDocs.forEach((id) => { const key = parentId(id); if (!byParent.has(key)) byParent.set(key, { out: [], into: [] }); byParent.get(key).out.push(id); });
  rightDocs.forEach((id) => { const key = parentId(id); if (!byParent.has(key)) byParent.set(key, { out: [], into: [] }); byParent.get(key).into.push(id); });
  byParent.forEach(({ out, into }) => {
    const free = new Set(into);
    out.forEach((from) => {
      const sameFold = [...free].filter((to) => foldKey(nameOf(to)) === foldKey(nameOf(from)));
      if (sameFold.length === 1) { free.delete(sameFold[0]); renamed.push({ from, to: sameFold[0], kind: 'doc' }); }
    });
    const stillOut = out.filter((from) => !renamed.some((pair) => pair.from === from));
    if (stillOut.length === 1 && free.size === 1) renamed.push({ from: stillOut[0], to: [...free][0], kind: 'doc' });
  });

  const changed = Boolean(added.docs.length || added.dirs.length || removed.docs.length || removed.dirs.length)
    || (previous?.fingerprint || '') !== (next?.fingerprint || '');
  return { changed, addedDocs: added.docs, removedDocs: removed.docs, addedDirs: added.dirs, removedDirs: removed.dirs, renamed };
}

/* ── expansao e cena ──────────────────────────────────────────────── */

// Expansao padrao previsivel: em largura, nivel a nivel, da pasta com mais
// documentos para a com menos, e so expande quem cabe no orcamento de marcas.
// A raiz sempre abre. `frozen` guarda decisoes ja tomadas, para uma pasta
// descoberta depois ser avaliada uma vez so e nao mudar de estado sozinha.
export function defaultExpansion(tree, { budget = VISIBLE_BUDGET, frozen = null } = {}) {
  const expanded = new Set();
  const decided = frozen instanceof Map ? frozen : new Map();
  const root = tree.nodes.get(ROOT_ID);
  if (!root) return { expanded, decided };
  let visible = 1;
  let level = [ROOT_ID];
  while (level.length) {
    const ordered = level.map((id) => tree.nodes.get(id)).sort((a, b) => b.docCount - a.docCount || (a.id < b.id ? -1 : 1));
    const nextLevel = [];
    ordered.forEach((dir) => {
      const cost = dir.docs.length + dir.dirs.length;
      let open;
      if (decided.has(dir.id)) open = decided.get(dir.id);
      else { open = dir.id === ROOT_ID || visible + cost <= budget; decided.set(dir.id, open); }
      if (!open) return;
      expanded.add(dir.id);
      visible += cost;
      nextLevel.push(...dir.dirs);
    });
    level = nextLevel;
  }
  return { expanded, decided };
}

// O padrao mais o que o usuario expandiu, menos o que ele recolheu. So pastas
// que existem, e a raiz sempre.
export function effectiveExpanded(tree, base, overrides = {}) {
  const result = new Set();
  const isDir = (id) => tree.nodes.has(id) && tree.nodes.get(id).kind !== 'doc';
  (base || []).forEach((id) => { if (isDir(id)) result.add(id); });
  (overrides.expanded || []).forEach((id) => { if (isDir(id)) result.add(id); });
  (overrides.collapsed || []).forEach((id) => { if (id !== ROOT_ID) result.delete(id); });
  if (tree.nodes.has(ROOT_ID)) result.add(ROOT_ID);
  return result;
}

// O que aparece: uma pasta mostra os filhos so quando ela e todos os seus
// ancestrais estao expandidos. Em pre-ordem, que e a ordem do teclado.
export function visibleScene(tree, expanded) {
  const dirs = [];
  const docs = [];
  const links = [];
  const order = [];
  const walk = (id) => {
    const dir = tree.nodes.get(id);
    dirs.push(id);
    order.push(id);
    if (!expanded.has(id)) return;
    dir.dirs.forEach((child) => { links.push({ source: id, target: child }); walk(child); });
    dir.docs.forEach((child) => { docs.push(child); order.push(child); });
  };
  if (tree.nodes.has(ROOT_ID) && tree.docCount) walk(ROOT_ID);
  return { dirs, docs, links, order, hiddenDocs: tree.docCount - docs.length };
}

// Expande tudo o que leva ate `id`. Devolve o conjunto novo e as pastas que
// precisaram abrir.
export function revealSet(tree, expanded, id) {
  const result = new Set(expanded);
  const opened = [];
  ancestorsOf(tree, id).forEach((ancestor) => { if (!result.has(ancestor)) { result.add(ancestor); opened.push(ancestor); } });
  return { expanded: result, opened };
}

// Pastas que o grafo observa: a raiz e as que estao a vista, das mais rasas e
// mais documentadas para as demais, ate o teto. Cada uma custa um descritor.
export function pickWatchDirs(tree, expanded, cap = 32) {
  const scene = visibleScene(tree, expanded);
  if (!scene.dirs.length) return tree.nodes.has(ROOT_ID) ? [ROOT_ID] : [];
  return scene.dirs
    .map((id) => tree.nodes.get(id))
    .sort((a, b) => a.depth - b.depth || b.docCount - a.docCount || (a.id < b.id ? -1 : 1))
    .slice(0, cap)
    .map((node) => node.id);
}

/* ── grupos de cor ────────────────────────────────────────────────── */

// Desce enquanto a pasta tiver uma unica subpasta documentada: o grupo de
// verdade comeca onde a documentacao se divide.
function splitPoint(tree, id) {
  let cursor = tree.nodes.get(id);
  while (cursor.dirs.length === 1) cursor = tree.nodes.get(cursor.dirs[0]);
  return cursor;
}

function related(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// Grupos de cor com corte adaptativo. Comeca nas pastas de primeiro nivel e,
// enquanto o maior grupo passar da metade dos documentos e puder ser dividido,
// troca o grupo pelas subpastas dele. A cor segue a entidade: um tom gravado
// nunca muda enquanto a pasta existir; so vaga livre e preenchida, pelo maior
// grupo sem tom que nao seja parente de um grupo ja colorido.
export function computeColorGroups(tree, saved = {}, { tones = GROUP_TONES, threshold = 0.5, regroup = false } = {}) {
  const root = tree.nodes.get(ROOT_ID);
  if (!root || !tree.docCount) return { tones: {}, groups: [], changed: Object.keys(saved || {}).length > 0 };
  let groups = [...root.dirs];
  for (let guard = 0; guard < 64; guard += 1) {
    const largest = groups.map((id) => tree.nodes.get(id)).sort((a, b) => b.docCount - a.docCount || (a.id < b.id ? -1 : 1))[0];
    if (!largest || largest.docCount <= tree.docCount * threshold) break;
    const point = splitPoint(tree, largest.id);
    if (point.dirs.length < 2) break;
    groups = groups.filter((id) => id !== largest.id).concat(point.dirs);
  }
  const ranked = groups.map((id) => tree.nodes.get(id)).sort((a, b) => b.docCount - a.docCount || (a.id < b.id ? -1 : 1));

  const assigned = {};
  if (!regroup) {
    Object.entries(saved || {}).forEach(([id, tone]) => {
      const node = tree.nodes.get(id);
      if (node && node.kind !== 'doc' && tones.includes(tone) && !Object.values(assigned).includes(tone)) assigned[id] = tone;
    });
  }
  const free = tones.filter((tone) => !Object.values(assigned).includes(tone));
  ranked.forEach((node) => {
    if (!free.length || assigned[node.id]) return;
    if (Object.keys(assigned).some((id) => related(id, node.id))) return;
    assigned[node.id] = free.shift();
  });

  const before = JSON.stringify(Object.entries(saved || {}).sort());
  const after = JSON.stringify(Object.entries(assigned).sort());
  const toned = Object.keys(assigned).map((id) => ({ id, tone: assigned[id], docCount: tree.nodes.get(id).docCount }))
    .sort((a, b) => tones.indexOf(a.tone) - tones.indexOf(b.tone));
  const tonedDocs = toned.reduce((sum, group) => sum + group.docCount, 0);
  return { tones: assigned, groups: toned, otherDocs: tree.docCount - tonedDocs, changed: before !== after };
}

// O grupo de um no e a pasta colorida mais proxima acima dele, ou ele mesmo.
export function groupOf(tree, id, tones) {
  let cursor = id;
  while (cursor !== null && cursor !== undefined) {
    if (tones[cursor]) return cursor;
    cursor = tree.nodes.get(cursor)?.parent ?? null;
  }
  return null;
}

/* ── raizes amplas ────────────────────────────────────────────────── */

// Raizes que nao sao um projeto: varrer sozinho a pasta do usuario ou um
// volume inteiro dispara avisos de privacidade do macOS e bate nos limites.
// Acompanhar o diretorio do shell pode levar a raiz para `~` com um `cd`.
export function isBroadRoot(root) {
  const path = String(root || '').replace(/\/+$/, '');
  if (path === '') return true;
  return /^\/(Users|Volumes|System|Library|Applications|private|tmp|var|opt|usr)$/.test(path)
    || /^\/Users\/[^/]+$/.test(path)
    || /^\/Volumes\/[^/]+$/.test(path)
    || /^\/Users\/[^/]+\/Library$/.test(path);
}
