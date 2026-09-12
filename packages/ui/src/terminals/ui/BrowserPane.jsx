// SPDX-License-Identifier: Apache-2.0
// Painel do Dev Browser da sessao: barra com historico, recarregar e
// endereco, o canvas do screencast e as sobreposicoes de abrindo, parado e
// erro. O estado vive no runtime do browser; aqui so se desenha e se manda
// a intencao do usuario.
//
// Memoizado e assinando so os eventos `browser` da propria sessao: a saida
// do terminal e as metricas nao redesenham o canvas.

import React, { memo, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Copy, Globe, Power, RotateCcw, X } from 'lucide-react';
import { useRuntimeEvents } from '../hooks.js';
import {
  attachCanvas, copyPort, detachCanvas, goBack, goForward, navigate, recoverTab, reload, startBrowser, stopBrowser, stopLoading,
} from '../browser/runtime.js';

function Overlay({ browser, sessionId }) {
  if (browser.status === 'ready' && !browser.error) return null;
  if (browser.status === 'starting') {
    // Primeira abertura numa máquina sem Chromium: o Rust baixa o do
    // Playwright e manda o andamento, que entra em `browser.install`.
    const installing = typeof browser.install === 'string';
    return (
      <div className="terminais-browser__overlay" role="status">
        <Globe size={22} strokeWidth={1.5} aria-hidden="true" />
        <strong>{installing ? 'Instalando o Chromium' : 'Abrindo o Chromium'}</strong>
        <span>
          {installing
            ? (browser.install || 'Esta máquina ainda não tem Chromium. O painel está baixando o do Playwright, só desta vez.')
            : 'Um browser só desta sessão, com perfil e porta próprios.'}
        </span>
      </div>
    );
  }
  if (browser.status === 'ready' && browser.error) {
    return (
      <div className="terminais-browser__overlay" role="alert">
        <strong>{browser.error}</strong>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => recoverTab(sessionId)}><RotateCcw size={12} />Recarregar aba</button>
      </div>
    );
  }
  const failed = browser.status === 'error' || browser.status === 'stopped';
  return (
    <div className="terminais-browser__overlay" role={failed ? 'alert' : 'status'}>
      <Globe size={22} strokeWidth={1.5} aria-hidden="true" />
      <strong>{failed ? (browser.error || 'Browser encerrado') : 'Dev Browser desta sessão'}</strong>
      <span>{browser.url ? browser.url : 'Um Chromium controlável pelos agentes deste terminal, pela porta publicada na pasta.'}</span>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => startBrowser(sessionId)}>
        <Globe size={12} />{failed ? 'Reabrir browser' : 'Abrir browser'}
      </button>
    </div>
  );
}

function BrowserPane({ session }) {
  useRuntimeEvents(['browser'], session.id);
  const browser = session.browser;
  const canvasRef = useRef(null);
  const urlRef = useRef(null);
  const [draft, setDraft] = useState(browser.url || '');
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    attachCanvas(session.id, canvas, { focusUrl: () => { urlRef.current?.focus(); urlRef.current?.select(); } });
    if (browser.status === 'idle' && browser.autoStart) startBrowser(session.id).catch(() => {});
    if (browser.status === 'ready') setTimeout(() => canvas?.focus(), 30);
    return () => { detachCanvas(session.id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  useEffect(() => {
    if (!editing) setDraft(browser.url || '');
  }, [browser.url, editing]);

  useEffect(() => {
    if (browser.status === 'ready' && !browser.url && !editing) {
      // Aba em branco: o cursor vai para o endereco, como no Chrome.
      urlRef.current?.focus();
    }
  }, [browser.status, browser.url, editing]);

  const ready = browser.status === 'ready';
  const info = browser.info;
  const submit = (event) => {
    event.preventDefault();
    setEditing(false);
    navigate(session.id, draft).catch(() => {});
    setTimeout(() => canvasRef.current?.focus(), 30);
  };

  return (
    <div className="terminais-browser">
      <div className="terminais-browser__bar">
        <button type="button" className="terminais-pane__tool" onClick={() => goBack(session.id)} disabled={!ready || !browser.canGoBack} aria-label="Voltar" title="Voltar, ⌘["><ArrowLeft size={14} strokeWidth={1.75} /></button>
        <button type="button" className="terminais-pane__tool" onClick={() => goForward(session.id)} disabled={!ready || !browser.canGoForward} aria-label="Avançar" title="Avançar, ⌘]"><ArrowRight size={14} strokeWidth={1.75} /></button>
        <button
          type="button"
          className="terminais-pane__tool"
          onClick={() => (browser.loading ? stopLoading(session.id) : reload(session.id))}
          disabled={!ready}
          aria-label={browser.loading ? 'Parar' : 'Recarregar'}
          title={browser.loading ? 'Parar, Esc' : 'Recarregar, ⌘R'}
        >
          {browser.loading ? <X size={14} strokeWidth={1.75} /> : <RotateCcw size={14} strokeWidth={1.75} />}
        </button>
        <form className="terminais-browser__url" onSubmit={submit}>
          <input
            ref={urlRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => { setEditing(true); event.target.select(); }}
            onBlur={() => setEditing(false)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') { event.preventDefault(); setDraft(browser.url || ''); canvasRef.current?.focus(); }
            }}
            placeholder="Endereço ou busca"
            aria-label="Endereço"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        </form>
        {info ? (
          <button
            type="button"
            className={`terminais-browser__port${info.portOwner === 'other' ? ' is-other' : ''}`}
            onClick={() => copyPort(session.id)}
            title={info.portOwner === 'other'
              ? `Porta ${info.port} deste browser. O arquivo de porta da pasta é de outra sessão${info.portOwnerSession ? `, ${info.portOwnerSession}` : ''}. Clique para copiar.`
              : `Porta ${info.port}, publicada em .dev-browser-panel/port na pasta da sessão. Clique para copiar.`}
          >
            <span>Porta</span>
            <strong>{info.port}</strong>
            <Copy size={11} strokeWidth={2} aria-hidden="true" />
          </button>
        ) : null}
        <button type="button" className="terminais-pane__tool" onClick={() => stopBrowser(session.id)} disabled={!ready && browser.status !== 'starting'} aria-label="Encerrar browser" title="Encerrar o browser desta sessão"><Power size={14} strokeWidth={1.75} /></button>
      </div>
      <div className={`terminais-browser__progress${browser.loading ? ' is-loading' : ''}`} aria-hidden="true" />
      <div className="terminais-browser__view">
        <canvas ref={canvasRef} className="terminais-browser__canvas" tabIndex={0} aria-label={browser.title ? `Página ${browser.title}` : 'Página do browser'} />
        <Overlay browser={browser} sessionId={session.id} />
      </div>
    </div>
  );
}

export default memo(BrowserPane);
