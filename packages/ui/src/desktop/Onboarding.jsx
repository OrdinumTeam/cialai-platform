// SPDX-License-Identifier: Apache-2.0
// Primeiro uso do desktop: prepara o estúdio local e oferece a rede privada.

import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, FolderOpen, FolderPlus, Network, Terminal } from 'lucide-react';
import { chooseDirectory, invoke, isTauri } from '../lib/native.js';
import { platform } from '../lib/platform.js';
import logo from '../../../../brand/logo/cialai-mantis-v4-1-head-4k.png';
import NetworkSetup from './NetworkSetup.jsx';
import { networkIsConfigured } from './tunnel-model.js';

export const ONBOARDING_KEY = 'cialai_onboarding_complete';
const ROOT_NAMES = ['Projects', 'Developer', 'src', 'dev', 'code', 'Github Projects'];
const STEPS = ['Boas-vindas', 'Pastas', 'Shell', 'Rede', 'Pronto'];

const DEFAULT_PREFS = {
  appearance: 'system',
  terminal: { shell: null, args: [], lang: null, pathPrefix: [] },
  projectRoots: [],
  devBrowser: { chromiumPath: null },
  window: { backdrop: 'auto' },
  network: {
    controlUrl: null,
    userId: null,
    userName: null,
    desktopName: null,
    requireApproval: false,
    keepAwakeWhilePaired: false,
  },
};

function queryMode() {
  return new URLSearchParams(window.location.search).get('onboarding');
}

export function shouldShowOnboarding() {
  const mode = queryMode();
  if (mode === '1') return true;
  if (mode === 'skip') return false;
  try { return isTauri() && localStorage.getItem(ONBOARDING_KEY) !== '1'; } catch (_error) { return isTauri(); }
}

function browserData() {
  const info = platform();
  const separator = info.home.endsWith('/') ? '' : '/';
  const roots = ROOT_NAMES.map((label, index) => ({
    label,
    path: `${info.home}${separator}${label}`,
    exists: index === 0,
  }));
  const shell = info.os === 'windows'
    ? { path: 'pwsh.exe', args: ['-NoLogo'], flavor: 'powershell' }
    : { path: '/bin/zsh', args: ['-l'], flavor: 'posix' };
  return {
    prefs: { ...DEFAULT_PREFS, terminal: { ...DEFAULT_PREFS.terminal }, projectRoots: [roots[0].path] },
    roots,
    configured: roots.slice(0, 1),
    shell,
  };
}

function mergeRoots(detected, configured) {
  const roots = [];
  for (const entry of [...detected, ...configured]) {
    if (entry?.path && !roots.some((root) => root.path === entry.path)) roots.push(entry);
  }
  return roots;
}

function cleanPrompt(value) {
  return String(value || '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replaceAll('\r', '')
    .trim()
    .slice(0, 1200);
}

function StepRail({ step }) {
  return <ol className="mac-onboarding__steps" aria-label="Etapas da configuração">
    {STEPS.map((label, index) => <li key={label} className={`${index === step ? 'is-current' : ''}${index < step ? ' is-done' : ''}`} aria-current={index === step ? 'step' : undefined}>
      <span className="mac-onboarding__step-dot" aria-hidden="true">{index < step ? <Check size={12} /> : index + 1}</span>
      <span>{label}</span>
    </li>)}
  </ol>;
}

function Welcome({ next }) {
  return <div className="mac-onboarding__welcome mac-onboarding__screen">
    <img className="mac-onboarding__mark" src={logo} alt="" draggable="false" />
    <p className="mac-onboarding__eyebrow">Seu estúdio local</p>
    <h1 id="onboarding-title">Boas-vindas ao Cialai</h1>
    <p className="mac-onboarding__lead">Mantenha terminais, arquivos e ferramentas de projeto juntos, sem mover o seu código para outro lugar.</p>
    <button type="button" className="btn btn-primary mac-onboarding__primary" onClick={next}>Configurar o estúdio</button>
  </div>;
}

function Folders({ roots, selected, toggle, add, busy, error }) {
  return <div className="mac-onboarding__screen">
    <div className="mac-onboarding__icon" aria-hidden="true"><FolderOpen /></div>
    <p className="mac-onboarding__eyebrow">Pastas de projetos</p>
    <h1 id="onboarding-title">Onde você trabalha?</h1>
    <p className="mac-onboarding__lead">O Cialai usa estas raízes no seletor de projetos. Sessões fora delas continuam funcionando, mas os arquivos não ficam disponíveis no celular.</p>
    <div className="mac-onboarding__roots" role="group" aria-label="Pastas encontradas">
      {roots.map((root) => <label key={root.path} className={`mac-onboarding__root${selected.includes(root.path) ? ' is-selected' : ''}${!root.exists ? ' is-missing' : ''}`}>
        <input type="checkbox" checked={selected.includes(root.path)} disabled={!root.exists} onChange={() => toggle(root.path)} />
        <span className="mac-onboarding__root-copy"><strong>{root.label}</strong><span>{root.path}</span></span>
        <span className="mac-onboarding__root-state">{root.exists ? (selected.includes(root.path) ? 'Incluída' : 'Encontrada') : 'Não encontrada'}</span>
      </label>)}
    </div>
    <button type="button" className="btn btn-secondary mac-onboarding__add" disabled={busy} onClick={add}><FolderPlus size={15} />Adicionar pasta…</button>
    {error ? <p className="mac-onboarding__error" role="alert">{error}</p> : null}
  </div>;
}

function ShellStep({ shell, setShell, probe, test }) {
  const currentPassed = probe.status === 'pass' && probe.shell === shell.trim();
  return <div className="mac-onboarding__screen">
    <div className="mac-onboarding__icon" aria-hidden="true"><Terminal /></div>
    <p className="mac-onboarding__eyebrow">Terminal</p>
    <h1 id="onboarding-title">Confirme o seu shell</h1>
    <p className="mac-onboarding__lead">Detectamos o shell do sistema. Você pode ajustar o caminho e abrir um PTY descartável para conferir o prompt.</p>
    <label className="mac-onboarding__field"><span>Caminho do shell</span><input autoFocus className="field__control" value={shell} spellCheck="false" onChange={(event) => setShell(event.target.value)} /></label>
    <div className="mac-onboarding__probe">
      <div className="mac-onboarding__probe-head"><span>Teste do PTY</span><span className={`mac-onboarding__probe-state is-${probe.status}`}>{probe.status === 'running' ? 'Abrindo…' : currentPassed ? 'Aprovado' : probe.status === 'error' ? 'Falhou' : 'Não executado'}</span></div>
      <pre aria-live="polite">{probe.output || 'O prompt aparecerá aqui.'}</pre>
    </div>
    <button type="button" className="btn btn-secondary" disabled={!shell.trim() || probe.status === 'running'} onClick={test}>{probe.status === 'running' ? 'Testando…' : 'Testar shell'}</button>
  </div>;
}

function NetworkStep({ network, onChange, expanded, onExpand }) {
  if (expanded) return <div className="mac-onboarding__screen mac-onboarding__network"><NetworkSetup value={network} onChange={onChange} startExpanded /></div>;
  return <div className="mac-onboarding__screen">
    <div className="mac-onboarding__icon" aria-hidden="true"><Network /></div>
    <p className="mac-onboarding__eyebrow">Rede privada</p>
    <h1 id="onboarding-title">Quer acessar pelo celular?</h1>
    <p className="mac-onboarding__lead">Conecte o Cialai ao seu Headscale para abrir terminais e arquivos com segurança fora deste computador. Você também pode fazer isso depois.</p>
    <button type="button" className="btn btn-primary" onClick={onExpand}>Configurar agora</button>
  </div>;
}

function Ready({ selected, shell, network, saving, error }) {
  return <div className="mac-onboarding__screen">
    <div className="mac-onboarding__ready-mark" aria-hidden="true"><Check /></div>
    <p className="mac-onboarding__eyebrow">Tudo certo</p>
    <h1 id="onboarding-title">Seu estúdio está pronto</h1>
    <p className="mac-onboarding__lead">Vamos abrir a primeira sessão na pasta principal. Você pode mudar estas escolhas em Preferências.</p>
    <dl className="mac-onboarding__summary">
      <div><dt>Pasta inicial</dt><dd>{selected[0]}</dd></div>
      <div><dt>Shell</dt><dd>{shell}</dd></div>
      <div><dt>Arquivos móveis</dt><dd>{selected.length} {selected.length === 1 ? 'raiz permitida' : 'raízes permitidas'}</dd></div>
      <div><dt>Rede</dt><dd>{networkIsConfigured(network) ? `${network.desktopName} acessível` : 'Configurar depois'}</dd></div>
    </dl>
    {error ? <p className="mac-onboarding__error" role="alert">{error}</p> : null}
    {saving ? <p className="mac-onboarding__saving" role="status">Salvando preferências…</p> : null}
  </div>;
}

export default function Onboarding({ onComplete }) {
  const native = isTauri();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [roots, setRoots] = useState([]);
  const [selected, setSelected] = useState([]);
  const [shell, setShellValue] = useState('');
  const [probe, setProbe] = useState({ status: 'idle', shell: '', output: '' });
  const [networkSetupOpen, setNetworkSetupOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = native
          ? await Promise.all([
            invoke('get_preferences'),
            invoke('detect_project_roots'),
            invoke('list_repo_dirs'),
            invoke('app_shell'),
          ]).then(([nextPrefs, detected, listing, nextShell]) => ({
            prefs: nextPrefs,
            roots: mergeRoots(detected || [], listing?.roots || []),
            configured: listing?.roots || [],
            shell: nextShell,
          }))
          : browserData();
        if (cancelled) return;
        const existingConfigured = data.configured.filter((root) => root.exists).map((root) => root.path);
        const firstDetected = data.roots.find((root) => root.exists)?.path;
        setPrefs(data.prefs || DEFAULT_PREFS);
        setRoots(data.roots);
        setSelected(existingConfigured.length ? existingConfigured : (firstDetected ? [firstDetected] : []));
        setShellValue(data.shell?.path || '');
      } catch (loadError) {
        if (!cancelled) setError(`Não foi possível ler a configuração: ${loadError?.message || loadError}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [native]);

  const canContinue = useMemo(() => {
    if (step === 1) return selected.length > 0;
    if (step === 2) return probe.status === 'pass' && probe.shell === shell.trim();
    return true;
  }, [step, selected.length, probe, shell]);

  const setShell = (value) => {
    setShellValue(value);
    setProbe({ status: 'idle', shell: '', output: '' });
    setError('');
  };
  const toggle = (path) => {
    setSelected((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
    setError('');
  };
  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const path = await chooseDirectory({ title: 'Adicionar pasta de projetos' });
      if (!path) return;
      const label = path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || path;
      setRoots((current) => mergeRoots(current, [{ label, path, exists: true }]));
      setSelected((current) => current.includes(path) ? current : [...current, path]);
    } catch (pickError) {
      setError(`Não foi possível abrir a pasta: ${pickError?.message || pickError}`);
    } finally { setBusy(false); }
  };
  const testShell = async () => {
    const value = shell.trim();
    setProbe({ status: 'running', shell: value, output: '' });
    setError('');
    try {
      const result = native
        ? await invoke('shell_probe', { shell: value, cwd: selected[0] })
        : { output: 'Cialai PTY de demonstração\nexemplo@mac Projects %' };
      setProbe({ status: 'pass', shell: value, output: cleanPrompt(result?.output) || 'PTY aberto sem texto inicial.' });
    } catch (probeError) {
      const message = probeError?.message || String(probeError);
      setProbe({ status: 'error', shell: value, output: cleanPrompt(message) });
    }
  };
  const finish = async (openPair = false) => {
    setSaving(true);
    setError('');
    try {
      const next = {
        ...prefs,
        projectRoots: selected,
        terminal: { ...prefs.terminal, shell: shell.trim() || null, args: [] },
      };
      if (native) await invoke('set_preferences', { next });
      try { localStorage.setItem(ONBOARDING_KEY, '1'); } catch (_error) { /* storage unavailable */ }
      onComplete(selected[0], { openPair });
    } catch (saveError) {
      setError(`Não foi possível salvar: ${saveError?.message || saveError}`);
      setSaving(false);
    }
  };

  return <div className="mac-onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
    <aside className="mac-onboarding__rail"><div className="mac-onboarding__brand"><img src={logo} alt="" /><span>Cialai</span></div><StepRail step={step} /><p>Configuração local<br />Você pode mudar depois.</p></aside>
    <section className="mac-onboarding__canvas">
      <div className="mac-onboarding__content" key={step}>
        {loading ? <div className="mac-onboarding__loading" role="status">Preparando o estúdio…</div> : null}
        {!loading && step === 0 ? <Welcome next={() => setStep(1)} /> : null}
        {!loading && step === 1 ? <Folders roots={roots} selected={selected} toggle={toggle} add={add} busy={busy} error={error} /> : null}
        {!loading && step === 2 ? <ShellStep shell={shell} setShell={setShell} probe={probe} test={testShell} /> : null}
        {!loading && step === 3 ? <NetworkStep network={prefs.network} expanded={networkSetupOpen} onExpand={() => setNetworkSetupOpen(true)} onChange={(network) => setPrefs((current) => ({ ...current, network }))} /> : null}
        {!loading && step === 4 ? <Ready selected={selected} shell={shell} network={prefs.network} saving={saving} error={error} /> : null}
      </div>
      {!loading && step > 0 ? <footer className="mac-onboarding__footer">
        <button type="button" className="btn btn-quiet" disabled={saving} onClick={() => { setError(''); setStep((current) => current - 1); }}><ChevronLeft size={15} />Voltar</button>
        {step < 4 ? <button type="button" className="btn btn-primary" disabled={!canContinue} onClick={() => setStep((current) => current + 1)}>{step === 3 && !networkIsConfigured(prefs.network) ? 'Depois' : 'Continuar'}</button> : <div className="mac-onboarding__final-actions"><button type="button" className="btn btn-secondary" disabled={saving} onClick={() => { if (networkIsConfigured(prefs.network)) finish(true); else { setNetworkSetupOpen(true); setStep(3); } }}>Vincular celular</button><button type="button" className="btn btn-primary" disabled={saving} onClick={() => finish(false)}>{saving ? 'Abrindo…' : 'Abrir primeira sessão'}</button></div>}
      </footer> : null}
    </section>
  </div>;
}
