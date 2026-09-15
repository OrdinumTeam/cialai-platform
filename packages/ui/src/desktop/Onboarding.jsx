// SPDX-License-Identifier: Apache-2.0
// Primeiro uso do desktop: prepara o estúdio local e explica o acesso pelo
// celular, que sobe sozinho sem nenhuma configuração de rede.

import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, FolderOpen, FolderPlus, Globe, ShieldCheck, Smartphone, Terminal, Wifi } from 'lucide-react';
import { chooseDirectory, invoke, isTauri } from '../lib/native.js';
import { platform } from '../lib/platform.js';
import logo from '../../../../brand/logo/cialai-mantis-v4-1-head-4k.png';
import { useTunnel } from './TunnelContext.jsx';
import { translate } from './i18n.js';

export const ONBOARDING_KEY = 'cialai_onboarding_complete';
const ROOT_NAMES = ['Projects', 'Developer', 'src', 'dev', 'code', 'Github Projects'];
const onboardingSteps = () => ['welcome', 'folders', 'shell', 'network', 'ready'].map((step) => translate(`desktop.onboarding.step.${step}`));

const DEFAULT_PREFS = {
  appearance: 'system',
  terminal: { shell: null, args: [], lang: null, pathPrefix: [] },
  projectRoots: [],
  devBrowser: { chromiumPath: null },
  window: { backdrop: 'auto' },
  network: {
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
  return <ol className="mac-onboarding__steps" aria-label={translate('desktop.onboarding.steps')}>
    {onboardingSteps().map((label, index) => <li key={label} className={`${index === step ? 'is-current' : ''}${index < step ? ' is-done' : ''}`} aria-current={index === step ? 'step' : undefined}>
      <span className="mac-onboarding__step-dot" aria-hidden="true">{index < step ? <Check size={12} /> : index + 1}</span>
      <span>{label}</span>
    </li>)}
  </ol>;
}

function Welcome({ next }) {
  return <div className="mac-onboarding__welcome mac-onboarding__screen">
    <img className="mac-onboarding__mark" src={logo} alt="" draggable="false" />
    <p className="mac-onboarding__eyebrow">{translate('desktop.onboarding.localStudio')}</p>
    <h1 id="onboarding-title">{translate('desktop.onboarding.welcome')}</h1>
    <p className="mac-onboarding__lead">{translate('desktop.onboarding.welcomeDescription')}</p>
    <button type="button" className="btn btn-primary mac-onboarding__primary" onClick={next}>{translate('desktop.onboarding.configureStudio')}</button>
  </div>;
}

function Folders({ roots, selected, toggle, add, busy, error }) {
  return <div className="mac-onboarding__screen">
    <div className="mac-onboarding__icon" aria-hidden="true"><FolderOpen /></div>
    <p className="mac-onboarding__eyebrow">{translate('desktop.onboarding.projectFolders')}</p>
    <h1 id="onboarding-title">{translate('desktop.onboarding.whereWork')}</h1>
    <p className="mac-onboarding__lead">{translate('desktop.onboarding.foldersDescription')}</p>
    <div className="mac-onboarding__roots" role="group" aria-label={translate('desktop.onboarding.foundFolders')}>
      {roots.map((root) => <label key={root.path} className={`mac-onboarding__root${selected.includes(root.path) ? ' is-selected' : ''}${!root.exists ? ' is-missing' : ''}`}>
        <input type="checkbox" checked={selected.includes(root.path)} disabled={!root.exists} onChange={() => toggle(root.path)} />
        <span className="mac-onboarding__root-copy"><strong>{root.label}</strong><span>{root.path}</span></span>
        <span className="mac-onboarding__root-state">{root.exists ? (selected.includes(root.path) ? translate('desktop.onboarding.included') : translate('desktop.onboarding.found')) : translate('desktop.onboarding.notFound')}</span>
      </label>)}
    </div>
    <button type="button" className="btn btn-secondary mac-onboarding__add" disabled={busy} onClick={add}><FolderPlus size={15} />{translate('desktop.preferences.addFolder')}</button>
    {error ? <p className="mac-onboarding__error" role="alert">{error}</p> : null}
  </div>;
}

function ShellStep({ shell, setShell, probe, test }) {
  const currentPassed = probe.status === 'pass' && probe.shell === shell.trim();
  return <div className="mac-onboarding__screen">
    <div className="mac-onboarding__icon" aria-hidden="true"><Terminal /></div>
    <p className="mac-onboarding__eyebrow">{translate('desktop.preferences.terminal')}</p>
    <h1 id="onboarding-title">{translate('desktop.onboarding.confirmShell')}</h1>
    <p className="mac-onboarding__lead">{translate('desktop.onboarding.shellDescription')}</p>
    <label className="mac-onboarding__field"><span>{translate('desktop.preferences.shellPath')}</span><input autoFocus className="field__control" value={shell} spellCheck="false" onChange={(event) => setShell(event.target.value)} /></label>
    <div className="mac-onboarding__probe">
      <div className="mac-onboarding__probe-head"><span>{translate('desktop.onboarding.ptyTest')}</span><span className={`mac-onboarding__probe-state is-${probe.status}`}>{probe.status === 'running' ? translate('desktop.onboarding.opening') : currentPassed ? translate('desktop.onboarding.approved') : probe.status === 'error' ? translate('desktop.onboarding.failed') : translate('desktop.onboarding.notRun')}</span></div>
      <pre aria-live="polite">{probe.output || translate('desktop.onboarding.promptHere')}</pre>
    </div>
    <button type="button" className="btn btn-secondary" disabled={!shell.trim() || probe.status === 'running'} onClick={test}>{probe.status === 'running' ? translate('desktop.onboarding.testing') : translate('desktop.onboarding.testShell')}</button>
  </div>;
}

// Passo informativo: não há o que preencher, só o estado da rede que já sobe.
function MobileStep() {
  const tunnel = useTunnel();
  return <div className="mac-onboarding__screen">
    <div className="mac-onboarding__icon" aria-hidden="true"><Smartphone /></div>
    <p className="mac-onboarding__eyebrow">{translate('desktop.access.title')}</p>
    <h1 id="onboarding-title">{translate('desktop.onboarding.mobileAccess')}</h1>
    <p className="mac-onboarding__lead">{translate('desktop.onboarding.networkDescription')}</p>
    <ul className="mac-onboarding__facts">
      <li><Wifi aria-hidden="true" /><span><strong>{translate('desktop.onboarding.factLocal')}</strong><small>{translate('desktop.onboarding.factLocalDescription')}</small></span></li>
      <li><Globe aria-hidden="true" /><span><strong>{translate('desktop.onboarding.factReserve')}</strong><small>{translate('desktop.onboarding.factReserveDescription')}</small></span></li>
      <li><ShieldCheck aria-hidden="true" /><span><strong>{translate('desktop.onboarding.factPairing')}</strong><small>{translate('desktop.onboarding.factPairingDescription')}</small></span></li>
    </ul>
    <p className="mac-onboarding__access-state" role="status"><i className={`mac-dot is-${tunnel.status.tone}`} aria-hidden="true" />{tunnel.status.label}</p>
  </div>;
}

function Ready({ selected, shell, saving, error }) {
  const tunnel = useTunnel();
  return <div className="mac-onboarding__screen">
    <div className="mac-onboarding__ready-mark" aria-hidden="true"><Check /></div>
    <p className="mac-onboarding__eyebrow">{translate('desktop.onboarding.allSet')}</p>
    <h1 id="onboarding-title">{translate('desktop.onboarding.studioReady')}</h1>
    <p className="mac-onboarding__lead">{translate('desktop.onboarding.readyDescription')}</p>
    <dl className="mac-onboarding__summary">
      <div><dt>{translate('desktop.onboarding.initialFolder')}</dt><dd>{selected[0]}</dd></div>
      <div><dt>Shell</dt><dd>{shell}</dd></div>
      <div><dt>{translate('desktop.onboarding.mobileFiles')}</dt><dd>{translate(selected.length === 1 ? 'desktop.onboarding.rootOne' : 'desktop.onboarding.rootMany', { count: selected.length })}</dd></div>
      <div><dt>{translate('desktop.access.title')}</dt><dd><i className={`mac-dot is-${tunnel.status.tone}`} aria-hidden="true" />{tunnel.status.label}</dd></div>
    </dl>
    {error ? <p className="mac-onboarding__error" role="alert">{error}</p> : null}
    {saving ? <p className="mac-onboarding__saving" role="status">{translate('desktop.preferences.saving')}</p> : null}
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
        if (!cancelled) setError(translate('desktop.onboarding.loadError', { error: loadError?.message || loadError }));
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
      const path = await chooseDirectory({ title: translate('desktop.preferences.addProjectFolder') });
      if (!path) return;
      const label = path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || path;
      setRoots((current) => mergeRoots(current, [{ label, path, exists: true }]));
      setSelected((current) => current.includes(path) ? current : [...current, path]);
    } catch (pickError) {
      setError(translate('desktop.onboarding.folderError', { error: pickError?.message || pickError }));
    } finally { setBusy(false); }
  };
  const testShell = async () => {
    const value = shell.trim();
    setProbe({ status: 'running', shell: value, output: '' });
    setError('');
    try {
      const result = native
        ? await invoke('shell_probe', { shell: value, cwd: selected[0] })
        : { output: translate('desktop.onboarding.demoOutput') };
      setProbe({ status: 'pass', shell: value, output: cleanPrompt(result?.output) || translate('desktop.onboarding.emptyPty') });
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
      setError(translate('desktop.preferences.saveError', { error: saveError?.message || saveError }));
      setSaving(false);
    }
  };

  return <div className="mac-onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
    <aside className="mac-onboarding__rail"><div className="mac-onboarding__brand"><img src={logo} alt="" /><span>Cialai</span></div><StepRail step={step} /><p>{translate('desktop.onboarding.localConfiguration')}<br />{translate('desktop.onboarding.changeLater')}</p></aside>
    <section className="mac-onboarding__canvas">
      <div className="mac-onboarding__content" key={step}>
        {loading ? <div className="mac-onboarding__loading" role="status">{translate('desktop.onboarding.preparingStudio')}</div> : null}
        {!loading && step === 0 ? <Welcome next={() => setStep(1)} /> : null}
        {!loading && step === 1 ? <Folders roots={roots} selected={selected} toggle={toggle} add={add} busy={busy} error={error} /> : null}
        {!loading && step === 2 ? <ShellStep shell={shell} setShell={setShell} probe={probe} test={testShell} /> : null}
        {!loading && step === 3 ? <MobileStep /> : null}
        {!loading && step === 4 ? <Ready selected={selected} shell={shell} saving={saving} error={error} /> : null}
      </div>
      {!loading && step > 0 ? <footer className="mac-onboarding__footer">
        <button type="button" className="btn btn-quiet" disabled={saving} onClick={() => { setError(''); setStep((current) => current - 1); }}><ChevronLeft size={15} />{translate('desktop.action.back')}</button>
        {step < 4 ? <button type="button" className="btn btn-primary" disabled={!canContinue} onClick={() => setStep((current) => current + 1)}>{translate('desktop.action.continue')}</button> : <div className="mac-onboarding__final-actions"><button type="button" className="btn btn-secondary" disabled={saving} onClick={() => finish(true)}>{translate('desktop.action.pairPhone')}</button><button type="button" className="btn btn-primary" disabled={saving} onClick={() => finish(false)}>{saving ? translate('desktop.onboarding.opening') : translate('desktop.onboarding.openFirstSession')}</button></div>}
      </footer> : null}
    </section>
  </div>;
}
