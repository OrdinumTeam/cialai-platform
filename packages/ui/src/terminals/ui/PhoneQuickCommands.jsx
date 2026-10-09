// SPDX-License-Identifier: Apache-2.0
// Comandos rápidos do terminal do celular, separados do teclado especial.
//
// A lista nunca executa nada: tocar num comando abre a prévia com o texto que
// vai ao terminal, e só ali há Inserir, que escreve e para, e Executar, que
// escreve e manda o Enter. Comando destrutivo, ou marcado para pedir
// confirmação, precisa de um segundo toque em Executar. Cadastrar, editar,
// remover e reordenar ficam em Gerenciar; o formulário recusa texto que
// pareça senha ou token. As regras estão em `quick-commands.js`.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, CornerDownLeft, Pencil, Play, Plus, Search, Settings2, Terminal, Trash2, TriangleAlert, X } from 'lucide-react';
import {
  confirmsBefore, filterCommands, isDestructive, moveCommand, needsConfirmation, quickCommandsStorage, readCommands, removeCommand, saveCommand, writeCommands,
} from '../quick-commands.js';
import { translate } from '../../shared/i18n.js';

// A descrição dos exemplos iniciais é uma chave de tradução; a dos comandos
// cadastrados é o texto da pessoa.
export function describeCommand(entry) {
  const text = entry?.description || '';
  return text.startsWith('terminal.phone.quick.seed.') ? translate(text) : text;
}

const titleOf = (entry) => entry.label || entry.command;

export function Preview({ entry, interactive, onInsert, onRun }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirm = needsConfirmation(entry);
  const destructive = isDestructive(entry.command);
  const deliver = async (enter) => {
    if (busy) return;
    if (confirmsBefore(entry, enter) && !confirming) { setConfirming(true); return; }
    setBusy(true);
    try { await (enter ? onRun(entry.command) : onInsert(entry.command)); }
    finally { setBusy(false); }
  };
  return (
    <div className="phone-quick__preview">
      <p className="phone-quick__preview-title">{titleOf(entry)}</p>
      {describeCommand(entry) ? <p className="phone-quick__preview-description">{describeCommand(entry)}</p> : null}
      <pre className="phone-quick__code" aria-label={translate('terminal.phone.quick.previewLabel')}>{entry.command}</pre>
      {confirm ? (
        <p className={`phone-quick__warning${confirming ? ' is-confirming' : ''}`} role={confirming ? 'alert' : undefined}>
          <TriangleAlert size={16} aria-hidden="true" />
          {translate(destructive ? 'terminal.phone.quick.destructive' : 'terminal.phone.quick.confirmNeeded')}
        </p>
      ) : null}
      <div className="phone-quick__actions">
        <button type="button" className="phone-quick__action" disabled={!interactive || busy} onClick={() => deliver(false)}>
          <CornerDownLeft size={18} aria-hidden="true" />{translate('terminal.phone.quick.insert')}
        </button>
        <button type="button" className={`phone-quick__action ${confirming ? 'phone-quick__action--danger' : 'phone-quick__action--primary'}`} disabled={!interactive || busy} onClick={() => deliver(true)}>
          <Play size={18} aria-hidden="true" />{translate(confirming ? 'terminal.phone.quick.runAnyway' : 'terminal.phone.quick.run')}
        </button>
      </div>
    </div>
  );
}

export function Editor({ entry, onCancel, onSave }) {
  const [label, setLabel] = useState(entry?.label || '');
  const [command, setCommand] = useState(entry?.command || '');
  const initialDescription = describeCommand(entry);
  const [description, setDescription] = useState(initialDescription);
  const [confirm, setConfirm] = useState(Boolean(entry?.confirm));
  const [error, setError] = useState(null);
  const submit = (event) => {
    event.preventDefault();
    // Um exemplo editado sem mexer na descrição continua traduzido.
    const keptDescription = entry && description === initialDescription ? entry.description : description;
    const result = onSave({ id: entry?.id, label, command, description: keptDescription, confirm });
    if (result?.error) setError(result.error);
  };
  return (
    <form className="phone-quick__form" onSubmit={submit} noValidate>
      <label className="phone-quick__field">
        <span>{translate('terminal.phone.quick.field.command')}</span>
        <textarea value={command} rows={2} required autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => { setCommand(event.target.value); setError(null); }} />
      </label>
      <label className="phone-quick__field">
        <span>{translate('terminal.phone.quick.field.label')}</span>
        <input value={label} placeholder={command.trim() || translate('terminal.phone.quick.field.labelPlaceholder')} onChange={(event) => { setLabel(event.target.value); setError(null); }} />
      </label>
      <label className="phone-quick__field">
        <span>{translate('terminal.phone.quick.field.description')}</span>
        <input value={description} onChange={(event) => { setDescription(event.target.value); setError(null); }} />
      </label>
      <label className="phone-quick__check">
        <input type="checkbox" checked={confirm || isDestructive(command)} disabled={isDestructive(command)} onChange={(event) => setConfirm(event.target.checked)} />
        <span>{translate('terminal.phone.quick.field.confirm')}</span>
      </label>
      <p className="phone-quick__note">{translate('terminal.phone.quick.noSecrets')}</p>
      {error ? <p className="phone-quick__error" role="alert">{translate(error)}</p> : null}
      <div className="phone-quick__actions">
        <button type="button" className="phone-quick__action" onClick={onCancel}>{translate('terminal.common.cancel')}</button>
        <button type="submit" className="phone-quick__action phone-quick__action--primary" disabled={!command.trim()}>{translate('terminal.common.save')}</button>
      </div>
    </form>
  );
}

export function Manager({ commands, onEdit, onAdd, onMove, onRemove }) {
  const [removing, setRemoving] = useState(null);
  return (
    <div className="phone-quick__manage">
      <ul className="phone-quick__list">
        {commands.map((entry, index) => (
          <li key={entry.id} className="phone-quick__row">
            <Terminal size={18} className="phone-quick__row-icon" aria-hidden="true" />
            <span className="phone-quick__row-text">{titleOf(entry)}</span>
            {removing === entry.id ? <>
              <button type="button" className="phone-quick__mini" onClick={() => setRemoving(null)}>{translate('terminal.common.cancel')}</button>
              <button type="button" className="phone-quick__mini phone-quick__mini--danger" onClick={() => { setRemoving(null); onRemove(entry.id); }}>{translate('terminal.phone.quick.remove')}</button>
            </> : <>
              <button type="button" className="phone-quick__icon" disabled={index === 0} aria-label={translate('terminal.phone.quick.moveUp', { name: titleOf(entry) })} onClick={() => onMove(entry.id, -1)}><ArrowUp size={18} aria-hidden="true" /></button>
              <button type="button" className="phone-quick__icon" disabled={index === commands.length - 1} aria-label={translate('terminal.phone.quick.moveDown', { name: titleOf(entry) })} onClick={() => onMove(entry.id, 1)}><ArrowDown size={18} aria-hidden="true" /></button>
              <button type="button" className="phone-quick__icon" aria-label={translate('terminal.phone.quick.edit', { name: titleOf(entry) })} onClick={() => onEdit(entry)}><Pencil size={18} aria-hidden="true" /></button>
              <button type="button" className="phone-quick__icon phone-quick__icon--danger" aria-label={translate('terminal.phone.quick.removeNamed', { name: titleOf(entry) })} onClick={() => setRemoving(entry.id)}><Trash2 size={18} aria-hidden="true" /></button>
            </>}
          </li>
        ))}
      </ul>
      {!commands.length ? <p className="phone-quick__empty">{translate('terminal.phone.quick.empty')}</p> : null}
      <button type="button" className="phone-quick__add" onClick={onAdd}><Plus size={18} aria-hidden="true" />{translate('terminal.phone.quick.add')}</button>
    </div>
  );
}

export default function PhoneQuickCommands({
  open,
  interactive = true,
  onInsert,
  onRun,
  onClose,
  storage = quickCommandsStorage(),
}) {
  const [commands, setCommands] = useState(() => readCommands(storage));
  const [query, setQuery] = useState('');
  // `list`, `preview`, `manage` ou `edit`; `entry` é o comando da prévia ou
  // do formulário, `null` num cadastro novo.
  const [view, setView] = useState({ name: 'list', entry: null });
  const search = useRef(null);

  useEffect(() => {
    if (!open) return;
    setCommands(readCommands(storage));
    setQuery('');
    setView({ name: 'list', entry: null });
  }, [open, storage]);

  const visible = useMemo(() => filterCommands(commands, query, describeCommand), [commands, query]);
  if (!open) return null;

  const commit = (next) => setCommands(writeCommands(storage, next));
  const close = () => { search.current?.blur(); onClose(); };
  const back = view.name === 'edit' ? { name: 'manage', entry: null } : { name: 'list', entry: null };
  const title = view.name === 'manage' ? 'terminal.phone.quick.manage'
    : view.name === 'edit' ? (view.entry ? 'terminal.phone.quick.editTitle' : 'terminal.phone.quick.addTitle')
      : 'terminal.phone.quick.title';

  const deliver = async (run, command) => {
    const sent = await run(command);
    if (sent) close();
    return sent;
  };

  return <>
    <div className="phone-quick__backdrop" aria-hidden="true" onClick={close} />
    <section className="phone-quick" role="dialog" aria-modal="true" aria-label={translate(title)}>
      <span className="phone-keys__grabber" aria-hidden="true" />
      <div className="phone-keys__head">
        {view.name !== 'list' ? <button type="button" className="phone-keys__icon" aria-label={translate('terminal.phone.keys.back')} onClick={() => setView(back)}><ChevronLeft size={22} aria-hidden="true" /></button> : null}
        <h2>{translate(title)}</h2>
        <button type="button" className="phone-keys__icon" aria-label={translate('terminal.phone.composer.close')} onClick={close}><X size={22} aria-hidden="true" /></button>
      </div>
      <div className="phone-quick__body">
        {view.name === 'list' ? <>
          <label className="phone-quick__search">
            <Search size={18} aria-hidden="true" />
            <input ref={search} type="search" value={query} placeholder={translate('terminal.phone.quick.searchPlaceholder')} aria-label={translate('terminal.phone.quick.search')} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <ul className="phone-quick__list">
            {visible.map((entry) => (
              <li key={entry.id}>
                <button type="button" className="phone-quick__item" onClick={() => setView({ name: 'preview', entry })}>
                  <span className={`phone-quick__item-icon${needsConfirmation(entry) ? ' is-danger' : ''}`} aria-hidden="true">{needsConfirmation(entry) ? <TriangleAlert size={18} /> : <Terminal size={18} />}</span>
                  <span className="phone-quick__item-text">
                    <span className="phone-quick__item-title">{titleOf(entry)}</span>
                    {describeCommand(entry) ? <span className="phone-quick__item-description">{describeCommand(entry)}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!visible.length ? <p className="phone-quick__empty">{translate(commands.length ? 'terminal.phone.quick.noMatch' : 'terminal.phone.quick.empty')}</p> : null}
          <button type="button" className="phone-quick__manage-link" onClick={() => setView({ name: 'manage', entry: null })}><Settings2 size={18} aria-hidden="true" />{translate('terminal.phone.quick.manage')}</button>
        </> : null}
        {view.name === 'preview' ? (
          <Preview
            entry={view.entry}
            interactive={interactive}
            onInsert={(command) => deliver(onInsert, command)}
            onRun={(command) => deliver(onRun, command)}
          />
        ) : null}
        {view.name === 'manage' ? (
          <Manager
            commands={commands}
            onAdd={() => setView({ name: 'edit', entry: null })}
            onEdit={(entry) => setView({ name: 'edit', entry })}
            onMove={(id, delta) => commit(moveCommand(commands, id, delta))}
            onRemove={(id) => commit(removeCommand(commands, id))}
          />
        ) : null}
        {view.name === 'edit' ? (
          <Editor
            entry={view.entry}
            onCancel={() => setView({ name: 'manage', entry: null })}
            onSave={(entry) => {
              const result = saveCommand(commands, entry);
              if (result.error) return result;
              commit(result.commands);
              setView({ name: 'manage', entry: null });
              return result;
            }}
          />
        ) : null}
      </div>
    </section>
  </>;
}
