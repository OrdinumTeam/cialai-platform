// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ArrowDown, ChevronLeft, ClipboardPaste, FolderOpen, Keyboard, MoreHorizontal, Plus, RotateCcw, Send, UserRound } from 'lucide-react';
import { AppModal, useToast } from '../../components/ui.jsx';
import { hasBridge, invoke } from '../../lib/native.js';
import { onNavigateBack, postProjectPicked, requestNavigateBack, takeShellIntent } from '../../lib/shell.js';
import { baseName } from '../files.js';
import { applicationCursorKeys, blurTerminal, bracketedPaste, changeDirectory, closeSession, describe, fitAndResize, focusTerminal, getSession, getState, hostTerminal, hydrate, isDemo, launchAgentWhenReady, moveSessionBy, onTerminalFocus, openSession, orderedSessions, pasteText, releaseTerminal, renameSession, reopen, requestTerminalControl, restart, scrollToBottom, selectSession, sendKey, setInputTransform, setSessionColor, setSessionSubtitle, submitText, subscribe, supportsPhoneTerminal, terminalHasFocus, togglePinned, viewMounted, watchTail } from '../runtime.js';
import { phoneRoute, phoneRouteStorage, readPhoneRoute, writePhoneRoute } from '../phone-navigation.js';
import { useRuntimeEvents } from '../hooks.js';
import ActivityIndicator from './ActivityIndicator.jsx';
import PhoneComposer from './PhoneComposer.jsx';
import PhoneKeyboardSheet, { keyHandlers, keyLabel, keyName } from './PhoneKeyboardSheet.jsx';
import PhoneQuickCommands from './PhoneQuickCommands.jsx';
import { KEY_CATALOG, PASTE_KEY, keyboardPrefsStorage, readKeyboardPrefs, writeKeyboardPrefs } from '../keyboard-prefs.js';
import { MODIFIERS } from '../key-encoder.js';
import { bindSessionKeys, sessionKeyController } from '../special-keys.js';
import PhoneSessionMenu from './PhoneSessionMenu.jsx';
import AgentProfiles from './AgentProfiles.jsx';
import { NameDialog, Sheet } from './dialogs.jsx';
import DirectoryBrowser from './DirectoryBrowser.jsx';
import NewSessionFlow from './NewSessionFlow.jsx';
import PhoneSessionCard, { PhoneSessionSkeleton } from './PhoneSessionCard.jsx';
import { SearchInput, SegmentedControl } from '../../mobile/ui.jsx';
import { countSessions, filterSessions, sessionPhase } from '../phone-session-list.js';
import PhoneFiles from './PhoneFiles.jsx';
import { getLocale, translate, useI18n } from '../../shared/i18n.js';

// Vibração curta nas teclas, onde o WebView oferece: Android sim, iOS não.
const canVibrate = () => typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
const modifierLabels = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };

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
  // Sessão nova em tela cheia; `path` vem preenchido quando o pedido do
  // aplicativo já trouxe a pasta, e o fluxo começa na etapa do agente.
  const [picker, setPicker] = useState(null);
  // Pasta pedida pela tela Projetos do aplicativo para virar atalho.
  const [pickProject, setPickProject] = useState(false);
  // Sessões à espera de confirmação para encerrar ou reiniciar. A confirmação
  // aparece na própria lista, sem abrir o terminal antes.
  const [closeFor, setCloseFor] = useState(null);
  const [restartFor, setRestartFor] = useState(null);
  const [composing, setComposing] = useState(false);
  // Teclado especial e comandos rapidos: um painel de cada vez, e nunca o
  // teclado especial junto com o do aparelho.
  const [keysOpen, setKeysOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [keyboardPrefs, setKeyboardPrefs] = useState(() => readKeyboardPrefs(keyboardPrefsStorage()));
  const [keyState, setKeyState] = useState({ armed: {}, mode: 'oneShot', any: false });
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
  const [filter, setFilter] = useState('all');
  // A entrada dos cards anima só quando a lista chega; depois disso, filtro e
  // busca trocam os cards sem animação.
  const [settled, setSettled] = useState(false);
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
  useEffect(() => {
    if (!hydrated || settled) return undefined;
    const timer = setTimeout(() => setSettled(true), 400);
    return () => clearTimeout(timer);
  }, [hydrated, settled]);
  // O voltar do aparelho fecha antes a tela cheia que estiver aberta.
  useEffect(() => onNavigateBack(() => {
    if (quickOpen) setQuickOpen(false);
    else if (keysOpen) setKeysOpen(false);
    else if (picker) setPicker(null);
    else if (folderFor) setFolderFor(null);
    else if (pickProject) { setPickProject(false); requestNavigateBack(); }
    else if (pane === 'list') requestNavigateBack();
    else navigate({ type: 'back' });
  }), [pane, picker, folderFor, pickProject, keysOpen, quickOpen]);
  // Rota restaurada depois de recarregar: a sessao aparece com a hidratacao.
  useEffect(() => { if (selected) selectSession(selected.id); }, [selected?.id]);
  useEffect(() => {
    hydrate().then(() => {
      // Pedido feito no Inicio do aplicativo, consumido uma vez.
      const intent = takeShellIntent();
      if (!intent) return;
      if (intent.kind === 'profiles') setProfiles(true);
      else if (intent.kind === 'session' && getSession(intent.sessionId)) { selectSession(intent.sessionId); navigate({ type: 'select', id: intent.sessionId }); }
      // A pasta do pedido só preenche o fluxo: a sessão abre no toque final.
      else if (intent.kind === 'new-session') setPicker({ path: typeof intent.cwd === 'string' ? intent.cwd : '' });
      else if (intent.kind === 'pick-project') setPickProject(true);
    }).catch((error) => notify(error.message, 'warning'));
    viewMounted(true);
    const off = subscribe((event) => { if (event.type === 'error') notify(event.message, 'warning'); });
    return () => { off(); viewMounted(false); };
  }, [notify]);
  const available = hasBridge() || isDemo();
  const supported = supportsPhoneTerminal();
  const terminalVisible = isDemo() || Boolean(selected?.viewport?.owned) || ['exited', 'error'].includes(selected?.status);
  const open = (id) => { selectSession(id); navigate({ type: 'select', id }); };
  const interactive = Boolean(selected) && selected.status === 'running' && terminalVisible;
  // Um controlador por sessao aberta: modificadores armados, sequencias e
  // repeticao num lugar so. O que o teclado nativo digita passa por ele no
  // caminho para o PTY.
  const keySessionId = pane === 'terminal' ? selected?.id : null;
  const controller = useMemo(() => (keySessionId ? sessionKeyController(keySessionId, {
    sendKey, applicationCursorKeys, vibrate: canVibrate() ? (ms) => navigator.vibrate(ms) : null,
  }) : null), [keySessionId]);
  useEffect(() => (controller ? bindSessionKeys(controller, keySessionId, { setInputTransform, onState: setKeyState }) : undefined),
    [controller, keySessionId]);
  useEffect(() => {
    controller?.setMode(keyboardPrefs.modifierMode);
    controller?.setHaptics(keyboardPrefs.haptics);
  }, [controller, keyboardPrefs.modifierMode, keyboardPrefs.haptics]);
  // Sair do terminal fecha os paineis; trocar de sessao comeca sem
  // modificador armado, porque o controlador e outro.
  useEffect(() => {
    if (keySessionId) return;
    setKeysOpen(false);
    setQuickOpen(false);
  }, [keySessionId]);
  // O teclado do aparelho subiu pelo toque no terminal: o especial fecha. Os
  // modificadores armados continuam e valem para o proximo caractere.
  useEffect(() => (keySessionId ? onTerminalFocus(keySessionId, () => setKeysOpen(false)) : undefined), [keySessionId, selected?.status]);
  // Exibicao automatica, uma vez por entrada na sessao, e so com o teclado do
  // aparelho fechado.
  const autoOpened = useRef(null);
  useEffect(() => {
    if (!keySessionId || !interactive || !keyboardPrefs.autoOpen) return;
    if (autoOpened.current === keySessionId) return;
    autoOpened.current = keySessionId;
    if (!terminalHasFocus(keySessionId)) setKeysOpen(true);
  }, [keySessionId, interactive, keyboardPrefs.autoOpen]);
  useEffect(() => { if (!keySessionId) autoOpened.current = null; }, [keySessionId]);
  const openKeys = () => {
    if (keysOpen) { setKeysOpen(false); return; }
    // Com o painel aberto o teclado do aparelho fica fechado: nenhuma tecla
    // do painel devolve o foco ao terminal.
    focused.current = false;
    blurTerminal(selected.id);
    setQuickOpen(false);
    setKeysOpen(true);
  };
  const openQuick = () => {
    blurTerminal(selected.id);
    setKeysOpen(false);
    setQuickOpen(true);
  };
  const nativeKeyboard = () => {
    setKeysOpen(false);
    focusTerminal(selected.id);
  };
  const updateKeyboardPrefs = (next) => setKeyboardPrefs(writeKeyboardPrefs(keyboardPrefsStorage(), next));
  const armedLabel = MODIFIERS.filter((name) => keyState.armed?.[name]).map((name) => modifierLabels[name]).join(' ');
  async function deliverQuick(command, enter) {
    const sent = await submitText(selected.id, command, { enter });
    if (!sent) notify(translate('terminal.phone.composer.notSent'), 'warning');
    return sent;
  }
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
  const phaseOf = (session) => sessionPhase(describe(session));
  const filtered = filterSessions(sessions, { query, filter, phaseOf });
  const activeCount = countSessions(sessions, 'active', phaseOf);
  const countLabel = translate(sessions.length === 1 ? 'terminal.phone.sessionCountOne' : 'terminal.phone.sessionCountMany', { count: sessions.length.toLocaleString(getLocale()) });
  const title = pane === 'list' ? translate('terminal.phone.terminals') : pane === 'files' ? translate('terminal.phone.files') : pane === 'preview' ? route.path.split('/').at(-1) : selected.name;
  const status = pane === 'terminal' ? describe(selected) : null;
  const subtitle = pane === 'list' ? null : pane === 'terminal' ? status.label : selected.name;
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
      await launchAgentWhenReady(sessionId, request.agent, id);
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
    if (kind === 'restart') { setRestartFor(session); return; }
    if (kind === 'close') { setCloseFor(session); }
  }

  async function endSession() {
    const target = closeFor;
    if (!target) return;
    setClosing(true);
    try {
      await closeSession(target.id);
      setCloseFor(null);
      if (route.sessionId === target.id && !getSession(target.id)) navigate({ type: 'reset' });
    } catch (error) { notify(error.message, 'warning'); }
    finally { setClosing(false); }
  }

  async function restartSession() {
    const target = restartFor;
    if (!target) return;
    setClosing(true);
    try { await restart(target.id); setRestartFor(null); }
    catch (error) { notify(error.message, 'warning'); }
    finally { setClosing(false); }
  }
  return <div className={`view active phone-terminal phone-terminal--${pane}`} id="view-terminais">
    <div className="phone-terminal__toolbar">
      {pane !== 'list' && <button type="button" className="mac-tool phone-terminal__back" aria-label={translate(pane === 'terminal' ? 'terminal.phone.backSessions' : pane === 'files' ? 'terminal.phone.backTerminal' : 'terminal.phone.backFiles')} onClick={() => navigate({ type: 'back' })}><ChevronLeft size={26} /></button>}
      <div className="phone-terminal__heading"><h1 tabIndex={-1} ref={heading}>{title}</h1>{subtitle ? <span className={subtitleTone.trim() || undefined}>{status ? <ActivityIndicator tone={status.tone} animated={status.animated} className="phone-terminal__activity" /> : null}{subtitle}</span> : null}</div>
      {pane === 'list' && <div className="phone-terminal__actions">
        <button type="button" className="mac-tool" disabled={!available} aria-label={translate('terminal.profiles.title')} title={translate('terminal.profiles.title')} onClick={() => setProfiles(true)}><UserRound size={22} /></button>
        <button type="button" className="mac-tool phone-terminal__new-icon" disabled={!available} aria-label={translate('terminal.session.new')} onClick={() => setPicker({ path: '' })}><Plus size={24} /></button>
      </div>}
      {pane === 'terminal' && <div className="phone-terminal__actions">
        <button type="button" className="mac-tool" disabled={!supported || selected.status !== 'running'} aria-label={translate('terminal.phone.sessionFiles')} onClick={() => navigate({ type: 'files' })}><FolderOpen size={22} /></button>
        <button type="button" className="mac-tool" aria-label={translate('terminal.session.actionsFor', { name: selected.name })} title={translate('terminal.session.actionsFor', { name: selected.name })} onClick={() => setMenuFor(selected)}><MoreHorizontal size={22} /></button>
      </div>}
    </div>
    {!available && <p className="phone-terminal__notice">{translate('terminal.common.desktopOnly')}</p>}
    {pane === 'list' ? <>
      <div className="phone-terminal__filters">
        <SearchInput value={query} onChange={setQuery} placeholder={translate('terminal.session.searchPlaceholder')} label={translate('terminal.phone.searchSessions')} />
        <SegmentedControl
          label={translate('terminal.phone.filterLabel')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: translate('terminal.phone.filter.all') },
            { value: 'active', label: translate('terminal.phone.filter.active'), count: hydrated ? activeCount : undefined },
            { value: 'finished', label: translate('terminal.phone.filter.finished') },
          ]}
        />
      </div>
      <div className={`phone-terminal__sessions${settled ? ' is-settled' : ''}`} aria-label={`${translate('terminal.phone.terminalSessions')}, ${countLabel}`} aria-busy={!hydrated || undefined}>
        {hydrated ? filtered.map((session) => <PhoneSessionCard key={session.id} session={session} onSelect={open} onMenu={setMenuFor} />) : null}
        {!hydrated && <>
          <span className="sr-only" role="status">{translate('terminal.phone.loadingSessions')}</span>
          <PhoneSessionSkeleton /><PhoneSessionSkeleton /><PhoneSessionSkeleton />
        </>}
        {hydrated && sessions.length > 0 && !filtered.length && <div className="phone-terminal__empty"><p>{translate(query.trim() ? 'terminal.phone.noSessionsFound' : 'terminal.phone.noSessionsInFilter')}</p></div>}
        {hydrated && available && !sessions.length && <div className="phone-terminal__empty"><h2>{translate('terminal.session.noneOpen')}</h2><p>{translate('terminal.phone.emptyDescription')}</p></div>}
      </div>
      {available && <div className="phone-terminal__quick">
        <button type="button" className="phone-terminal__quick-button" onClick={() => setPicker({ path: '' })}><Plus size={20} strokeWidth={2.2} aria-hidden="true" />{translate('terminal.session.new')}</button>
      </div>}
    </> : pane === 'terminal' ? <>
      {!supported && <p className="phone-terminal__notice" role="status">{translate('terminal.phone.updateDesktop')}</p>}
      {supported && <PhoneTerminal key={selected.id} session={selected} visible={terminalVisible} onPress={press} onTakeControl={() => requestTerminalControl(selected.id).catch(error => notify(error.message, 'warning'))} />}
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
      {supported && controller && <PhoneKeyboardSheet
        open={keysOpen}
        controller={controller}
        state={keyState}
        interactive={interactive}
        prefs={keyboardPrefs}
        onPrefsChange={updateKeyboardPrefs}
        canVibrate={canVibrate()}
        onPaste={paste}
        onNativeKeyboard={nativeKeyboard}
        onClose={() => setKeysOpen(false)}
      />}
      {supported && controller && !keysOpen && <div className="phone-keybar" role="toolbar" aria-label={translate('terminal.phone.terminalKeys')}>
        <button type="button" className={`phone-keybar__keys${keyState.any ? ' is-armed' : ''}`} aria-expanded={keysOpen} aria-label={keyState.any ? translate('terminal.phone.keys.openArmed', { keys: armedLabel }) : translate('terminal.phone.keys.open')} onMouseDown={(event) => event.preventDefault()} onClick={openKeys}>
          <Keyboard size={22} aria-hidden="true" />
        </button>
        {keyboardPrefs.favorites.map((id) => (id === PASTE_KEY
          ? <button key={id} type="button" className="phone-keybar__key" disabled={!interactive} aria-label={keyName(id)} onPointerDown={press} onMouseDown={(event) => event.preventDefault()} onClick={paste}>{keyLabel(id)}</button>
          : <button key={id} type="button" className={`phone-keybar__key${KEY_CATALOG[id].icon ? ' phone-keybar__key--icon' : ''}`} disabled={!interactive} aria-label={keyName(id)} {...keyHandlers(controller, KEY_CATALOG[id].key, KEY_CATALOG[id].mods, press)}>
            {KEY_CATALOG[id].icon === 'paste' ? <ClipboardPaste size={20} aria-hidden="true" /> : keyLabel(id)}
          </button>))}
        <button type="button" className="phone-keybar__more" disabled={!interactive} aria-label={translate('terminal.phone.quick.open')} onMouseDown={(event) => event.preventDefault()} onClick={openQuick}><MoreHorizontal size={22} aria-hidden="true" /></button>
        <button type="button" className="phone-keybar__send" disabled={!interactive} aria-label={translate('terminal.phone.composer.open')} onMouseDown={(event) => event.preventDefault()} onClick={() => { setKeysOpen(false); setComposing(true); }}><Send size={20} aria-hidden="true" /></button>
      </div>}
      {supported && <PhoneQuickCommands
        open={quickOpen}
        interactive={interactive}
        onClose={() => setQuickOpen(false)}
        onInsert={(command) => deliverQuick(command, false)}
        onRun={(command) => deliverQuick(command, true)}
      />}
    </> : <PhoneFiles key={selected.id} session={selected} path={route.path} preview={pane === 'preview'} onPreview={path => navigate({ type: 'preview', path })} />}
    {picker && <NewSessionFlow initialPath={picker.path} onClose={() => setPicker(null)} onNotify={notify}
      onOpen={(id) => { setPicker(null); open(id); }} />}
    {pickProject && <DirectoryBrowser
      title={translate('terminal.browser.addProject')}
      onClose={() => { setPickProject(false); try { requestNavigateBack(); } catch (_error) { /* sem casca */ } }}
      onConfirm={(path) => {
        setPickProject(false);
        try { postProjectPicked(path, baseName(path)); } catch (error) { notify(error.message, 'warning'); }
      }}
    />}
    {folderFor && <DirectoryBrowser
      startPath={folderFor.cwd}
      title={translate('terminal.session.changeFolderTitle')}
      confirmLabel={translate('terminal.menu.changeFolder')}
      onClose={() => setFolderFor(null)}
      onConfirm={(path) => {
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
    <AppModal open={Boolean(closeFor)} title={translate('terminal.phone.closeNamed', { name: closeFor?.name })} onClose={() => { if (!closing) setCloseFor(null); }} footer={<>
      <button type="button" className="btn btn-ghost" autoFocus disabled={closing} onClick={() => setCloseFor(null)}>{translate('terminal.common.cancel')}</button>
      <button type="button" className="btn btn-danger" disabled={closing} onClick={endSession}>{translate(closing ? 'terminal.phone.closing' : 'terminal.menu.closeSession')}</button>
    </>}><p>{translate('terminal.phone.closeDescription')}</p></AppModal>
    <AppModal open={Boolean(restartFor)} title={translate('terminal.phone.restartNamed', { name: restartFor?.name })} onClose={() => { if (!closing) setRestartFor(null); }} footer={<>
      <button type="button" className="btn btn-ghost" autoFocus disabled={closing} onClick={() => setRestartFor(null)}>{translate('terminal.common.cancel')}</button>
      <button type="button" className="btn btn-danger" disabled={closing} onClick={restartSession}>{translate(closing ? 'terminal.phone.restarting' : 'terminal.menu.restartTerminal')}</button>
    </>}><p>{translate('terminal.phone.restartDescription')}</p></AppModal>
  </div>;
}
