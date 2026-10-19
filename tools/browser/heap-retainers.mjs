// SPDX-License-Identifier: Apache-2.0
// Optional local diagnostic for fixture objects. Heap stays in memory.
export async function heapRetainers(cdp, expression) {
  const evaluated = await cdp.send('Runtime.evaluate', { expression });
  if (!evaluated.result.objectId) return [];
  const chunks = [];
  const collect = ({ chunk }) => chunks.push(chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', collect);
  await cdp.send('HeapProfiler.takeHeapSnapshot');
  cdp.off('HeapProfiler.addHeapSnapshotChunk', collect);
  const { heapSnapshotObjectId } = await cdp.send('HeapProfiler.getHeapObjectId', { objectId: evaluated.result.objectId });
  const heap = JSON.parse(chunks.join(''));
  const { nodes, edges, strings } = heap;
  const nf = heap.snapshot.meta.node_fields;
  const ef = heap.snapshot.meta.edge_fields;
  const width = nf.length, ew = ef.length;
  const name = nf.indexOf('name'), id = nf.indexOf('id'), edgeCount = nf.indexOf('edge_count');
  const edgeType = ef.indexOf('type'), edgeName = ef.indexOf('name_or_index'), edgeTo = ef.indexOf('to_node');
  const types = heap.snapshot.meta.edge_types[edgeType];
  const target = nodes.findIndex((value, i) => i % width === id && String(value) === heapSnapshotObjectId) - id;
  const parents = new Map();
  let ei = 0;
  for (let ni = 0; ni < nodes.length; ni += width) {
    const end = ei + nodes[ni + edgeCount] * ew;
    for (; ei < end; ei += ew) {
      const kind = types[edges[ei + edgeType]];
      if (kind === 'weak') continue;
      const to = edges[ei + edgeTo];
      const label = ['element', 'hidden'].includes(kind) ? String(edges[ei + edgeName]) : strings[edges[ei + edgeName]];
      if (!parents.has(to)) parents.set(to, []);
      parents.get(to).push([ni, label]);
    }
  }
  const queue = [[target, []]], seen = new Set([target]);
  for (let at = 0; at < queue.length && at < 500000; at++) {
    const [node, path] = queue[at];
    if (node === 0) return path.reverse();
    for (const [parent, label] of parents.get(node) || []) {
      if (seen.has(parent) || strings[nodes[parent + name]] === '(Global handles)') continue;
      seen.add(parent);
      queue.push([parent, [...path, `${strings[nodes[parent + name]]}.${label} -> ${strings[nodes[node + name]]}`]]);
    }
  }
  return ['no non-inspector strong path found'];
}
