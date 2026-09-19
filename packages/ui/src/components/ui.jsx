// SPDX-License-Identifier: Apache-2.0
// Primitivas de UI compartilhadas pelas views do Cialai: estados de dados,
// badge de status, toasts, modal, drawer, campos de formulário e
// confirmação.
//
// Campos de formulário são controles nativos do navegador: select, input e
// textarea com as classes .field*. No app macOS o WebKit desenha o popup, o
// campo de data e a caixa de seleção como controles do sistema. Diálogos,
// drawer e toasts continuam no MUI, retematizado por plataforma.

import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import {
  Box, Typography, Dialog, DialogTitle, DialogContent, DialogActions,
  Drawer as MuiDrawer, IconButton, Snackbar, Alert, Button,
} from '@mui/material';
import { X, Inbox, AlertCircle } from 'lucide-react';
import { translate } from '../shared/i18n.js';

const isMacPlatform = () => typeof document !== 'undefined' && document.documentElement.dataset.platform === 'macos';

/* ── estados de dados ─────────────────────────────────────────────── */

// Carregando mostra um esqueleto com brilho; vazio e erro mostram um glifo
// com halo suave, a mensagem e, se houver, uma ação.
export function DataState({ type = 'empty', message = '', action = null }) {
  if (type === 'loading') {
    return (
      <div className="mac-state mac-state--loading" role="status" aria-live="polite">
        <div className="mac-skeleton" aria-hidden="true">
          <span className="mac-skeleton__line" style={{ width: '58%' }} />
          <span className="mac-skeleton__line" style={{ width: '92%' }} />
          <span className="mac-skeleton__line" style={{ width: '74%' }} />
        </div>
        {message ? <div className="mac-state__text">{message}</div> : null}
      </div>
    );
  }
  const Icon = type === 'error' ? AlertCircle : Inbox;
  return (
    <div className={`mac-state${type === 'error' ? ' mac-state--error' : ''}`} role={type === 'error' ? 'alert' : undefined}>
      <span className="mac-state__glyph"><Icon aria-hidden="true" /></span>
      {message ? <div className="mac-state__text">{message}</div> : null}
      {action ? <div className="mac-state__action">{action}</div> : null}
    </div>
  );
}

const reducedMotion = () => typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'none');

// Número que conta do valor anterior até o novo em 700 ms, formatado pela
// view. Sem movimento quando o sistema pede menos animação.
export function AnimatedNumber({ value, format = (n) => String(n), duration = 700, className }) {
  const target = Number.isFinite(Number(value)) ? Number(value) : 0;
  const [shown, setShown] = useState(() => (reducedMotion() ? target : 0));
  const fromRef = useRef(reducedMotion() ? target : 0);
  useEffect(() => {
    if (reducedMotion()) { fromRef.current = target; setShown(target); return undefined; }
    const from = fromRef.current;
    const start = performance.now();
    let frame = 0;
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 4);
      const current = from + (target - from) * eased;
      fromRef.current = current;
      setShown(current);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // Sem quadros de animação, como numa janela fora da tela, o valor final
    // entra no lugar assim que a duração passa.
    const guard = setTimeout(() => {
      cancelAnimationFrame(frame);
      fromRef.current = target;
      setShown(target);
    }, duration + 80);
    return () => { cancelAnimationFrame(frame); clearTimeout(guard); };
  }, [target, duration]);
  return <span className={className}>{format(shown)}</span>;
}

/* ── blocos de página: cabeçalho de painel e célula de número ─────── */

// Cabeçalho de um .panel: kicker discreto, título e ações à direita.
export function PanelHead({ kicker, title, sub, trailing, divided = false, className = '' }) {
  return (
    <div className={`panel__head${divided ? ' panel__head--divided' : ''}${className ? ` ${className}` : ''}`}>
      <div style={{ minWidth: 0 }}>
        {kicker ? <div className="panel__kicker">{kicker}</div> : null}
        <div className="panel__title">{title}</div>
        {sub ? <div className="panel__sub">{sub}</div> : null}
      </div>
      {trailing ? <div className="panel__actions">{trailing}</div> : null}
    </div>
  );
}

// Célula de número dentro de uma .stat-strip. tone: ok, warn ou bad.
export function Stat({ label, value, meta, tone, className = '' }) {
  return (
    <div className={`stat${className ? ` ${className}` : ''}`}>
      <div className="stat__label">{label}</div>
      <div className={`stat__value${tone ? ` stat__value--${tone}` : ''}`}>{value}</div>
      {meta ? <div className="stat__meta">{meta}</div> : null}
    </div>
  );
}

/* ── toasts ───────────────────────────────────────────────────────── */

const ToastContext = createContext(() => {});

export function ToastProvider({ children }) {
  const [item, setItem] = useState(null);
  const notify = useCallback((message, type = 'info') => {
    setItem({ message, type: ['success', 'warning', 'danger', 'info'].includes(type) ? type : 'info', key: Date.now() });
  }, []);
  const severity = item?.type === 'danger' ? 'error' : item?.type || 'info';
  const anchor = isMacPlatform() ? { vertical: 'top', horizontal: 'right' } : { vertical: 'bottom', horizontal: 'right' };
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <Snackbar key={item?.key} open={Boolean(item)} autoHideDuration={3500} onClose={() => setItem(null)} anchorOrigin={anchor}>
        {item ? <Alert severity={severity} variant="outlined" onClose={() => setItem(null)} sx={{ bgcolor: 'background.paper', borderColor: 'divider', color: 'text.primary', boxShadow: 'var(--mac-shadow-popover)' }}>{item.message}</Alert> : <span />}
      </Snackbar>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/* ── modal e drawer ───────────────────────────────────────────────── */

// Largura de cada tamanho de modal, em pixels. `fullWidth` do MUI esticava o
// papel ate o ponto de quebra inteiro, entao o diálogo de vincular celular
// nascia com 900 px e afastava o texto do QR, e Preferências chegava a ocupar
// quase toda a janela. Aqui cada tamanho tem a largura que o conteúdo pede, e
// o papel encolhe sozinho em janela estreita.
export const MODAL_WIDTH = Object.freeze({ xs: 400, sm: 520, md: 700, lg: 880 });
// Teto de altura do papel. Abaixo disto o corpo rola por dentro, e a folha
// nunca cobre a janela de ponta a ponta.
export const MODAL_MAX_HEIGHT = 'min(660px, calc(100% - 96px))';

// Estilo do papel de um diálogo do estúdio. A folha do celular, em
// mobile.css, sobrepoe largura e margem com `!important`, entao a mesma
// função serve as duas plataformas.
export function modalPaperSx({ maxWidth = 'sm', width, maxHeight } = {}) {
  return {
    width: width ?? MODAL_WIDTH[maxWidth] ?? MODAL_WIDTH.sm,
    maxWidth: 'calc(100vw - 48px)',
    maxHeight: maxHeight ?? MODAL_MAX_HEIGHT,
  };
}

export function AppModal({ open, title, onClose, children, footer, maxWidth = 'sm', width, maxHeight }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={false}
      // O corpo do app nunca rola: a trava de rolagem do MUI só teria como
      // efeito mexer no `padding` do `body` e mudar a largura do conteúdo
      // atrás do modal.
      disableScrollLock
      PaperProps={{ sx: modalPaperSx({ maxWidth, width, maxHeight }) }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.5, fontWeight: 600 }}>
        {title}
        <IconButton size="small" onClick={onClose} aria-label={translate('shared.action.close')}><X size={16} /></IconButton>
      </DialogTitle>
      <DialogContent dividers>{children}</DialogContent>
      {footer ? <DialogActions>{footer}</DialogActions> : null}
    </Dialog>
  );
}

export function AppDrawer({ open, title, onClose, children, width = 480 }) {
  return (
    <MuiDrawer anchor="right" open={open} onClose={onClose}>
      <Box sx={{ width, maxWidth: '94vw', display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2.5, py: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>{title}</Typography>
          <IconButton size="small" onClick={onClose} aria-label={translate('shared.action.close')}><X size={16} /></IconButton>
        </Box>
        <Box sx={{ p: 2.5, overflowY: 'auto', flex: 1 }}>{children}</Box>
      </Box>
    </MuiDrawer>
  );
}

/* ── campos de formulário nativos ─────────────────────────────────── */

// Converte o subconjunto de sx que as views usam em estilo inline.
function sxToStyle(sx) {
  if (!sx || typeof sx !== 'object') return undefined;
  const spacing = (value) => (typeof value === 'number' ? `${value * 8}px` : value);
  const style = {};
  const direct = ['minWidth', 'width', 'maxWidth', 'flex', 'flexGrow', 'flexBasis', 'gridColumn', 'alignSelf', 'justifySelf'];
  direct.forEach((key) => { if (sx[key] !== undefined) style[key] = sx[key]; });
  if (sx.m !== undefined) style.margin = spacing(sx.m);
  if (sx.mt !== undefined) style.marginTop = spacing(sx.mt);
  if (sx.mb !== undefined) style.marginBottom = spacing(sx.mb);
  if (sx.ml !== undefined) style.marginLeft = spacing(sx.ml);
  if (sx.mr !== undefined) style.marginRight = spacing(sx.mr);
  return Object.keys(style).length ? style : undefined;
}

export function Field({ label, htmlFor, fullWidth = false, className = '', style, children }) {
  return (
    <div className={`field${fullWidth ? ' field--full' : ''}${className ? ` ${className}` : ''}`} style={style}>
      {label ? <label className="field__label" htmlFor={htmlFor}>{label}</label> : null}
      {children}
    </div>
  );
}

export function SelectField({ label, value, onChange, options = [], placeholder, fullWidth = false, disabled = false, sx, className = '', style }) {
  const id = useId();
  const normalized = options.map((option) => (typeof option === 'string' ? { value: option, label: option } : option));
  const current = value === undefined || value === null ? '' : String(value);
  const handleChange = (event) => {
    const raw = event.target.value;
    const match = normalized.find((option) => String(option.value) === raw);
    onChange(match ? match.value : raw);
  };
  return (
    <Field label={label} htmlFor={id} fullWidth={fullWidth} className={className} style={{ ...sxToStyle(sx), ...style }}>
      <select id={id} className="field__control field__control--select" value={current} onChange={handleChange} disabled={disabled}>
        {placeholder ? <option value="">{placeholder}</option> : null}
        {normalized.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
        ))}
      </select>
    </Field>
  );
}

export function DateField({ label, value, onChange, fullWidth = false, disabled = false, min, max, sx, className = '', style }) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} fullWidth={fullWidth} className={className} style={{ ...sxToStyle(sx), ...style }}>
      <input
        id={id}
        type="date"
        className="field__control"
        value={value || ''}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

// Compatível com o subconjunto do TextField do MUI que as views usam:
// label, placeholder, value, onChange(event), onBlur, type, fullWidth,
// multiline, minRows, inputProps, InputProps.readOnly, disabled.
export function TextField({
  label, placeholder, value, onChange, onBlur, type = 'text', fullWidth = false, multiline = false,
  minRows = 3, inputProps = {}, InputProps = {}, disabled = false, readOnly = false, sx, className = '', style,
  size: _size, InputLabelProps: _labelProps, ...rest
}) {
  const id = useId();
  const shared = {
    id,
    value: value ?? '',
    placeholder,
    onChange,
    onBlur,
    disabled,
    readOnly: readOnly || Boolean(InputProps.readOnly),
    ...inputProps,
    ...rest,
  };
  return (
    <Field label={label} htmlFor={id} fullWidth={fullWidth} className={className} style={{ ...sxToStyle(sx), ...style }}>
      {multiline
        ? <textarea className="field__control field__control--area" rows={minRows} {...shared} />
        : <input type={type} className="field__control" {...shared} />}
    </Field>
  );
}

/* ── utilitário de confirmação ────────────────────────────────────── */

export function ConfirmDialog({ open, title = translate('shared.action.confirm'), message, onCancel, onConfirm, confirmLabel = translate('shared.action.confirm'), danger = false }) {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth={false} disableScrollLock PaperProps={{ sx: modalPaperSx({ maxWidth: 'xs' }) }}>
      <DialogTitle sx={{ fontWeight: 600 }}>{title}</DialogTitle>
      <DialogContent><Typography variant="body2">{message}</Typography></DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>{translate('shared.action.cancel')}</Button>
        <Button variant="contained" color={danger ? 'error' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
      </DialogActions>
    </Dialog>
  );
}
