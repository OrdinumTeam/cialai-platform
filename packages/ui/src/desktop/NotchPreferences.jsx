// SPDX-License-Identifier: Apache-2.0
// Ajustes da barra de IA, dentro das Preferencias.
//
// A lista de perfis e o coracao desta tela. Cada linha e uma **conta**, nao um
// provedor: quem tem cinco contas do Codex ve cinco linhas, cada uma com o
// nome da pasta, a conta logada e o proprio interruptor. Um apelido troca o
// rotulo do anel sem mexer em nada no disco.
//
// As pastas sem sufixo, `~/.claude` e `~/.codex`, aparecem apagadas quando
// repetem a conta de um perfil nomeado, para a barra nao desenhar dois aneis
// da mesma conta.
//
// A visibilidade vale na hora, como a aparencia; o resto entra no rascunho
// das Preferencias e e gravado com Salvar.

import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { SelectField } from '../components/ui.jsx';
import { providerName } from '../notch/copy.js';
import { duplicateHidden, moveProfile, orderedProfiles } from '../notch/model.js';
import { NOTCH_RESET_FORMATS, NOTCH_THRESHOLDS, NOTCH_VISIBILITIES } from './preferences-model.js';
import { useI18n } from './i18n.js';
import '../notch/notch.css';

const VISIBILITY_KEYS = Object.freeze({
  open: 'desktop.notch.prefs.visibility.open',
  collapsed: 'desktop.notch.prefs.visibility.collapsed',
  hidden: 'desktop.notch.prefs.visibility.hidden',
});

const RESET_FORMAT_KEYS = Object.freeze({
  automatic: 'desktop.notch.prefs.resetFormat.automatic',
  remaining: 'desktop.notch.prefs.resetFormat.remaining',
});

function Segmented({ value, options, onChange, ariaLabel, disabled }) {
  return <div className="mac-segmented" role="radiogroup" aria-label={ariaLabel}>
    {options.map((option) => <button key={option.value} type="button" role="radio" aria-checked={value === option.value} disabled={disabled} className={`mac-segmented__option${value === option.value ? ' is-selected' : ''}`} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

function Row({ title, description, children }) {
  return <div className="mac-prefs__row">
    <div className="mac-prefs__row-text"><div className="mac-prefs__row-title">{title}</div>{description ? <div className="mac-prefs__row-desc">{description}</div> : null}</div>
    <div className="mac-prefs__row-control">{children}</div>
  </div>;
}

function Switch({ checked, onChange, label, disabled }) {
  return <input type="checkbox" className="mac-switch" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} aria-label={label} />;
}

function ProfileRow({ profile, prefs, onPatch, onMove, first, last, disabled, t }) {
  const row = prefs.profiles?.[profile.id] || {};
  const enabled = row.enabled !== false;
  const hidden = duplicateHidden(profile, prefs);
  const folder = String(profile.configDir || '').split(/[\\/]/).filter(Boolean).pop();
  const [alias, setAlias] = useState(row.alias || '');
  useEffect(() => { setAlias(row.alias || ''); }, [row.alias]);

  return (
    <div className={`notch-prefs__profile${hidden ? ' is-hidden' : ''}`}>
      <div className="notch-prefs__profile-main">
        <span className={`notch-prefs__tag is-${profile.provider}`}>{providerName(profile.provider, t)}</span>
        <span className="notch-prefs__profile-name">{row.alias || profile.label}</span>
        <Switch checked={enabled && !hidden} disabled={disabled} onChange={(value) => onPatch(profile.id, { enabled: value })} label={t('desktop.notch.prefs.showRing', { profile: profile.label })} />
      </div>
      <div className="notch-prefs__profile-meta">
        <span>{profile.account || t('desktop.notch.prefs.noAccount')}</span>
        <span>{folder}</span>
      </div>
      {hidden ? <div className="notch-prefs__profile-note">{t('desktop.notch.prefs.duplicateNote')}</div> : null}
      <div className="notch-prefs__profile-actions">
        <input
          type="text"
          className="notch-prefs__alias"
          placeholder={t('desktop.notch.prefs.alias')}
          value={alias}
          maxLength={24}
          disabled={disabled}
          spellCheck="false"
          onChange={(event) => setAlias(event.target.value)}
          onBlur={() => onPatch(profile.id, { alias: alias.trim() || null })}
          aria-label={t('desktop.notch.prefs.aliasOf', { profile: profile.label })}
        />
        <button type="button" className="btn btn-quiet btn-sm" disabled={disabled} onClick={() => onPatch(profile.id, { muted: !row.muted })} title={row.muted ? t('desktop.notch.prefs.unmuteTitle') : t('desktop.notch.prefs.muteTitle')}>
          {row.muted ? t('desktop.notch.prefs.muted') : t('desktop.notch.prefs.alerting')}
        </button>
        <button type="button" className="mac-tool" disabled={disabled || first} onClick={() => onMove(profile.id, -1)} title={t('desktop.notch.prefs.moveUp')} aria-label={t('desktop.notch.prefs.moveUp')}>
          <ArrowUp size={14} strokeWidth={1.75} />
        </button>
        <button type="button" className="mac-tool" disabled={disabled || last} onClick={() => onMove(profile.id, 1)} title={t('desktop.notch.prefs.moveDown')} aria-label={t('desktop.notch.prefs.moveDown')}>
          <ArrowDown size={14} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

export default function NotchPreferences({ value, profiles, onChange, onVisibility, disabled = false }) {
  const { t } = useI18n();
  const prefs = value;
  const list = orderedProfiles(profiles || [], prefs.order || []);
  const patch = (next) => onChange({ ...prefs, ...next });

  const patchProfile = (id, values) => {
    const current = prefs.profiles?.[id] || { enabled: true, alias: null, muted: false };
    patch({ profiles: { ...(prefs.profiles || {}), [id]: { ...current, ...values } } });
  };

  const move = (id, direction) => {
    const ids = list.map((profile) => profile.id);
    const next = moveProfile(ids, id, direction);
    if (next !== ids) patch({ order: next });
  };

  const visibilityOptions = NOTCH_VISIBILITIES.map((option) => ({ value: option, label: t(VISIBILITY_KEYS[option]) }));
  const resetOptions = NOTCH_RESET_FORMATS.map((option) => ({ value: option, label: t(RESET_FORMAT_KEYS[option]) }));
  const thresholds = NOTCH_THRESHOLDS.map((limit) => ({ value: String(limit), label: `${Math.round(limit * 100)}%` }));

  return (
    <div className="notch-prefs">
      <Row title={t('desktop.notch.prefs.bar')} description={t('desktop.notch.prefs.barDescription')}>
        <Segmented value={prefs.visibility} options={visibilityOptions} onChange={onVisibility} ariaLabel={t('desktop.notch.prefs.bar')} disabled={disabled} />
      </Row>

      <h4 className="notch-prefs__heading">{t('desktop.notch.prefs.profiles')}</h4>
      <p className="mac-prefs__note">{t('desktop.notch.prefs.profilesDescription')}</p>
      <div className="notch-prefs__list">
        {list.length === 0 ? <p className="mac-prefs__note">{t('desktop.notch.prefs.noProfiles')}</p> : null}
        {list.map((profile, index) => (
          <ProfileRow key={profile.id} profile={profile} prefs={prefs} onPatch={patchProfile} onMove={move} first={index === 0} last={index === list.length - 1} disabled={disabled} t={t} />
        ))}
      </div>

      <h4 className="notch-prefs__heading">{t('desktop.notch.prefs.reading')}</h4>
      <Row title={t('desktop.notch.prefs.watch')} description={t('desktop.notch.prefs.watchDescription')}>
        <SelectField className="notch-prefs__threshold" value={String(prefs.watchLimit)} options={thresholds} onChange={(next) => patch({ watchLimit: Number(next) })} disabled={disabled} />
      </Row>
      <Row title={t('desktop.notch.prefs.critical')} description={t('desktop.notch.prefs.criticalDescription')}>
        <SelectField className="notch-prefs__threshold" value={String(prefs.criticalLimit)} options={thresholds} onChange={(next) => patch({ criticalLimit: Number(next) })} disabled={disabled} />
      </Row>
      <Row title={t('desktop.notch.prefs.resetFormat')} description={t('desktop.notch.prefs.resetFormatDescription')}>
        <Segmented value={prefs.resetTimeFormat} options={resetOptions} onChange={(resetTimeFormat) => patch({ resetTimeFormat })} ariaLabel={t('desktop.notch.prefs.resetFormat')} disabled={disabled} />
      </Row>

      <h4 className="notch-prefs__heading">{t('desktop.notch.prefs.alerts')}</h4>
      <p className="mac-prefs__note">{t('desktop.notch.prefs.alertsDescription')}</p>
      <Row title={t('desktop.notch.prefs.alertThreshold')} description={t('desktop.notch.prefs.alertThresholdDescription')}>
        <Switch checked={Boolean(prefs.alerts?.threshold)} disabled={disabled} onChange={(threshold) => patch({ alerts: { ...prefs.alerts, threshold } })} label={t('desktop.notch.prefs.alertThresholdLabel')} />
      </Row>
      <Row title={t('desktop.notch.prefs.alertLimit')} description={t('desktop.notch.prefs.alertLimitDescription')}>
        <Switch checked={Boolean(prefs.alerts?.limitReached)} disabled={disabled} onChange={(limitReached) => patch({ alerts: { ...prefs.alerts, limitReached } })} label={t('desktop.notch.prefs.alertLimitLabel')} />
      </Row>
      <Row title={t('desktop.notch.prefs.alertReset')} description={t('desktop.notch.prefs.alertResetDescription')}>
        <Switch checked={Boolean(prefs.alerts?.reset)} disabled={disabled} onChange={(reset) => patch({ alerts: { ...prefs.alerts, reset } })} label={t('desktop.notch.prefs.alertResetLabel')} />
      </Row>
    </div>
  );
}
