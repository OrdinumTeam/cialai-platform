// SPDX-License-Identifier: Apache-2.0
// Dialogos do estudio sobre o MUI retematizado: encerrar uma sessao com
// processo ativo, fechar uma aba com alteracoes, resolver um arquivo que
// mudou no disco e excluir um item do explorador.

import React, { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';

function Sheet({ open, title, children, actions, onClose }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
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
  let message = 'A sessão será encerrada e o histórico do terminal deixará de existir.';
  if (running) message = `${running} está em execução nesta sessão. Encerrar interrompe o trabalho em andamento.`;
  if (dirty) message += ` ${dirty === 1 ? 'Há um arquivo com alterações não salvas.' : `Há ${dirty} arquivos com alterações não salvas.`}`;
  return (
    <Sheet
      open={open}
      title={request?.name ? `Encerrar ${request.name}` : 'Encerrar sessão'}
      onClose={onCancel}
      actions={(
        <>
          <Button onClick={onCancel}>Cancelar</Button>
          <Button variant="contained" color="error" onClick={onConfirm}>Encerrar</Button>
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
      title="Alterações não salvas"
      onClose={onCancel}
      actions={(
        <>
          <Button onClick={onCancel}>Cancelar</Button>
          <Button color="error" onClick={onDiscard}>Descartar</Button>
          <Button variant="contained" onClick={onSave}>Salvar</Button>
        </>
      )}
    >
      {request ? `${request.name} tem alterações que ainda não foram salvas.` : ''}
    </Sheet>
  );
}

// O arquivo mudou no disco enquanto era editado.
export function ConflictDialog({ request, onCancel, onReload, onOverwrite }) {
  const deleted = request?.conflict === 'deleted';
  return (
    <Sheet
      open={Boolean(request)}
      title={deleted ? 'O arquivo foi removido do disco' : 'O arquivo mudou no disco'}
      onClose={onCancel}
      actions={(
        <>
          <Button onClick={onCancel}>Cancelar</Button>
          {!deleted ? <Button color="error" onClick={onReload}>Recarregar do disco</Button> : null}
          <Button variant="contained" onClick={onOverwrite}>{deleted ? 'Salvar de novo' : 'Sobrescrever'}</Button>
        </>
      )}
    >
      {deleted
        ? `${request?.name || 'O arquivo'} não existe mais no disco. Salvar de novo recria o arquivo com o conteúdo do editor.`
        : `${request?.name || 'O arquivo'} foi alterado por outro programa. Sobrescrever descarta a versão do disco; recarregar descarta o que está no editor.`}
    </Sheet>
  );
}

export function DeleteDialog({ request, onCancel, onConfirm }) {
  const isDir = request?.kind === 'dir';
  return (
    <Sheet
      open={Boolean(request)}
      title={isDir ? 'Mover pasta para a Lixeira' : 'Mover arquivo para a Lixeira'}
      onClose={onCancel}
      actions={(
        <>
          <Button onClick={onCancel}>Cancelar</Button>
          <Button variant="contained" color="error" onClick={onConfirm}>Mover para a Lixeira</Button>
        </>
      )}
    >
      {request ? `${request.name}${isDir ? ' e tudo que está dentro' : ''} vai para a Lixeira do macOS.` : ''}
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
      title={request?.title || 'Nome'}
      onClose={onCancel}
      actions={(
        <>
          <Button onClick={onCancel}>Cancelar</Button>
          <Button variant="contained" onClick={submit} disabled={Boolean(request?.required) && !value.trim()}>{request?.confirmLabel || 'Salvar'}</Button>
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
          aria-label={request?.title || 'Nome'}
        />
      </div>
    </Sheet>
  );
}
