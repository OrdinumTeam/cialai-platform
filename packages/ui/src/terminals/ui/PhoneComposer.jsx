// SPDX-License-Identifier: Apache-2.0
// Caixa de texto do celular, aberta por um balão flutuante sobre o terminal.
//
// Digitar direto no terminal pelo celular é desconfortável e um Enter sem
// querer executa o que ainda estava sendo escrito. Aqui o texto é escrito e
// revisado num `textarea` do próprio aparelho, com o teclado, a seleção, o
// copiar e colar, a autocorreção e o ditado nativos, e só vai ao terminal por
// uma ação explícita.
//
// Duas ações separadas, decisão de 18/09/2026. Inserir escreve o texto e para
// ali. Enviar escreve o texto e, depois de confirmada a escrita, manda o Enter
// numa segunda escrita. Dentro da caixa, Enter sempre quebra linha.
import React, { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Eraser, Send, X } from 'lucide-react';
import { translate } from '../../shared/i18n.js';

// Altura máxima da caixa, em fração da tela. Acima disto o terminal atrás
// desaparece e a revisão perde o contexto.
const MAX_HEIGHT_RATIO = 0.4;
// Menos que isto o iOS amplia a página inteira ao focar o campo.
const MIN_FONT_PX = 16;

const draftKey = (sessionId) => `cialai_composer_${sessionId}`;

export function readDraft(sessionId, storage) {
  try {
    return storage?.getItem(draftKey(sessionId)) || '';
  } catch (_error) {
    return '';
  }
}

export function writeDraft(sessionId, value, storage) {
  try {
    if (value) storage?.setItem(draftKey(sessionId), value);
    else storage?.removeItem(draftKey(sessionId));
  } catch (_error) {
    // A WebView pode negar o armazenamento; o rascunho em memória continua.
  }
}

export function countLines(value) {
  return value ? value.split('\n').length : 0;
}

// Texto de mais de uma linha num terminal sem colagem entre colchetes executa
// linha por linha. Só nesse caso a caixa pede uma segunda confirmação.
export function needsBracketWarning(value, bracketed) {
  return countLines(value) > 1 && !bracketed;
}

export default function PhoneComposer({
  open,
  sessionId,
  interactive = true,
  bracketed = false,
  onSubmit,
  onClose,
  storage = typeof window !== 'undefined' ? window.sessionStorage : null,
}) {
  const [value, setValue] = useState('');
  const [warning, setWarning] = useState(null);
  const [busy, setBusy] = useState(false);
  const area = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setValue(readDraft(sessionId, storage));
    setWarning(null);
    const timer = setTimeout(() => { area.current?.focus(); }, 60);
    return () => clearTimeout(timer);
  }, [open, sessionId, storage]);

  // Altura acompanha o conteúdo até o teto.
  useEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = 'auto';
    const ceiling = Math.round((typeof window !== 'undefined' ? window.innerHeight : 800) * MAX_HEIGHT_RATIO);
    node.style.height = `${Math.min(node.scrollHeight, ceiling)}px`;
  }, [value, open]);

  if (!open) return null;

  const lines = countLines(value);
  const empty = !value.trim();

  const deliver = async (enter) => {
    if (empty || busy) return;
    if (needsBracketWarning(value, bracketed) && warning !== enter) {
      setWarning(enter);
      return;
    }
    setBusy(true);
    try {
      const sent = await onSubmit(value, { enter });
      if (!sent) return;
      setValue('');
      setWarning(null);
      writeDraft(sessionId, '', storage);
    } finally {
      setBusy(false);
    }
  };

  const change = (next) => {
    setValue(next);
    setWarning(null);
    writeDraft(sessionId, next, storage);
  };

  return (
    <div className="phone-composer" role="dialog" aria-label={translate('terminal.phone.composer.title')}>
      <div className="phone-composer__head">
        <span className="phone-composer__title">{translate('terminal.phone.composer.title')}</span>
        <span className="phone-composer__count">{translate(lines === 1 ? 'terminal.phone.composer.lineOne' : 'terminal.phone.composer.lineMany', { count: lines })}</span>
        <button type="button" className="phone-composer__close" aria-label={translate('terminal.phone.composer.close')} onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <textarea
        ref={area}
        className="phone-composer__area"
        value={value}
        onChange={(event) => change(event.target.value)}
        // Enter nunca envia: dentro da caixa ele é edição, e quebra linha.
        onKeyDown={(event) => { if (event.key === 'Enter') event.stopPropagation(); }}
        placeholder={translate('terminal.phone.composer.placeholder')}
        aria-label={translate('terminal.phone.composer.title')}
        enterKeyHint="enter"
        rows={3}
        spellCheck
        autoCorrect="on"
        autoCapitalize="sentences"
        style={{ fontSize: `${MIN_FONT_PX}px` }}
      />
      {warning != null ? (
        <p className="phone-composer__warning" role="alert">
          {translate('terminal.phone.composer.bracketWarning')}
        </p>
      ) : null}
      <div className="phone-composer__actions">
        <button type="button" className="phone-composer__action" disabled={empty || busy} onClick={() => change('')}>
          <Eraser size={18} aria-hidden="true" />{translate('terminal.phone.composer.clear')}
        </button>
        <button type="button" className="phone-composer__action" disabled={empty || busy || !interactive} onClick={() => deliver(false)}>
          <CornerDownLeft size={18} aria-hidden="true" />{translate(warning === false ? 'terminal.phone.composer.insertAnyway' : 'terminal.phone.composer.insert')}
        </button>
        <button type="button" className="phone-composer__action phone-composer__action--primary" disabled={empty || busy || !interactive} onClick={() => deliver(true)}>
          <Send size={18} aria-hidden="true" />{translate(warning === true ? 'terminal.phone.composer.sendAnyway' : 'terminal.phone.composer.send')}
        </button>
      </div>
    </div>
  );
}
