// SPDX-License-Identifier: Apache-2.0
// Dialogos do estudio sobre o MUI retematizado: encerrar uma sessao com
// processo ativo, fechar uma aba com alteracoes, resolver um arquivo que
// mudou no disco e excluir um item do explorador.

import React, { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { modalPaperProps } from '../../components/ui.jsx';
import { getLocale, translate } from '../../shared/i18n.js';

// Folha reaproveitada pelos diálogos do estúdio e pelo menu de ações do
// celular: o mesmo MUI retematizado, com título, conteúdo e ações. A largura
// vem do tamanho pedido, não do ponto de quebra inteiro, e o corpo rola por
// dentro quando o conteúdo passa do teto de altura.
export function Sheet({ open, title, children, actions, onClose, size = 'xs' }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth={false} disableScrollLock PaperProps={modalPaperProps({ maxWidth: size })}>
      <DialogTitle sx={{ fontWeight: 600 }}>{title}</DialogTitle>
      <DialogContent>{typeof children === 'string' ? <Typography variant="body2">{children}</Typography> : children}</DialogContent>
      <DialogActions>{actions}</DialogActions>
    </Dialog>
  );
}

// Encerrar sessao: menciona o processo que esta rodando para a decisao ser
// contextual, e diferencia de reiniciar e de selecionar.
export function CloseSessionDialog({ request, onCancel, onConfirm }) {
  const open = Boolean(request);
  const running = request?.running || null;
  const dirty = request?.dirtyTabs || 0;
  let message = translate('terminal.dialog.closeDescription');
  if (running) message = translate('terminal.dialog.closeRunning', { running });
  if (dirty) message += ` ${translate(dirty === 1 ? 'terminal.dialog.oneDirty' : 'terminal.dialog.manyDirty', { count: dirty.toLocaleString(getLocale()) })}`;
  return (
    <Sheet
      open={open}
      title={translate(request?.name ? 'terminal.dialog.closeNamed' : 'terminal.dialog.closeSession', { name: request?.name })}
      onClose={onCancel}
      actions={(
        <>
          <Button onClick={onCancel}>{translate('terminal.common.cancel')}</Button>
          <Button variant="contained" color="error" onClick={onConfirm}>{translate('terminal.dialog.closeSession')}</Button>
        </>
      )}
    >
      {message}
    </Sheet>
  );
}

// Fechar aba com alteracoes: salvar, descartar ou cancelar.
export function UnsavedDialog({ request, onCancel, onDiscard, onSave }) {
  return (
    <Sheet
      open={Boolean(request)}
      title={translate('terminal.dialog.unsavedTitle')}
      onClose={onCancel}
      actions={(
        <>
          <Button onClick={onCancel}>{translate('terminal.common.cancel')}</Button>
          <Button color="error" onClick={onDiscard}>{translate('terminal.dialog.discard')}</Button>
          <Button variant="contained" onClick={onSave}>{translate('terminal.common.save')}</Button>
        </>
      )}
    >
      {request ? translate('terminal.dialog.unsavedDescription', { name: request.name }) : ''}
    </Sheet>
  );
}

// O arquivo mudou no disco enquanto era editado.
export function ConflictDialog({ request, onCancel, onReload, onOverwrite }) {
  const deleted = request?.conflict === 'deleted';
  return (
    <Sheet
      open={Boolean(request)}
      title={translate(deleted ? 'terminal.dialog.deletedTitle' : 'terminal.dialog.changedTitle')}
      onClose={onCancel}
      actions={(
        <>
          <Button onClick={onCancel}>{translate('terminal.common.cancel')}</Button>
          {!deleted ? <Button color="error" onClick={onReload}>{translate('terminal.editor.reloadDisk')}</Button> : null}
          <Button variant="contained" onClick={onOverwrite}>{translate(deleted ? 'terminal.editor.saveAgain' : 'terminal.editor.overwrite')}</Button>
        </>
      )}
    >
      {deleted
        ? translate('terminal.dialog.deletedDescription', { name: request?.name || translate('terminal.dialog.fileFallback') })
        : translate('terminal.dialog.changedDescription', { name: request?.name || translate('terminal.dialog.fileFallback') })}
    </Sheet>
  );
}

export function DeleteDialog({ request, onCancel, onConfirm }) {
  const isDir = request?.kind === 'dir';
  return (
    <Sheet
      open={Boolean(request)}
      title={translate(isDir ? 'terminal.dialog.trashFolderTitle' : 'terminal.dialog.trashFileTitle')}
      onClose={onCancel}
      actions={(
        <>
          <Button onClick={onCancel}>{translate('terminal.common.cancel')}</Button>
          <Button variant="contained" color="error" onClick={onConfirm}>{translate('terminal.dialog.moveTrash')}</Button>
        </>
      )}
    >
      {request ? translate(isDir ? 'terminal.dialog.trashFolderDescription' : 'terminal.dialog.trashFileDescription', { name: request.name }) : ''}
    </Sheet>
  );
}

// Nome de sessao, novo arquivo ou nova pasta.
export function NameDialog({ request, onCancel, onConfirm }) {
  const [value, setValue] = useState('');
  const inputRef = useRef(null);
  useEffect(() => {
    if (!request) return undefined;
    setValue(request.initial || '');
    const timer = setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 60);
    return () => clearTimeout(timer);
  }, [request]);
  const submit = () => {
    const next = value.trim();
    if (request?.required && !next) return;
    onConfirm(next);
  };
  return (
    <Sheet
      open={Boolean(request)}
      title={request?.title || translate('terminal.common.name')}
      onClose={onCancel}
      actions={(
        <>
          <Button onClick={onCancel}>{translate('terminal.common.cancel')}</Button>
          <Button variant="contained" onClick={submit} disabled={Boolean(request?.required) && !value.trim()}>{request?.confirmLabel || translate('terminal.common.save')}</Button>
        </>
      )}
    >
      <div className="field field--full">
        {request?.description ? <div className="terminais-dialog__hint">{request.description}</div> : null}
        <input
          ref={inputRef}
          className="field__control"
          value={value}
          placeholder={request?.placeholder || ''}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          aria-label={request?.title || translate('terminal.common.name')}
        />
      </div>
    </Sheet>
  );
}
