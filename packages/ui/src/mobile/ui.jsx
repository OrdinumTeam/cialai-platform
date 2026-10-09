// SPDX-License-Identifier: Apache-2.0
// Componentes visuais da pagina do celular, os mesmos do aplicativo nativo
// (apps/mobile/src/ui). O estilo fica em mobile.css nas classes phone-*.
// Carregamento e vazio continuam no DataState de components/ui.jsx e a folha
// inferior no Sheet de terminals/ui/dialogs.jsx.
import React from 'react';
import { Search, X } from 'lucide-react';
import { translate } from './i18n.js';

const TONES = new Set(['success', 'warning', 'danger', 'primary', 'neutral']);
const toneClass = (tone) => (TONES.has(tone) && tone !== 'neutral' ? ` phone-badge--${tone}` : '');

export function SegmentedControl({ options, value, onChange, label }) {
  return (
    <div className="phone-segmented" role="tablist" aria-label={label}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button key={option.value} type="button" role="tab" aria-selected={selected} disabled={option.disabled}
            className={`phone-segmented__option${selected ? ' is-selected' : ''}`} onClick={() => onChange(option.value)}>
            <span>{option.label}</span>
            {option.count !== undefined ? <span className="phone-segmented__count">{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder, label }) {
  return (
    <label className="phone-search">
      <Search size={18} aria-hidden="true" />
      <input type="search" value={value} placeholder={placeholder} aria-label={label || placeholder} enterKeyHint="search"
        autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => onChange(event.target.value)} />
      {value ? (
        <button type="button" className="phone-icon-btn" aria-label={translate('mobile.common.clearSearch')} onClick={() => onChange('')}>
          <X size={18} aria-hidden="true" />
        </button>
      ) : null}
    </label>
  );
}

// `dot` e a bolinha com texto, como "Conectado"; `pill` tem fundo, como "Reserva".
export function StatusBadge({ label, tone = 'neutral', variant = 'dot' }) {
  return <span className={`phone-badge${variant === 'pill' ? ' phone-badge--pill' : ''}${toneClass(tone)}`}>{label}</span>;
}

// `value` vai de 0 a 1; valores fora do intervalo sao limitados.
export function ProgressIndicator({ value, tone = 'primary', label, detail }) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const percent = Math.round(clamped * 100);
  return (
    <div className={`phone-progress${toneClass(tone)}`}>
      {label || detail ? (
        <div className="phone-progress__head">{label ? <strong>{label}</strong> : <span />}{detail ? <span>{detail}</span> : null}</div>
      ) : null}
      <div className="phone-progress__track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="phone-progress__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
