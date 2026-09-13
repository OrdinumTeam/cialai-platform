// SPDX-License-Identifier: Apache-2.0
// Headscale setup assistant shared by onboarding and Network preferences.

import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, KeyRound, Network, Server, UserRound } from 'lucide-react';
import { useTunnel, tunnelErrorMessage } from './TunnelContext.jsx';
import { networkIsConfigured, normalizeNetworkConfig, validateControlInput } from './tunnel-model.js';

const phaseLabels = { server: 'Servidor', user: 'Usuário', computer: 'Computador', done: 'Concluído' };

function Progress({ phase }) {
  const phases = Object.keys(phaseLabels);
  const current = phases.indexOf(phase);
  return <ol className="mac-network-setup__progress" aria-label="Etapas da rede">
    {phases.map((item, index) => <li key={item} className={`${index === current ? 'is-current' : ''}${index < current ? ' is-done' : ''}`}><span>{index < current ? <Check aria-hidden="true" /> : index + 1}</span>{phaseLabels[item]}</li>)}
  </ol>;
}

function ServerStep({ input, setInput, apiKey, setApiKey, busy, error, health, secretStatus, verify, verifySaved }) {
  return <div className="mac-network-setup__body">
    <div className="mac-network-setup__intro"><span className="mac-network-setup__icon"><Server aria-hidden="true" /></span><div><h4>Conectar ao Headscale</h4><p>O Cialai confere o endereço, o certificado e a versão antes de salvar a chave.</p></div></div>
    <label className="mac-network-setup__field"><span>URL do Headscale</span><input className="field__control" value={input.controlUrl || ''} placeholder="https://headscale.exemplo.com" spellCheck="false" onChange={(event) => setInput((current) => ({ ...current, controlUrl: event.target.value }))} /></label>
    <label className="mac-network-setup__field"><span>Chave da API</span><input className="field__control" type="password" value={apiKey} placeholder={secretStatus?.present ? 'Uma chave já está protegida neste computador' : 'hskey-api'} spellCheck="false" autoComplete="off" onChange={(event) => setApiKey(event.target.value)} /></label>
    {health?.ok ? <div className="mac-network-checks" role="status"><span><Check aria-hidden="true" />Servidor respondeu</span><span><Check aria-hidden="true" />Certificado aceito</span><span><Check aria-hidden="true" />Versão {health.serverVersion || 'compatível'}</span></div> : null}
    {error ? <p className="mac-network-setup__error" role="alert">{error}</p> : null}
    <div className="mac-network-setup__actions">
      {secretStatus?.present && input.controlUrl ? <button type="button" className="btn btn-secondary" disabled={busy} onClick={verifySaved}><KeyRound aria-hidden="true" />Usar chave protegida</button> : null}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={verify}>{busy ? 'Verificando…' : 'Verificar servidor'}</button>
    </div>
  </div>;
}

function UserStep({ users, choice, setChoice, newUser, setNewUser, busy, error, advance, back }) {
  return <div className="mac-network-setup__body">
    <div className="mac-network-setup__intro"><span className="mac-network-setup__icon"><UserRound aria-hidden="true" /></span><div><h4>Escolher o usuário da rede</h4><p>Celular e computador precisam pertencer ao mesmo usuário para se encontrarem.</p></div></div>
    <label className="mac-network-setup__field"><span>Usuário</span><select className="field__control field__control--select" value={choice} onChange={(event) => setChoice(event.target.value)}><option value="">Selecione</option>{users.map((user) => <option key={String(user.id)} value={String(user.id)}>{user.displayName || user.name}</option>)}<option value="new">Criar novo usuário</option></select></label>
    {choice === 'new' ? <div className="mac-network-setup__fields"><label className="mac-network-setup__field"><span>Identificador</span><input className="field__control" value={newUser.name} placeholder="ana" spellCheck="false" onChange={(event) => setNewUser((current) => ({ ...current, name: event.target.value }))} /></label><label className="mac-network-setup__field"><span>Nome visível</span><input className="field__control" value={newUser.displayName} placeholder="Ana" onChange={(event) => setNewUser((current) => ({ ...current, displayName: event.target.value }))} /></label></div> : null}
    {error ? <p className="mac-network-setup__error" role="alert">{error}</p> : null}
    <div className="mac-network-setup__actions"><button type="button" className="btn btn-quiet" disabled={busy} onClick={back}><ChevronLeft aria-hidden="true" />Voltar</button><button type="button" className="btn btn-primary" disabled={busy || !choice || (choice === 'new' && !newUser.name.trim())} onClick={advance}>{busy ? 'Preparando…' : 'Continuar'}</button></div>
  </div>;
}

function ComputerStep({ input, setInput, busy, error, connect, back }) {
  return <div className="mac-network-setup__body">
    <div className="mac-network-setup__intro"><span className="mac-network-setup__icon"><Network aria-hidden="true" /></span><div><h4>Nomear este computador</h4><p>Este nome aparece no celular quando você lê o código de pareamento.</p></div></div>
    <label className="mac-network-setup__field"><span>Nome do computador</span><input className="field__control" value={input.desktopName || ''} placeholder="Mac do estúdio" maxLength="48" onChange={(event) => setInput((current) => ({ ...current, desktopName: event.target.value }))} /></label>
    <label className="mac-network-setup__toggle"><input type="checkbox" checked={Boolean(input.requireApproval)} onChange={(event) => setInput((current) => ({ ...current, requireApproval: event.target.checked }))} /><span><strong>Confirmar cada novo celular</strong><small>Mostra um código de quatro dígitos antes de autorizar.</small></span></label>
    <label className="mac-network-setup__toggle"><input type="checkbox" checked={Boolean(input.keepAwakeWhilePaired)} onChange={(event) => setInput((current) => ({ ...current, keepAwakeWhilePaired: event.target.checked }))} /><span><strong>Manter ativo durante o uso remoto</strong><small>Evita repouso enquanto um celular estiver conectado.</small></span></label>
    {error ? <p className="mac-network-setup__error" role="alert">{error}</p> : null}
    <div className="mac-network-setup__actions"><button type="button" className="btn btn-quiet" disabled={busy} onClick={back}><ChevronLeft aria-hidden="true" />Voltar</button><button type="button" className="btn btn-primary" disabled={busy || !String(input.desktopName || '').trim()} onClick={connect}>{busy ? 'Conectando…' : 'Conectar computador'}</button></div>
  </div>;
}

function DoneStep({ input, node, onReconfigure, onPair }) {
  return <div className="mac-network-setup__body mac-network-setup__done">
    <span className="mac-network-setup__done-mark"><Check aria-hidden="true" /></span>
    <div><p className="mac-network-setup__eyebrow">Rede pronta</p><h4>{input.desktopName}</h4><p>Este computador está acessível pela rede privada do Cialai.</p></div>
    <dl className="mac-network-setup__summary"><div><dt>Endereço</dt><dd>{node?.ip4 || 'Aguardando'}</dd></div><div><dt>Nome na rede</dt><dd>{node?.dnsName || input.desktopName}</dd></div><div><dt>Usuário</dt><dd>{input.userName}</dd></div></dl>
    <div className="mac-network-setup__actions"><button type="button" className="btn btn-quiet" onClick={onReconfigure}>Configurar novamente</button>{onPair ? <button type="button" className="btn btn-primary" onClick={onPair}>Vincular celular</button> : null}</div>
  </div>;
}

export default function NetworkSetup({ value, onChange, onReady, onPair, startExpanded = false }) {
  const tunnel = useTunnel();
  const original = useMemo(() => normalizeNetworkConfig(value || tunnel.network || {}), [value, tunnel.network]);
  const [input, setInput] = useState(original);
  const [apiKey, setApiKey] = useState('');
  const [phase, setPhase] = useState(() => !startExpanded && networkIsConfigured(original) && tunnel.snapshot.node?.state === 'running' ? 'done' : 'server');
  const [users, setUsers] = useState([]);
  const [choice, setChoice] = useState(original.userId || '');
  const [newUser, setNewUser] = useState({ name: '', displayName: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verifiedHealth, setVerifiedHealth] = useState(null);

  useEffect(() => { setInput(original); }, [original.controlUrl, original.userId, original.userName, original.desktopName, original.requireApproval, original.keepAwakeWhilePaired]);

  const loadUsers = async () => {
    const result = await tunnel.call('control.users.list', {});
    const nextUsers = Array.isArray(result?.users) ? result.users : [];
    setUsers(nextUsers);
    if (original.userId && nextUsers.some((user) => String(user.id) === original.userId)) setChoice(original.userId);
    setPhase('user');
  };

  const verify = async () => {
    const issue = validateControlInput(input.controlUrl, apiKey);
    if (issue) { setError(issue); return; }
    setBusy(true); setError('');
    try { const result = await tunnel.configureControl({ url: String(input.controlUrl).trim().replace(/\/+$/, ''), apiKey }); setVerifiedHealth(result?.health || null); await loadUsers(); }
    catch (verifyError) { setError(tunnelErrorMessage(verifyError)); }
    finally { setBusy(false); }
  };

  const verifySaved = async () => {
    if (!input.controlUrl) { setError('Informe a URL do Headscale.'); return; }
    setBusy(true); setError('');
    try { const result = await tunnel.configureSavedControl(String(input.controlUrl).trim().replace(/\/+$/, '')); setVerifiedHealth(result?.health || null); await loadUsers(); }
    catch (verifyError) { setError(tunnelErrorMessage(verifyError)); }
    finally { setBusy(false); }
  };

  const advanceUser = async () => {
    setBusy(true); setError('');
    try {
      let selected = users.find((user) => String(user.id) === choice);
      if (choice === 'new') {
        const result = await tunnel.call('control.users.create', { name: newUser.name.trim(), displayName: newUser.displayName.trim() });
        selected = result?.user;
      }
      if (!selected) throw new Error('Escolha um usuário válido.');
      setInput((current) => ({ ...current, userId: String(selected.id), userName: selected.name }));
      setPhase('computer');
    } catch (userError) { setError(tunnelErrorMessage(userError)); }
    finally { setBusy(false); }
  };

  const connect = async () => {
    const next = normalizeNetworkConfig(input);
    setBusy(true); setError('');
    try {
      const node = await tunnel.connectNetwork(next, { restart: true });
      onChange?.(next);
      onReady?.(next, node);
      setPhase('done');
    } catch (connectError) { setError(tunnelErrorMessage(connectError)); }
    finally { setBusy(false); }
  };

  return <div className="mac-network-setup"><Progress phase={phase} />
    {phase === 'server' ? <ServerStep input={input} setInput={setInput} apiKey={apiKey} setApiKey={setApiKey} busy={busy} error={error} health={verifiedHealth} secretStatus={tunnel.secretStatus} verify={verify} verifySaved={verifySaved} /> : null}
    {phase === 'user' ? <UserStep users={users} choice={choice} setChoice={setChoice} newUser={newUser} setNewUser={setNewUser} busy={busy} error={error} advance={advanceUser} back={() => { setError(''); setPhase('server'); }} /> : null}
    {phase === 'computer' ? <ComputerStep input={input} setInput={setInput} busy={busy} error={error} connect={connect} back={() => { setError(''); setPhase('user'); }} /> : null}
    {phase === 'done' ? <DoneStep input={input} node={tunnel.snapshot.node} onReconfigure={() => { setError(''); setVerifiedHealth(null); setPhase('server'); }} onPair={onPair} /> : null}
  </div>;
}
