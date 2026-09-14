// SPDX-License-Identifier: Apache-2.0
import { isMobileShell, requestDownload, requestUrlDownload, openExternal as shellOpenExternal } from './shell.js';
// Salvar arquivos e abrir links externos. No app macOS o WKWebView não salva
// blobs sozinho, então passa pelo diálogo nativo de salvar e grava com o
// plugin de arquivos. Fora do Tauri, no Vite de desenvolvimento, usa a âncora.

import { isTauri } from './native.js';
import { translate } from '../shared/i18n.js';

function anchorDownload(href, name, newTab = false) {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name || '';
  if (newTab) anchor.target = '_blank';
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

// Devolve true quando o arquivo foi salvo e false quando o usuário cancelou.
export async function saveBlob(blob, suggestedName) {
  if (isMobileShell()) return requestDownload(blob, suggestedName);
  if (!isTauri()) {
    const href = URL.createObjectURL(blob);
    anchorDownload(href, suggestedName);
    setTimeout(() => URL.revokeObjectURL(href), 5000);
    return true;
  }

  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  const path = await save({ defaultPath: suggestedName, title: translate('shared.dialog.saveFile') });
  if (!path) return false;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await writeFile(path, bytes);
  return true;
}

export function saveText(text, suggestedName, mime = 'text/plain;charset=utf-8') {
  return saveBlob(new Blob([text], { type: mime }), suggestedName);
}

// Recebe o módulo XLSX e o workbook já montado pela view.
export async function saveWorkbook(XLSX, workbook, filename) {
  if (!isTauri() && !isMobileShell()) {
    XLSX.writeFile(workbook, filename);
    return true;
  }
  const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([output], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  return saveBlob(blob, filename);
}

export async function openExternal(url) {
  if (isMobileShell()) return shellOpenExternal(url);
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

// Links assinados do S3 e outros downloads por URL. No navegador baixa na
// aba; no app abre no navegador padrão, que cuida do download.
export async function downloadUrl(url, suggestedName) {
  if (isMobileShell()) {
    return requestUrlDownload(url, suggestedName || 'download');
  }
  if (!isTauri()) {
    anchorDownload(url, suggestedName, true);
    return true;
  }
  await openExternal(url);
  return true;
}
