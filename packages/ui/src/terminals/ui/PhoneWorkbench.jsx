// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { ArrowDown, ChevronLeft, ClipboardPaste, FolderOpen, MessageSquarePlus, MoreHorizontal, Plus, RotateCcw, Search, UserRound } from 'lucide-react';
import { AppModal, useToast } from '../../components/ui.jsx';
import { hasBridge, invoke } from '../../lib/native.js';
import { onNavigateBack, requestNavigateBack } from '../../lib/shell.js';
import { bracketedPaste, changeDirectory, closeSession, describe, fitAndResize, focusTerminal, getSession, getState, hostTerminal, hydrate, isDemo, moveSessionBy, openSession, orderedSessions, pasteText, releaseTerminal, renameSession, reopen, requestTerminalControl, restart, scrollToBottom, selectSession, sendKey, setSessionColor, setSessionSubtitle, submitText, subscribe, supportsPhoneTerminal, terminalHasFocus, togglePinned, viewMounted, watchTail } from '../runtime.js';
import { phoneRoute, phoneRouteStorage, readPhoneRoute, writePhoneRoute } from '../phone-navigation.js';
import { useRuntimeEvents } from '../hooks.js';
import ActivityIndicator from './ActivityIndicator.jsx';
import PhoneComposer from './PhoneComposer.jsx';
import PhoneSessionMenu from './PhoneSessionMenu.jsx';
import AgentProfiles from './AgentProfiles.jsx';
import { NameDialog, Sheet } from './dialogs.jsx';
import NewSessionPopover from './NewSessionPopover.jsx';
import SessionCard from './SessionCard.jsx';
import PhoneFiles from './PhoneFiles.jsx';
import { getLocale, translate, useI18n } from '../../shared/i18n.js';

// Teclas da fileira. Enter vem logo depois de Esc, porque e a tecla mais
// usada com um agente; Shift Tab alterna o modo do Claude Code; Ctrl D
// encerra a entrada; Ctrl L limpa a tela. Cada entrada: rotulo, sequencia e
// nome acessivel.
const ESC = String.fromCharCode(27);
const control = (letter) => String.fromCharCode(letter.charCodeAt(0) - 64);
const KEYS = [
  ['Esc', ESC, 'Esc'],
  ['Enter', '\r', 'Enter'],
  ['Tab', '\t', 'Tab'],
  ['Shift Tab', `${ESC}[Z`, 'Shift Tab'],
  ['Ctrl C', control('C'), 'Ctrl C'],
  ['↑', `${ESC}[A`, 'terminal.phone.arrowUp'],
  ['↓', `${ESC}[B`, 'terminal.phone.arrowDown'],
  ['Ctrl D', control('D'), 'Ctrl D'],
  ['Ctrl L', control('L'), 'Ctrl L'],
];

// Ler a area de transferencia exige contexto seguro e um gesto do usuario.
const canPaste = () => typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function';

function PhoneTerminal({ session, visible, interactive, onTakeControl, onPress, onCompose }) {
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
    <button type="button" className="phone-terminal__compose" disabled={!interactive} aria-label={translate('terminal.phone.composer.open')} title={translate('terminal.phone.composer.open')} onPointerDown={onPress} onClick={onCompose}><MessageSquarePlus size={22} aria-hidden="true" /></button>
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
  const [composing, setComposing] = useState(false);
  // Sessão cujo menu de ações está aberto, o pedido de nome em curso e a
  // sessão que está trocando de pasta pelo navegador de pastas.
  const [menuFor, setMenuFor] = useState(null);
  const [nameRequest, setNameRequest] = useState(null);
  const [folderFor, setFolderFor] = useState(null);
  const [profiles, setProfiles] = useState(false);
  // Sessão que vai receber o agente numa conta escolhida.
  const [launchFor, setLaunchFor] = useState(null);
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
  const status = pane === 'terminal' ? describe(selected) : null;
  const subtitle = pane === 'list'
    ? translate(sessions.length === 1 ? 'terminal.phone.sessionCountOne' : 'terminal.phone.sessionCountMany', { count: sessions.length.toLocaleString(getLocale()) })
    : pane === 'terminal' ? status.label : selected.name;
  const subtitleTone = status?.tone === 'busy' ? ' is-busy' : status?.tone === 'bad' ? ' is-bad' : '';
  // Cria a pasta do perfil e abre um terminal já nele, para o login ser feito
  // pelo próprio programa. Nenhuma credencial passa pelo Cialai.
  async function createProfile(request, name) {
    try {
      const id = await invoke('agent_profile_create', { agent: request.agent, name });
      request.reload?.();
      const sessionId = openSession(getState().selected?.cwd || sessions[0]?.cwd || '');
      if (!sessionId) return;
      open(sessionId);
      const session = getSession(sessionId);
      if (session?.ptyId != null) await invoke('pty_launch_agent', { id: session.ptyId, agent: request.agent, profile: id });
    } catch (error) {
      notify(error.message, 'warning');
    }
  }

  // Cada ação do menu roda aqui, com o mesmo efeito do menu do computador.
  // Renomear e trocar o subtítulo não tocam no processo da sessão.
  async function runSessionAction(kind, session, value) {
    if (kind === 'rename') { setNameRequest({ kind: 'rename', sessionId: session.id, title: translate('terminal.menu.renameSession'), initial: session.name, required: true, confirmLabel: translate('terminal.common.save') }); return; }
    if (kind === 'subtitle') { setNameRequest({ kind: 'subtitle', sessionId: session.id, title: translate('terminal.menu.subtitleTitle'), description: translate('terminal.menu.subtitleDescription'), initial: session.subtitle, placeholder: translate('terminal.menu.subtitlePlaceholder'), confirmLabel: translate('terminal.common.save') }); return; }
    if (kind === 'color') { setSessionColor(session.id, value); return; }
    if (kind === 'pin') { togglePinned(session.id); return; }
    if (kind === 'up') { moveSessionBy(session.id, -1); return; }
    if (kind === 'down') { moveSessionBy(session.id, 1); return; }
    if (kind === 'clone') { const id = openSession(session.cwd); if (id) open(id); return; }
    if (kind === 'directory') { setFolderFor(session); return; }
    if (kind === 'launch') { setLaunchFor(session); return; }
    if (kind === 'copy') {
      try { await navigator.clipboard.writeText(session.cwd); notify(translate('terminal.common.pathCopied'), 'success'); }
      catch (_error) { notify(translate('terminal.common.copyFailed'), 'warning'); }
      return;
    }
    if (kind === 'restart') { restart(session.id).catch(error => notify(error.message, 'warning')); return; }
    if (kind === 'close') { selectSession(session.id); navigate({ type: 'select', id: session.id }); setConfirmClose(true); }
  }

  async function endSession() {
    setClosing(true);
    try { await closeSession(selected.id); setConfirmClose(false); if (!getSession(selected.id)) navigate({ type: 'reset' }); }
    catch (error) { notify(error.message, 'warning'); }
    finally { setClosing(false); }
  }
  return <div className={`view active phone-terminal phone-terminal--${pane}`} id="view-terminais">
    <div className="phone-terminal__toolbar">
      {pane !== 'list' && <button type="button" className="mac-tool phone-terminal__back" aria-label={translate(pane === 'terminal' ? 'terminal.phone.backSessions' : pane === 'files' ? 'terminal.phone.backTerminal' : 'terminal.phone.backFiles')} onClick={() => navigate({ type: 'back' })}><ChevronLeft size={26} /></button>}
      <div className="phone-terminal__heading"><h1 tabIndex={-1} ref={heading}>{title}</h1><span className={subtitleTone.trim() || undefined}>{status ? <ActivityIndicator tone={status.tone} animated={status.animated} className="phone-terminal__activity" /> : null}{subtitle}</span></div>
      {pane === 'list' && <div className="phone-terminal__actions">
        <button type="button" className="mac-tool" disabled={!available} aria-label={translate('terminal.profiles.title')} title={translate('terminal.profiles.title')} onClick={() => setProfiles(true)}><UserRound size={22} /></button>
        <button type="button" className="mac-tool" disabled={!available} aria-label={translate('terminal.session.new')} onClick={() => setPicker(true)}><Plus size={24} /></button>
      </div>}
      {pane === 'terminal' && <div className="phone-terminal__actions">
        <button type="button" className="mac-tool" disabled={!supported || selected.status !== 'running'} aria-label={translate('terminal.phone.sessionFiles')} onClick={() => navigate({ type: 'files' })}><FolderOpen size={22} /></button>
        <button type="button" className="mac-tool" aria-label={translate('terminal.session.actionsFor', { name: selected.name })} title={translate('terminal.session.actionsFor', { name: selected.name })} onClick={() => setMenuFor(selected)}><MoreHorizontal size={22} /></button>
      </div>}
    </div>
    {!available && <p className="phone-terminal__notice">{translate('terminal.common.desktopOnly')}</p>}
    {pane === 'list' ? <>
      <label className="phone-terminal__search"><Search size={16} aria-hidden="true" /><span className="sr-only">{translate('terminal.phone.searchSessions')}</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={translate('terminal.session.searchPlaceholder')} /></label>
      <div className="phone-terminal__sessions" aria-label={translate('terminal.phone.terminalSessions')}>
        {filtered.map((session, index) => <SessionCard key={session.id} session={session} selected={false} order={index} touch onSelect={open} onMenu={setMenuFor} />)}
        {!hydrated && <p role="status">{translate('terminal.phone.loadingSessions')}</p>}
        {hydrated && sessions.length > 0 && !filtered.length && <p>{translate('terminal.phone.noSessionsFound')}</p>}
        {hydrated && available && !sessions.length && <div className="page-empty"><h2>{translate('terminal.session.noneOpen')}</h2><p>{translate('terminal.phone.emptyDescription')}</p><button type="button" className="btn btn-primary" onClick={() => setPicker(true)}>{translate('terminal.session.new')}</button></div>}
      </div>
    </> : pane === 'terminal' ? <>
      {!supported && <p className="phone-terminal__notice" role="status">{translate('terminal.phone.updateDesktop')}</p>}
      {supported && <PhoneTerminal key={selected.id} session={selected} visible={terminalVisible} interactive={interactive} onPress={press} onCompose={() => setComposing(true)} onTakeControl={() => requestTerminalControl(selected.id).catch(error => notify(error.message, 'warning'))} />}
      {supported && <PhoneComposer
        open={composing}
        sessionId={selected.id}
        interactive={interactive}
        bracketed={bracketedPaste(selected.id)}
        onClose={() => setComposing(false)}
        onSubmit={async (text, options) => {
          const sent = await submitText(selected.id, text, options);
          if (!sent) notify(translate('terminal.phone.composer.notSent'), 'warning');
          return sent;
        }}
      />}
      {['exited', 'error', 'disconnected'].includes(selected.status) && <p className={`phone-terminal__notice${selected.status === 'error' || (selected.status === 'exited' && selected.exitCode !== 0) ? ' is-bad' : ''}`} role="status">{selected.error || describe(selected).label}</p>}
      {['exited', 'error'].includes(selected.status) && <button type="button" className="btn btn-ghost" onClick={() => reopen(selected.id)}><RotateCcw size={16} />{translate('terminal.phone.reopenTerminal')}</button>}
      {supported && <div className="phone-terminal__keys" aria-label={translate('terminal.phone.terminalKeys')}>
        {KEYS.map(([label, data, name]) => <button type="button" disabled={!interactive} key={label} aria-label={name.startsWith('terminal.') ? translate(name) : name} onPointerDown={press} onClick={() => sendAndRestore(data)}>{label}</button>)}
        {canPaste() && <button type="button" disabled={!interactive} aria-label={translate('terminal.phone.pasteLabel')} onPointerDown={press} onClick={paste}><ClipboardPaste size={16} aria-hidden="true" />{translate('terminal.phone.paste')}</button>}
      </div>}
    </> : <PhoneFiles key={selected.id} session={selected} path={route.path} preview={pane === 'preview'} onPreview={path => navigate({ type: 'preview', path })} />}
    {picker && <NewSessionPopover onClose={() => setPicker(false)} onPick={(path, name) => { setPicker(false); const id = openSession(path, { name }); if (id) open(id); }} />}
    {folderFor && <NewSessionPopover
      startPath={folderFor.cwd}
      title={translate('terminal.session.changeFolderTitle')}
      confirmLabel={translate('terminal.menu.changeFolder')}
      onClose={() => setFolderFor(null)}
      onPick={(path) => {
        const session = folderFor;
        setFolderFor(null);
        if (!path || path === session.cwd) return;
        // Trocar a pasta encerra o processo da sessão: a confirmação é a
        // própria escolha, feita numa tela à parte e com o caminho à vista.
        changeDirectory(session.id, path).catch(error => notify(error.message, 'warning'));
      }}
    />}
    <Sheet
      open={profiles}
      title={translate('terminal.profiles.title')}
      onClose={() => setProfiles(false)}
      actions={<button type="button" className="btn btn-ghost" onClick={() => setProfiles(false)}>{translate('terminal.phone.composer.close')}</button>}
    >
      <AgentProfiles
        onCreate={(agent, reload) => setNameRequest({ kind: 'profile', agent, reload, title: translate('terminal.profiles.createTitle'), description: translate('terminal.profiles.createDescription'), required: true, confirmLabel: translate('terminal.profiles.create') })}
      />
    </Sheet>
    <Sheet
      open={Boolean(launchFor)}
      title={translate('terminal.profiles.launchHere')}
      onClose={() => setLaunchFor(null)}
      actions={<button type="button" className="btn btn-ghost" onClick={() => setLaunchFor(null)}>{translate('terminal.common.cancel')}</button>}
    >
      <AgentProfiles onSelected={(profile) => {
        const session = launchFor;
        setLaunchFor(null);
        if (!session || session.ptyId == null) return;
        invoke('pty_launch_agent', { id: session.ptyId, agent: profile.agent, profile: profile.id })
          .catch(error => notify(error.message, 'warning'));
      }} />
    </Sheet>
    <PhoneSessionMenu
      session={menuFor}
      open={Boolean(menuFor)}
      onClose={() => setMenuFor(null)}
      onAction={runSessionAction}
    />
    <NameDialog
      request={nameRequest}
      onCancel={() => setNameRequest(null)}
      onConfirm={(value) => {
        const request = nameRequest;
        setNameRequest(null);
        if (!request) return;
        if (request.kind === 'rename') renameSession(request.sessionId, value);
        else if (request.kind === 'profile') createProfile(request, value);
        else setSessionSubtitle(request.sessionId, value);
      }}
    />
    <AppModal open={confirmClose} title={translate('terminal.phone.closeNamed', { name: selected?.name })} onClose={() => { if (!closing) setConfirmClose(false); }} footer={<>
      <button type="button" className="btn btn-ghost" autoFocus disabled={closing} onClick={() => setConfirmClose(false)}>{translate('terminal.common.cancel')}</button>
      <button type="button" className="btn btn-danger" disabled={closing} onClick={endSession}>{translate(closing ? 'terminal.phone.closing' : 'terminal.menu.closeSession')}</button>
    </>}><p>{translate('terminal.phone.closeDescription')}</p></AppModal>
  </div>;
}
