// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, File, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { invoke } from '../../lib/native.js';

// The server derives the allowed root from the PTY. Never send a client root.
export default function PhoneFiles({ session, path, preview, onPreview }) {
  const [nodes, setNodes] = useState({});
  const [expanded, setExpanded] = useState(new Set(['']));
  const [revision, setRevision] = useState(0);
  const [file, setFile] = useState(null);
  const generation = useRef(0);
  useEffect(() => {
    const token = ++generation.current;
    setNodes({});
    invoke('pty_files_list', { id: session.ptyId, path: '' }).then(value => {
      if (token === generation.current) setNodes({ '': { value } });
    }).catch(error => { if (token === generation.current) setNodes({ '': { error: error.message } }); });
    return () => { generation.current += 1; };
  }, [session.ptyId, revision]);
  useEffect(() => {
    if (!preview) return undefined;
    let active = true;
    setFile(null);
    invoke('pty_file_read', { id: session.ptyId, path }).then(value => {
      if (active) setFile({ ...value, path });
    }).catch(error => { if (active) setFile({ error: error.message, path }); });
    return () => { active = false; };
  }, [session.ptyId, path, preview]);
  async function toggle(entry) {
    const next = new Set(expanded);
    if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path);
    setExpanded(next);
    if (!next.has(entry.path) || nodes[entry.path]?.value || nodes[entry.path]?.loading) return;
    const token = generation.current;
    setNodes(current => ({ ...current, [entry.path]: { loading: true } }));
    try {
      const value = await invoke('pty_files_list', { id: session.ptyId, path: entry.path });
      if (token === generation.current) setNodes(current => ({ ...current, [entry.path]: { value } }));
    } catch (error) { if (token === generation.current) setNodes(current => ({ ...current, [entry.path]: { error: error.message } })); }
  }
  function branch(parent, depth = 0) {
    const node = nodes[parent];
    if (!node || node.loading) return <p className="phone-files__message" role="status">Carregando arquivos…</p>;
    if (node.error) return <p className="phone-files__message" role="status">{node.error}</p>;
    return <ul className="phone-files__branch">
      {node.value.entries.map(entry => <li key={entry.path}>
        <button type="button" className="phone-files__entry" style={{ '--depth': Math.min(depth, 6) }} aria-expanded={entry.kind === 'dir' ? expanded.has(entry.path) : undefined} onClick={() => entry.kind === 'dir' ? toggle(entry) : onPreview(entry.path)}>
          {entry.kind === 'dir' ? expanded.has(entry.path) ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" /> : <span className="phone-files__spacer" />}
          {entry.kind === 'dir' ? expanded.has(entry.path) ? <FolderOpen size={17} aria-hidden="true" /> : <Folder size={17} aria-hidden="true" /> : <File size={17} aria-hidden="true" />}
          <span>{entry.name}</span>
        </button>
        {entry.kind === 'dir' && expanded.has(entry.path) && branch(entry.path, depth + 1)}
      </li>)}
      {!node.value.entries.length && <li className="phone-files__message">Pasta vazia ou sem arquivos disponíveis para consulta.</li>}
      {node.value.truncated && <li className="phone-files__message">Exibindo os primeiros 200 itens.</li>}
    </ul>;
  }
  const currentFile = file?.path === path ? file : null;
  return <section className="phone-files" aria-label={preview ? 'Prévia do arquivo' : 'Arquivos do diretório'}>
    <div className="phone-files__bar"><span><Eye size={14} aria-hidden="true" />Somente leitura</span>{!preview && <button type="button" className="mac-tool" aria-label="Atualizar arquivos" onClick={() => { setExpanded(new Set([''])); setRevision(value => value + 1); }}><RefreshCw size={17} /></button>}</div>
    {preview ? <div className="phone-files__preview">
      <p className="phone-files__path">{path}</p>
      {!currentFile ? <p role="status">Carregando arquivo…</p> : currentFile.error ? <p role="status">{currentFile.error}</p> : <pre tabIndex={0} aria-label="Conteúdo do arquivo">{currentFile.content}</pre>}
    </div> : <div className="phone-files__tree"><p className="phone-files__root">{session.cwd.split('/').at(-1)}</p>{branch('')}</div>}
  </section>;
}
