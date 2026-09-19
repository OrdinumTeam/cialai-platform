// SPDX-License-Identifier: Apache-2.0
// Prévia renderizada de um Markdown, ao lado do grafo e dentro da mesma aba.
//
// `Abrir no editor` continua abrindo o arquivo para editar, numa aba própria.
// `Visualizar` abre este painel, que é de leitura: o documento entra
// renderizado, sem editor por trás, e o grafo continua à vista na outra
// metade. Um painel por sessão; escolher outro documento troca o conteúdo
// aqui em vez de empilhar painéis.
//
// O arquivo é lido do disco a cada abertura e relido quando o observador do
// runtime avisa que ele mudou. Arquivo apagado ou ilegível vira estado
// visível, nunca uma prévia em branco.

import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, FileText, PanelRightClose, Pencil, RefreshCw } from 'lucide-react';
import { renderMarkdown } from '../editor.js';
import { baseName, fs, shortPath } from '../files.js';
import { subscribeChanges, unwatchPathAs, watchPathAs } from '../runtime.js';
import { openExternal } from '../../lib/downloads.js';
import { STRINGS, previewOf } from '../docgraph/copy.js';

// Links da prévia: só http e https abrem, no navegador padrão. É a mesma
// regra da prévia do editor.
function onPreviewClick(event) {
  const anchor = event.target.closest('a');
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute('href') || '';
  if (/^https?:\/\//i.test(href)) openExternal(href).catch(() => {});
}

export default function DocGraphPreview({ sessionId, path, onOpenInEditor, onDetach, onClose, detachable = false }) {
  const [state, setState] = useState({ status: 'loading', html: '', error: '' });

  const load = useCallback(() => {
    if (!path) return undefined;
    let alive = true;
    setState((current) => (current.status === 'ready' ? current : { status: 'loading', html: '', error: '' }));
    fs.readText(path)
      .then((file) => { if (alive) setState({ status: 'ready', html: renderMarkdown(file?.content ?? ''), error: '' }); })
      .catch((error) => { if (alive) setState({ status: 'error', html: '', error: error?.message || String(error) }); });
    return () => { alive = false; };
  }, [path]);

  useEffect(() => {
    setState({ status: 'loading', html: '', error: '' });
    return load();
  }, [load]);

  // O documento pode mudar enquanto está aberto: o mesmo observador que o
  // editor usa avisa, e a prévia relê. O dono é a prévia, então fechar o
  // painel solta o observador sem tocar no que o grafo observa.
  useEffect(() => {
    if (!path) return undefined;
    const owner = `docpreview:${sessionId}`;
    watchPathAs(owner, path);
    const off = subscribeChanges((event) => {
      if (event.dir || event.path !== path) return;
      if (event.kind === 'removed') { setState({ status: 'missing', html: '', error: '' }); return; }
      load();
    });
    return () => { off(); unwatchPathAs(owner, path); };
  }, [load, path, sessionId]);

  const name = baseName(path) || path;
  return (
    <section className="terminais-docpreview" aria-label={previewOf(name)}>
      <header className="terminais-docpreview__bar">
        <FileText size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className="terminais-docpreview__name" title={shortPath(path)}>{name}</span>
        <span className="terminais-pane__spacer" />
        <button type="button" className="terminais-pane__tool" onClick={load} aria-label={STRINGS.previewReload} title={STRINGS.previewReload}>
          <RefreshCw size={13} strokeWidth={1.75} />
        </button>
        <button type="button" className="terminais-pane__tool" onClick={onOpenInEditor} aria-label={STRINGS.openInEditor} title={STRINGS.openInEditor}>
          <Pencil size={13} strokeWidth={1.75} />
        </button>
        {detachable ? (
          <button type="button" className="terminais-pane__tool" onClick={onDetach} aria-label={STRINGS.previewDetach} title={STRINGS.previewDetachTitle}>
            <ExternalLink size={13} strokeWidth={1.75} />
          </button>
        ) : null}
        <button type="button" className="terminais-pane__tool" onClick={onClose} aria-label={STRINGS.previewClose} title={STRINGS.previewCloseTitle}>
          <PanelRightClose size={14} strokeWidth={1.75} />
        </button>
      </header>
      <div className="terminais-docpreview__body">
        {state.status === 'loading' ? <p className="terminais-docpreview__state" role="status">{STRINGS.previewLoading}</p> : null}
        {state.status === 'missing' ? <p className="terminais-docpreview__state" role="status">{STRINGS.previewMissing}</p> : null}
        {state.status === 'error' ? (
          <p className="terminais-docpreview__state is-bad" role="alert">
            <span>{STRINGS.previewFailed}</span>
            <span className="terminais-docpreview__detail">{state.error}</span>
          </p>
        ) : null}
        {state.status === 'ready' ? (
          // O HTML vem do marked com a marcação crua do arquivo escapada; só
          // o que o próprio marked gera entra aqui, igual à prévia do editor.
          <div className="terminais-md" onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: state.html }} />
        ) : null}
      </div>
    </section>
  );
}
