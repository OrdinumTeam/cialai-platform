// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { translate as t } from './i18n.js';

// O resumo chega como o JSON dos argumentos, já sem os valores de ambiente.
// A prévia mostra o que a pessoa decide: o comando e a pasta, ou o texto que
// vai ser digitado. Qualquer outro formato aparece como veio, sempre escapado.
export function requestText(request) {
  const summary = request.summary;
  if (!summary) return request.command || request.cmd || '';
  let args;
  try { args = JSON.parse(summary); } catch { return summary; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return summary;
  if (request.cmd === 'exec' && typeof args.command === 'string') {
    const line = [args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' ');
    return typeof args.dir === 'string' && args.dir ? `${line}\n${args.dir}` : line;
  }
  if (request.cmd === 'pty.write' && typeof args.text === 'string') return args.text;
  if (request.cmd === 'pty.open') return typeof args.dir === 'string' ? args.dir : '';
  if (request.cmd === 'pty.kill') return '';
  return summary;
}

export default function BrotoRequestPreview({ request }) {
  if (request.cmd === 'files.get' || request.cmd === 'files.put') {
    let args;
    try { args = JSON.parse(request.summary); } catch { args = null; }
    if (args && typeof args.path === 'string') return <div className="broto-request-preview"><strong>{t(request.cmd === 'files.get' ? 'desktop.brotos.fileDownload' : 'desktop.brotos.fileUpload')}</strong><div>{args.path}</div>{Number.isFinite(args.size) && <small>{t('desktop.brotos.fileSize', { bytes: args.size })}</small>}</div>;
  }
  const text = requestText(request);
  return text ? <code className="broto-request-preview">{text}</code> : null;
}
