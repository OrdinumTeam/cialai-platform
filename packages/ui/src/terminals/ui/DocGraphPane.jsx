// SPDX-License-Identifier: Apache-2.0
// Painel do grafo da documentacao, a aba `docgraph` da area central. Aqui so
// se desenha e se manda a intencao do usuario: o indice, as posicoes e a visao
// vivem no controlador, em escopo de modulo, porque este painel desmonta toda
// vez que outra aba e ativada ou a secao muda.
//
// O motor, com o d3-force, o renderizador e o controlador, chega por `import()`
// na primeira montagem. A camera e a do Mapa, sobre um canvas: `worldRef` fica
// vazio e `onFrame` pede o redesenho.
//
// A visao interna e montada de novo quando a raiz do projeto muda. O painel
// assina a raiz por conta propria porque `changeDirectory` escreve a raiz sem
// emitir o evento `editor`, que e o unico que o `EditorPane` memoizado ouve.

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronsDownUp, ChevronsUpDown, LocateFixed, Minus, Palette, Plus, RefreshCw, Scan } from 'lucide-react';
import { useCamera } from '../docgraph/camera.js';
import { useToast } from '../../components/ui.jsx';
import { copyToClipboard } from '../../lib/helpers.js';
import { STRINGS, countsAnnouncement, issuesCount } from '../docgraph/copy.js';
import { baseName, fs, joinPath, nativeAvailable } from '../files.js';
import { useRuntimeEvents, useRuntimeValue } from '../hooks.js';
import { motionOff } from '../motion.js';
import { changeDirectory, isDemo } from '../runtime.js';
import { isDarkTheme, watchTheme } from '../theme.js';
import Menu from './Menu.jsx';
import { DetailCard, GraphState, HoverTip, IssuesPopover, Legend, SearchBox, TreeMirror, countsLabel } from './DocGraphOverlays.jsx';

const WORLD = { w: 1, h: 1 };
const SCALE_RANGE = [0.03, 3.2];

let enginePromise = null;
function loadEngine() {
  if (!enginePromise) enginePromise = import('../docgraph/engine.js').catch((error) => { enginePromise = null; throw error; });
  return enginePromise;
}

function DocGraphView({ engine, session, root, actions }) {
  const sessionId = session.id;
  const { api } = engine;
  useRuntimeEvents(['docgraph'], sessionId);
  const notify = useToast();
  const controller = api.getController(sessionId);
  const native = nativeAvailable() || isDemo();
  const rootName = baseName(root) || session.name;

  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const searchRef = useRef(null);
  const worldRef = useRef(null);
  const rendererRef = useRef(null);
  const byUser = useRef(false);
  const [hover, setHover] = useState(null);
  const [menu, setMenu] = useState(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [stat, setStat] = useState(null);
  const [dark, setDark] = useState(isDarkTheme);
  const [zoom, setZoom] = useState(100);
  const zoomTimer = useRef(0);
  const viewRef = useRef(null);
  const cameraRef = useRef(null);

  const onFrame = useCallback((view) => {
    rendererRef.current?.setView(view);
    api.setView(sessionId, view, { byUser: byUser.current });
    byUser.current = false;
    // O percentual da barra chega atrasado de proposito, mas sempre chega: a
    // camera aplica uma visao de uma vez so quando o movimento esta desligado.
    if (!zoomTimer.current) zoomTimer.current = setTimeout(() => { zoomTimer.current = 0; if (cameraRef.current) setZoom(Math.round(cameraRef.current.getView().s * 100)); }, 90);
  }, [api, sessionId]);
  const initialView = useCallback(() => api.peekController(sessionId)?.view || null, [api, sessionId]);
  const { camera } = useCamera({ containerRef: hostRef, worldRef, world: WORLD, onFrame, initialView, instant: motionOff, scaleRange: SCALE_RANGE });
  cameraRef.current = camera;

  const abs = useCallback((id) => engine.absPath(root, id), [engine, root]);

  const focusNode = useCallback((id) => {
    const renderer = rendererRef.current;
    const spot = renderer?.locate(id);
    if (!spot) return;
    const node = api.peekController(sessionId)?.tree?.nodes.get(id);
    const current = camera.getView().s;
    const s = Math.min(SCALE_RANGE[1], Math.max(current, node?.kind === 'doc' ? 1.3 : 0.6));
    camera.flyTo({ s, x: renderer.width / 2 - spot.x * s, y: renderer.height / 2 - spot.y * s }, 420);
  }, [api, camera, sessionId]);

  const open = useCallback((id) => actions.openPath(abs(id)), [actions, abs]);
  const preview = useCallback((id) => actions.previewPath(abs(id)), [actions, abs]);
  const revealInExplorer = useCallback((id) => actions.revealInExplorer(abs(id)), [actions, abs]);
  const copyPath = useCallback(async (text) => {
    const ok = await copyToClipboard(text);
    notify(ok ? STRINGS.pathCopied : STRINGS.copyFailed, ok ? 'success' : 'warning');
  }, [notify]);

  const openMenu = useCallback((id, anchor) => {
    const current = api.peekController(sessionId);
    const node = current?.tree?.nodes.get(id);
    if (!node) return;
    const isDoc = node.kind === 'doc';
    const items = [
      isDoc ? { id: 'open', label: STRINGS.openInEditor, run: () => open(id) } : null,
      isDoc ? { id: 'preview', label: STRINGS.preview, run: () => preview(id) } : null,
      !isDoc && node.kind !== 'root' ? { id: 'toggle', label: current.expanded.has(id) ? STRINGS.collapse : STRINGS.expand, run: () => api.toggle(sessionId, id) } : null,
      { id: 'reveal', label: STRINGS.revealInExplorer, run: () => revealInExplorer(id) },
      { id: 'finder', label: STRINGS.revealInFinder, run: () => fs.reveal(abs(id)).catch((error) => notify(error.message, 'warning')) },
      { separator: true },
      { id: 'copy', label: STRINGS.copyPath, run: () => copyPath(abs(id)) },
      node.kind !== 'root' ? { id: 'copy-rel', label: STRINGS.copyRelativePath, run: () => copyPath(id) } : null,
    ];
    setMenu({ anchor, items });
  }, [abs, api, copyPath, notify, open, preview, revealInExplorer, sessionId]);

  // Ajustar devolve o enquadramento automatico: a area volta a mandar.
  const fit = useCallback(() => { const current = api.peekController(sessionId); if (current) current.autoFit = true; api.fitToArea(sessionId, { animate: true }); }, [api, sessionId]);
  const center = useCallback(() => {
    const current = api.peekController(sessionId);
    focusNode(current?.selected || engine.ROOT_ID);
  }, [api, engine, focusNode, sessionId]);

  // Anexa o renderizador, o controlador e a interacao, e solta tudo na saida.
  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return undefined;
    const renderer = new engine.DocGraphRenderer({ stats: engine.track });
    rendererRef.current = renderer;
    renderer.theme = engine.readGraphTheme();
    renderer.view = { ...camera.getView() };
    renderer.attach(canvas, host, {
      onResize: () => { const current = api.peekController(sessionId); if (current?.needsFit || current?.autoFit) api.fitToArea(sessionId, { animate: false }); },
    });
    const attached = api.attach(sessionId, {
      onScene: (scene) => renderer.setScene(scene),
      onFrame: () => renderer.requestDraw(),
      applyView: (view, { animate }) => { if (animate) camera.flyTo(view, 420); else camera.setView(view); },
      focusNode,
      getSize: () => ({ width: renderer.width, height: renderer.height }),
    });
    renderer.setScene(attached.scene);
    if (attached.needsFit) api.fitToArea(sessionId, { animate: false });
    const unbind = engine.bindInteraction(host, {
      camera,
      renderer,
      controller: attached,
      api,
      actions: {
        byUser: () => { byUser.current = true; },
        onHover: setHover,
        open,
        preview,
        menu: openMenu,
        fit,
        center,
        focusSearch: () => searchRef.current?.focus(),
        escape: () => {
          const current = api.peekController(sessionId);
          if (current?.query) api.setQuery(sessionId, ''); else api.select(sessionId, null);
        },
      },
    });
    engine.track.on('observer');
    const offTheme = watchTheme(() => { setDark(isDarkTheme()); renderer.setTheme(engine.readGraphTheme()); });
    return () => {
      offTheme();
      engine.track.off('observer');
      if (zoomTimer.current) { clearTimeout(zoomTimer.current); zoomTimer.current = 0; }
      unbind();
      api.detach(sessionId);
      renderer.detach();
      rendererRef.current = null;
    };
    // A visao e remontada por `key` quando a raiz muda; as acoes sao estaveis.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, sessionId]);

  // Selecao, busca e foco do teclado chegam ao canvas por aqui.
  useEffect(() => {
    rendererRef.current?.setState({
      selected: controller.selected,
      matches: controller.matches,
      keyboard: controller.keyboard,
      path: api.pathToRoot(sessionId, controller.selected),
    });
  }, [api, controller, controller.revision, sessionId]);

  // O cartao, a legenda e a contagem cobrem parte do canvas: os rotulos de
  // baixo deles nao sao desenhados.
  useEffect(() => {
    const view = viewRef.current;
    const renderer = rendererRef.current;
    if (!view || !renderer) return;
    const origin = view.getBoundingClientRect();
    const rects = [...view.querySelectorAll('.terminais-docgraph__card, .terminais-docgraph__legend, .terminais-docgraph__counts')].map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left - origin.left, y: rect.top - origin.top, w: rect.width, h: rect.height };
    }).filter((rect) => rect.w > 0 && rect.h > 0);
    renderer.setOccluded(rects);
  });

  // Tamanho e data do documento selecionado, lidos na hora: o indice guarda
  // so o que a varredura viu.
  const selected = controller.selected ? controller.tree?.nodes.get(controller.selected) || null : null;
  useEffect(() => {
    setStat(null);
    if (!selected || selected.kind !== 'doc') return undefined;
    let alive = true;
    fs.stat(abs(selected.id)).then((value) => { if (alive && value?.exists) setStat(value); }).catch(() => {});
    return () => { alive = false; };
  }, [abs, selected]);

  const createReadme = useCallback(async () => {
    const path = joinPath(root, 'README.md');
    try { await fs.createFile(path); } catch (error) { if (error?.code !== 'exists') { notify(error?.message || String(error), 'warning'); return; } }
    actions.openPath(path);
    api.refresh(sessionId);
  }, [actions, api, notify, root, sessionId]);

  const ready = controller.status === 'ready';
  const meta = controller.meta;

  // Capturas em modo demo: `docgraph_sel` seleciona um no e `docgraph_q`
  // preenche a busca, para a tela ja nascer no estado que se quer ver.
  const demoApplied = useRef(false);
  useEffect(() => {
    if (!ready || demoApplied.current || !isDemo()) return;
    demoApplied.current = true;
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get('docgraph_sel');
    const query = params.get('docgraph_q');
    if (query) api.setQuery(sessionId, query);
    if (wanted) api.reveal(sessionId, wanted);
  }, [api, ready, sessionId]);
  const idFor = useCallback((id) => `docgraph-${sessionId}-${encodeURIComponent(id)}`, [sessionId]);
  const announcement = useMemo(() => {
    if (!ready || !controller.tree) return '';
    const base = countsAnnouncement(controller.tree.docCount, controller.tree.dirCount);
    return meta?.partial ? `${base}. ${STRINGS.partialTitle}` : base;
  }, [ready, controller.tree, meta]);

  return (
    <div className="terminais-docgraph">
      <div className="terminais-docgraph__bar">
        <SearchBox
          controller={controller}
          search={engine.searchDocs}
          inputRef={searchRef}
          onQuery={(query) => api.setQuery(sessionId, query)}
          onPick={(id) => { api.reveal(sessionId, id); hostRef.current?.focus({ preventScroll: true }); }}
          onLeave={() => hostRef.current?.focus({ preventScroll: true })}
        />
        {controller.refreshing ? <span className="terminais-docgraph__chip">{STRINGS.refreshing}</span> : null}
        {controller.stale ? <span className="terminais-docgraph__chip terminais-docgraph__chip--warn">{STRINGS.stale}</span> : null}
        {ready && meta?.partial ? (
          <span className="terminais-docgraph__anchor">
            <button type="button" className="terminais-docgraph__chip terminais-docgraph__chip--warn" onClick={() => setIssuesOpen((value) => !value)} aria-expanded={issuesOpen} aria-haspopup="dialog">
              <AlertTriangle size={11} strokeWidth={2} aria-hidden="true" />
              {meta.stopped ? STRINGS.partialTitle : issuesCount(meta.issuesTotal)}
            </button>
            {issuesOpen ? <IssuesPopover meta={meta} onClose={() => setIssuesOpen(false)} /> : null}
          </span>
        ) : null}
        <span className="terminais-pane__spacer" />
        <button type="button" className="terminais-pane__tool" onClick={() => { byUser.current = true; camera.zoomBy(1 / 1.35); }} disabled={!ready} aria-label={STRINGS.zoomOut} title={`${STRINGS.zoomOut}, −`}><Minus size={14} strokeWidth={1.75} /></button>
        <span className="terminais-docgraph__zoom" aria-live="off">{zoom}%</span>
        <button type="button" className="terminais-pane__tool" onClick={() => { byUser.current = true; camera.zoomBy(1.35); }} disabled={!ready} aria-label={STRINGS.zoomIn} title={`${STRINGS.zoomIn}, +`}><Plus size={14} strokeWidth={1.75} /></button>
        <button type="button" className="terminais-pane__tool" onClick={fit} disabled={!ready} aria-label={STRINGS.fit} title={STRINGS.fitTitle}><Scan size={14} strokeWidth={1.75} /></button>
        <button type="button" className="terminais-pane__tool" onClick={center} disabled={!ready} aria-label={STRINGS.center} title={STRINGS.centerTitle}><LocateFixed size={14} strokeWidth={1.75} /></button>
        <span className="terminais-work__sep" aria-hidden="true" />
        <button type="button" className="terminais-pane__tool" onClick={() => api.expandAll(sessionId)} disabled={!ready} aria-label={STRINGS.expandAll} title={STRINGS.expandAll}><ChevronsUpDown size={13} strokeWidth={1.75} /></button>
        <button type="button" className="terminais-pane__tool" onClick={() => api.collapseAll(sessionId)} disabled={!ready} aria-label={STRINGS.collapseAll} title={STRINGS.collapseAll}><ChevronsDownUp size={13} strokeWidth={1.75} /></button>
        <button type="button" className="terminais-pane__tool" onClick={() => api.regroupColors(sessionId)} disabled={!ready || !controller.groups.length} aria-label={STRINGS.regroup} title={STRINGS.regroup}><Palette size={13} strokeWidth={1.75} /></button>
        <button type="button" className="terminais-pane__tool" onClick={() => api.refresh(sessionId)} disabled={controller.status === 'broad' || !native} aria-label={STRINGS.refresh} title={STRINGS.refreshTitle}><RefreshCw size={13} strokeWidth={1.75} /></button>
      </div>
      <div className={`terminais-docgraph__progress${controller.refreshing ? ' is-loading' : ''}`} aria-hidden="true" />
      <div className="terminais-docgraph__view" ref={viewRef}>
        <div
          ref={hostRef}
          className="terminais-docgraph__host"
          tabIndex={0}
          role="tree"
          aria-label={STRINGS.treeLabel}
          aria-activedescendant={ready && controller.selected ? idFor(controller.selected) : undefined}
        >
          <canvas ref={canvasRef} className="terminais-docgraph__canvas" aria-hidden="true" />
          {ready ? <TreeMirror controller={controller} rootName={rootName} idFor={idFor} /> : null}
        </div>
        <div className="sr-only" aria-live="polite">{announcement}</div>
        {ready ? <div className="terminais-docgraph__counts" title={root}>{countsLabel(controller)}</div> : null}
        {ready ? <Legend controller={controller} dark={dark} onFocus={(id) => api.reveal(sessionId, id)} /> : null}
        {ready ? (
          <DetailCard
            controller={controller}
            node={selected}
            stat={stat}
            rootName={rootName}
            onOpen={() => open(selected.id)}
            onPreview={() => preview(selected.id)}
            onReveal={() => revealInExplorer(selected.id)}
            onToggle={() => api.toggle(sessionId, selected.id)}
            onClose={() => api.select(sessionId, null)}
          />
        ) : null}
        {ready && !menu ? <HoverTip hover={hover} controller={controller} rootName={rootName} /> : null}
        {!ready ? (
          <GraphState
            controller={controller}
            native={native}
            onRetry={() => api.refresh(sessionId)}
            onChangeDir={() => changeDirectory(sessionId).catch((error) => notify(error.message, 'warning'))}
            onConfirmBroad={() => api.confirmBroad(sessionId)}
            onCreateReadme={createReadme}
          />
        ) : null}
      </div>
      {menu ? <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} label={STRINGS.name} /> : null}
    </div>
  );
}

function DocGraphPane({ session, actions }) {
  const [engine, setEngine] = useState(null);
  const [failed, setFailed] = useState(null);
  useEffect(() => {
    let alive = true;
    loadEngine().then((module) => { if (alive) setEngine(module); }).catch((error) => { if (alive) setFailed(error); });
    return () => { alive = false; };
  }, []);
  const readRoot = useCallback(() => session.explorer.root, [session]);
  const root = useRuntimeValue(['explorer'], session.id, readRoot);

  if (failed || !engine) {
    return (
      <div className="terminais-docgraph">
        <div className="terminais-docgraph__view">
          <div className="terminais-docgraph__overlay" role={failed ? 'alert' : 'status'}>
            <strong>{failed ? STRINGS.error : STRINGS.indexing}</strong>
            {failed ? <span>{failed.message || String(failed)}</span> : null}
          </div>
        </div>
      </div>
    );
  }
  return <DocGraphView key={root} engine={engine} session={session} root={root} actions={actions} />;
}

export default memo(DocGraphPane);
