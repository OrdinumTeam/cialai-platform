// SPDX-License-Identifier: Apache-2.0
// Cor e icone lembrados por pasta. Quem abre um terminal na pasta A, escolhe
// cor e icone, fecha a sessao e no dia seguinte abre outro terminal na mesma
// pasta encontra o card como deixou. A memoria e deste aparelho, como a lista
// de recentes, e recebe o storage de fora para o script de verificacao testar
// com um objeto em memoria.
//
// Regras:
//
// - So a escolha da pessoa grava: trocar cor ou icone de uma sessao, ou
//   escolher no popover de sessao nova. Adotar a apresentacao do Rust nao
//   grava, para uma sessao antiga sem cor nao apagar a cor da pasta.
// - Voltar cor e icone ao padrao esquece a pasta; o padrao nao precisa de
//   registro.
// - A chave e a forma portatil, sem barra no fim e, no Windows, em
//   minusculas, a mesma regra de igualdade do explorador.
// - Acima do teto sai primeiro a pasta usada ha mais tempo.

import { pathRoot, portablePath } from '../lib/paths.js';

export const STORAGE_KEY = 'cialai_terminals_looks';
export const LOOK_LIMIT = 200;

export function lookKey(path, os) {
  let value = portablePath(path).trim();
  if (!value) return '';
  const root = pathRoot(value);
  while (value.length > Math.max(root.length, 1) && value.endsWith('/')) value = value.slice(0, -1);
  return os === 'windows' ? value.toLowerCase() : value;
}

function readStore(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
    if (parsed && parsed.version === 1 && parsed.folders && typeof parsed.folders === 'object') return parsed;
  } catch (_error) { /* sem storage ou conteudo invalido */ }
  return { version: 1, folders: {} };
}

function writeStore(storage, store) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(store)); return true; } catch (_error) { return false; }
}

function cleanId(value) {
  return typeof value === 'string' && value ? value : null;
}

// Cor e icone guardados para a pasta, ou null quando nada foi escolhido nela.
// Ler conta como uso, entao a pasta reaberta sobe na fila do teto.
export function recallLook(storage, key, now = Date.now()) {
  if (!key) return null;
  const store = readStore(storage);
  const entry = store.folders[key];
  if (!entry || typeof entry !== 'object') return null;
  const look = { color: cleanId(entry.color), icon: cleanId(entry.icon) };
  if (!look.color && !look.icon) return null;
  store.folders[key] = { ...look, at: now };
  writeStore(storage, store);
  return look;
}

export function rememberLook(storage, key, { color = null, icon = null } = {}, now = Date.now()) {
  if (!key) return false;
  const store = readStore(storage);
  const look = { color: cleanId(color), icon: cleanId(icon) };
  if (!look.color && !look.icon) {
    if (!store.folders[key]) return true;
    delete store.folders[key];
    return writeStore(storage, store);
  }
  store.folders[key] = { ...look, at: now };
  const keys = Object.keys(store.folders).sort((a, b) => (store.folders[b].at || 0) - (store.folders[a].at || 0));
  keys.slice(LOOK_LIMIT).forEach((stale) => { delete store.folders[stale]; });
  return writeStore(storage, store);
}
