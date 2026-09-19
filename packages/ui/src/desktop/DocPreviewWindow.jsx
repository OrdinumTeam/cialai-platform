// SPDX-License-Identifier: Apache-2.0
// Janela separada com a prévia de um Markdown. É a mesma página do estúdio,
// aberta com `?docpreview=1` numa janela própria pelo comando
// `doc_preview_window`; o caminho não vai na URL, vem do Rust.
//
// Uma janela só, reaproveitada: pedir outro documento troca o conteúdo aqui e
// traz a janela para a frente. A divisão interna do grafo é fechada por quem
// pede, e `Visualizar` de novo no grafo traz a divisão de volta.

import React, { useCallback, useEffect, useState } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { FileText, RefreshCw } from 'lucide-react';
import { invoke, listen } from '../lib/native.js';
import { openExternal } from '../lib/downloads.js';
import { renderMarkdown } from '../terminals/editor.js';
import { baseName, fs, shortPath } from '../terminals/files.js';
import { STRINGS } from '../terminals/docgraph/copy.js';
import { AppearanceContext, useAppearance } from './appearance.js';
import { buildMacTheme } from './theme.macos.js';
import { useI18n } from './i18n.js';

function onPreviewClick(event) {
  const anchor = event.target.closest('a');
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute('href') || '';
  if (/^https?:\/\//i.test(href)) openExternal(href).catch(() => {});
}

function Body() {
  useI18n();
  const [path, setPath] = useState(null);
  const [state, setState] = useState({ status: 'loading', html: '', error: '' });

  useEffect(() => {
    let alive = true;
    invoke('doc_preview_path').then((value) => { if (alive) setPath(value || null); }).catch(() => {});
    const off = listen('docpreview://path', (next) => { if (alive && typeof next === 'string') setPath(next); });
    return () => { alive = false; off.then((stop) => stop?.()).catch(() => {}); };
  }, []);

  const load = useCallback(() => {
    if (!path) return undefined;
    let alive = true;
    fs.readText(path)
      .then((file) => { if (alive) setState({ status: 'ready', html: renderMarkdown(file?.content ?? ''), error: '' }); })
      .catch((error) => { if (alive) setState({ status: 'error', html: '', error: error?.message || String(error) }); });
    return () => { alive = false; };
  }, [path]);

  useEffect(() => {
    if (!path) return undefined;
    setState({ status: 'loading', html: '', error: '' });
    document.title = baseName(path) || 'Cialai';
    return load();
  }, [load, path]);

  // O documento muda no disco enquanto a janela está aberta: o observador do
  // núcleo avisa e a prévia relê. A janela solta o observador ao trocar de
  // documento e ao fechar.
  useEffect(() => {
    if (!path) return undefined;
    let watchId = null;
    let alive = true;
    fs.watch(path).then((id) => { if (alive) watchId = id; else fs.unwatch(id).catch(() => {}); }).catch(() => {});
    const off = listen('fs://change', (payload) => {
      if (!payload || payload.dir || payload.path !== path) return;
      if (payload.kind === 'removed') { setState({ status: 'missing', html: '', error: '' }); return; }
      load();
    });
    return () => {
      alive = false;
      off.then((stop) => stop?.()).catch(() => {});
      if (watchId != null) fs.unwatch(watchId).catch(() => {});
    };
  }, [load, path]);

  const name = path ? baseName(path) || path : '';
  return (
    <div className="docpreview-window">
      <header className="docpreview-window__bar" data-tauri-drag-region="deep">
        <FileText size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className="docpreview-window__name" title={path ? shortPath(path) : undefined}>{name}</span>
        <span className="terminais-pane__spacer" />
        <button type="button" className="terminais-pane__tool" onClick={load} aria-label={STRINGS.previewReload} title={STRINGS.previewReload}>
          <RefreshCw size={13} strokeWidth={1.75} />
        </button>
      </header>
      <div className="docpreview-window__body">
        {state.status === 'loading' ? <p className="terminais-docpreview__state" role="status">{STRINGS.previewLoading}</p> : null}
        {state.status === 'missing' ? <p className="terminais-docpreview__state" role="status">{STRINGS.previewMissing}</p> : null}
        {state.status === 'error' ? (
          <p className="terminais-docpreview__state is-bad" role="alert">
            <span>{STRINGS.previewFailed}</span>
            <span className="terminais-docpreview__detail">{state.error}</span>
          </p>
        ) : null}
        {state.status === 'ready' ? (
          // O HTML vem do marked com a marcação crua do arquivo escapada.
          <div className="terminais-md" onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: state.html }} />
        ) : null}
      </div>
    </div>
  );
}

export default function DocPreviewWindow() {
  const appearance = useAppearance();
  const theme = React.useMemo(() => buildMacTheme(appearance.resolved), [appearance.resolved]);
  return (
    <AppearanceContext.Provider value={appearance}>
      <ThemeProvider theme={theme}>
        <CssBaseline enableColorScheme />
        <Body />
      </ThemeProvider>
    </AppearanceContext.Provider>
  );
}
