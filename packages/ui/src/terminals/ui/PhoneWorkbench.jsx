// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { ArrowDown, ChevronLeft, ClipboardPaste, FolderOpen, Plus, Power, RotateCcw, Search } from 'lucide-react';
import { AppModal, useToast } from '../../components/ui.jsx';
import { hasBridge } from '../../lib/native.js';
import { onNavigateBack, requestNavigateBack } from '../../lib/shell.js';
import { closeSession, describe, fitAndResize, focusTerminal, getSession, getState, hostTerminal, hydrate, isDemo, openSession, orderedSessions, pasteText, releaseTerminal, reopen, requestTerminalControl, scrollToBottom, selectSession, sendKey, subscribe, supportsPhoneTerminal, terminalHasFocus, viewMounted, watchTail } from '../runtime.js';
import { phoneRoute, phoneRouteStorage, readPhoneRoute, writePhoneRoute } from '../phone-navigation.js';
import { useRuntimeEvents } from '../hooks.js';
import NewSessionPopover from './NewSessionPopover.jsx';
import SessionCard from './SessionCard.jsx';
import PhoneFiles from './PhoneFiles.jsx';
import { getLocale, translate, useI18n } from '../../shared/i18n.js';

// Teclas da fileira. Shift Tab alterna o modo do Claude Code; Ctrl D encerra
// a entrada; Ctrl L limpa a tela. Cada entrada: rotulo, sequencia e nome
// acessivel.
const ESC = String.fromCharCode(27);
const control = (letter) => String.fromCharCode(letter.charCodeAt(0) - 64);
const KEYS = [
  ['Esc', ESC, 'Esc'],
  ['Tab', '\t', 'Tab'],
  ['Shift Tab', `${ESC}[Z`, 'Shift Tab'],
  ['Ctrl C', control('C'), 'Ctrl C'],
  ['↑', `${ESC}[A`, 'terminal.phone.arrowUp'],
  ['↓', `${ESC}[B`, 'terminal.phone.arrowDown'],
  ['Enter', '\r', 'Enter'],
  ['Ctrl D', control('D'), 'Ctrl D'],
  ['Ctrl L', control('L'), 'Ctrl L'],
];

// Ler a area de transferencia exige contexto seguro e um gesto do usuario.
const canPaste = () => typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function';

function PhoneTerminal({ session, visible, onTakeControl, onPress }) {
  const host = useRef(null);
  const [tail, setTail] = useState({ detached: false, fresh: false });
  useEffect(() => watchTail(session.id, setTail), [session.id]);
  useEffect(() => {
    hostTerminal(session.id, host.current);
    const observer = new ResizeObserver(() => fitAndResize(session.id));
    observer.observe(host.current);
    const resize = () => fitAndResize(session.id);
    window.visualViewport?.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.visualViewport?.removeEventListener('resize', resize); releaseTerminal(session.id); };
  }, [session.id]);
  useEffect(() => { if (visible) fitAndResize(session.id); }, [session.id, session.status, visible]);
  return <div className="phone-terminal__scroll">
    <div className="phone-terminal__host" aria-hidden={!visible} inert={visible ? undefined : ''} ref={host} />
    {visible && tail.detached && <button type="button" className={`phone-terminal__tail${tail.fresh ? ' is-fresh' : ''}`} onPointerDown={onPress} onClick={() => { scrollToBottom(session.id); onPress(null, true); }}><ArrowDown size={15} aria-hidden="true" />{translate(tail.fresh ? 'terminal.phone.newOutput' : 'terminal.phone.backToEnd')}</button>}
    {!visible && session.status === 'running' && <div className="phone-terminal__ownership" role="status">
      <h2>{translate('terminal.phone.otherDeviceTitle')}</h2>
      <p>{translate('terminal.phone.otherDeviceDescription')}</p>
      <button type="button" className="phone-terminal__take-control" onClick={onTakeControl}>{translate('terminal.phone.takeControl')}</button>
    </div>}
  </div>;
}

export default function PhoneWorkbench() {
  useI18n();
  const notify = useToast();
  const [picker, setPicker] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closing, setClosing] = useState(false);
  const [query, setQuery] = useState('');
  const [route, navigate] = useReducer(phoneRoute, undefined, () => readPhoneRoute(phoneRouteStorage()));
  useRuntimeEvents(['sessions', 'viewport', 'theme']);
  const { hydrated } = getState();
  const sessions = orderedSessions();
  const selected = getSession(route.sessionId);
  const pane = selected ? route.pane : 'list';
  const heading = useRef(null);
  // O teclado do iPhone so abre pelo toque no terminal. Um botao da fileira
  // guarda no toque se o terminal tinha o foco e o devolve depois de enviar,
  // entao o teclado aberto continua aberto e o fechado continua fechado.
  const focused = useRef(false);
  const press = (event, restore = false) => {
    if (event) { focused.current = terminalHasFocus(selected?.id); return; }
    if (restore && focused.current && selected) focusTerminal(selected.id);
  };
  useEffect(() => { heading.current?.focus(); }, [pane]);
  useEffect(() => { writePhoneRoute(phoneRouteStorage(), route); }, [route]);
  useEffect(() => onNavigateBack(() => {
    if (pane === 'list') requestNavigateBack();
    else navigate({ type: 'back' });
  }), [pane]);
  // Rota restaurada depois de recarregar: a sessao aparece com a hidratacao.
  useEffect(() => { if (selected) selectSession(selected.id); }, [selected?.id]);
  useEffect(() => {
    hydrate().catch((error) => notify(error.message, 'warning'));
    viewMounted(true);
    const off = subscribe((event) => { if (event.type === 'error') notify(event.message, 'warning'); });
    return () => { off(); viewMounted(false); };
  }, [notify]);
  const available = hasBridge() || isDemo();
  const supported = supportsPhoneTerminal();
  const terminalVisible = isDemo() || Boolean(selected?.viewport?.owned) || ['exited', 'error'].includes(selected?.status);
  const open = (id) => { selectSession(id); navigate({ type: 'select', id }); };
  const interactive = Boolean(selected) && selected.status === 'running' && terminalVisible;
  const sendAndRestore = (data) => { sendKey(selected.id, data); press(null, true); };
  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) { notify(translate('terminal.phone.clipboardEmpty'), 'warning'); return; }
      pasteText(selected.id, text);
      press(null, true);
    } catch (_error) {
      notify(translate('terminal.phone.clipboardDenied'), 'warning');
    }
  }
  const filtered = sessions.filter(session => [session.name, session.subtitle, session.cwd].some(value => value?.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim())));
  const title = pane === 'list' ? translate('terminal.phone.terminals') : pane === 'files' ? translate('terminal.phone.files') : pane === 'preview' ? route.path.split('/').at(-1) : selected.name;
  async function endSession() {
    setClosing(true);
    try { await closeSession(selected.id); setConfirmClose(false); if (!getSession(selected.id)) navigate({ type: 'reset' }); }
    catch (error) { notify(error.message, 'warning'); }
    finally { setClosing(false); }
  }
  return <div className={`view active phone-terminal phone-terminal--${pane}`} id="view-terminais">
    <div className="phone-terminal__toolbar">
      {pane !== 'list' && <button type="button" className="mac-tool" aria-label={translate(pane === 'terminal' ? 'terminal.phone.backSessions' : pane === 'files' ? 'terminal.phone.backTerminal' : 'terminal.phone.backFiles')} onClick={() => navigate({ type: 'back' })}><ChevronLeft size={22} /></button>}
      <div className="phone-terminal__heading"><h1 tabIndex={-1} ref={heading}>{title}</h1><span>{pane === 'list' ? translate(sessions.length === 1 ? 'terminal.phone.sessionCountOne' : 'terminal.phone.sessionCountMany', { count: sessions.length.toLocaleString(getLocale()) }) : pane === 'terminal' ? describe(selected).label : selected.name}</span></div>
      {pane === 'list' && <button type="button" className="mac-tool" disabled={!available} aria-label={translate('terminal.session.new')} onClick={() => setPicker(true)}><Plus size={21} /></button>}
      {pane === 'terminal' && <>
        <button type="button" className="mac-tool" disabled={!supported || selected.status !== 'running'} aria-label={translate('terminal.phone.sessionFiles')} onClick={() => navigate({ type: 'files' })}><FolderOpen size={20} /></button>
        <button type="button" className="mac-tool" aria-label={translate('terminal.menu.closeSession')} onClick={() => setConfirmClose(true)}><Power size={19} /></button>
      </>}
    </div>
    {!available && <p className="phone-terminal__notice">{translate('terminal.common.desktopOnly')}</p>}
    {pane === 'list' ? <>
      <label className="phone-terminal__search"><Search size={16} aria-hidden="true" /><span className="sr-only">{translate('terminal.phone.searchSessions')}</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={translate('terminal.session.searchPlaceholder')} /></label>
      <div className="phone-terminal__sessions" aria-label={translate('terminal.phone.terminalSessions')}>
        {filtered.map((session, index) => <SessionCard key={session.id} session={session} selected={false} order={index} touch onSelect={open} />)}
        {!hydrated && <p role="status">{translate('terminal.phone.loadingSessions')}</p>}
        {hydrated && sessions.length > 0 && !filtered.length && <p>{translate('terminal.phone.noSessionsFound')}</p>}
        {hydrated && available && !sessions.length && <div className="page-empty"><h2>{translate('terminal.session.noneOpen')}</h2><p>{translate('terminal.phone.emptyDescription')}</p><button type="button" className="btn btn-primary" onClick={() => setPicker(true)}>{translate('terminal.session.new')}</button></div>}
      </div>
    </> : pane === 'terminal' ? <>
      {!supported && <p className="phone-terminal__notice" role="status">{translate('terminal.phone.updateDesktop')}</p>}
      {supported && <PhoneTerminal key={selected.id} session={selected} visible={terminalVisible} onPress={press} onTakeControl={() => requestTerminalControl(selected.id).catch(error => notify(error.message, 'warning'))} />}
      {['exited', 'error', 'disconnected'].includes(selected.status) && <p className="phone-terminal__notice" role="status">{selected.error || describe(selected).label}</p>}
      {['exited', 'error'].includes(selected.status) && <button type="button" className="btn btn-ghost" onClick={() => reopen(selected.id)}><RotateCcw size={16} />{translate('terminal.phone.reopenTerminal')}</button>}
      {supported && <div className="phone-terminal__keys" aria-label={translate('terminal.phone.terminalKeys')}>
        {KEYS.map(([label, data, name]) => <button type="button" disabled={!interactive} key={label} aria-label={name.startsWith('terminal.') ? translate(name) : name} onPointerDown={press} onClick={() => sendAndRestore(data)}>{label}</button>)}
        {canPaste() && <button type="button" disabled={!interactive} aria-label={translate('terminal.phone.pasteLabel')} onPointerDown={press} onClick={paste}><ClipboardPaste size={16} aria-hidden="true" />{translate('terminal.phone.paste')}</button>}
      </div>}
    </> : <PhoneFiles key={selected.id} session={selected} path={route.path} preview={pane === 'preview'} onPreview={path => navigate({ type: 'preview', path })} />}
    {picker && <NewSessionPopover onClose={() => setPicker(false)} onPick={(path, name) => { setPicker(false); const id = openSession(path, { name }); if (id) open(id); }} />}
    <AppModal open={confirmClose} title={translate('terminal.phone.closeNamed', { name: selected?.name })} onClose={() => { if (!closing) setConfirmClose(false); }} footer={<>
      <button type="button" className="btn btn-ghost" autoFocus disabled={closing} onClick={() => setConfirmClose(false)}>{translate('terminal.common.cancel')}</button>
      <button type="button" className="btn btn-danger" disabled={closing} onClick={endSession}>{translate(closing ? 'terminal.phone.closing' : 'terminal.menu.closeSession')}</button>
    </>}><p>{translate('terminal.phone.closeDescription')}</p></AppModal>
  </div>;
}
