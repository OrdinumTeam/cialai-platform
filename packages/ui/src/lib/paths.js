// SPDX-License-Identifier: Apache-2.0
// Forma portátil de um caminho, sem depender de plataforma, de ponte ou de
// DOM. O contrato de `docs/arquitetura/14-diferencas-por-plataforma.md` diz que
// todo caminho que chega à interface usa barra normal; o Rust já cumpre isso
// por `to_portable`, e o que entra por outra porta, como o resultado do
// diálogo nativo do Windows, passa por aqui antes de virar estado.
//
// O módulo é a fronteira única: `native.js` normaliza o que devolve, e todo o
// resto do estúdio já recebe a forma portátil. Sem isso, metade dos caminhos
// chega com barra invertida e as comparações de igualdade falham no Windows,
// que é o que deixa o explorador trocando de raiz sem parar.

export function portablePath(path) {
  const value = String(path || '').replace(/\\/g, '/');
  if (value.startsWith('//?/UNC/')) return `//${value.slice(8)}`;
  return value.replace(/^\/\/\?\//, '');
}

// Raiz de um caminho absoluto: `/` no Unix, `C:/` numa unidade do Windows e
// `//servidor/pasta/` num compartilhamento de rede. Vazio num caminho
// relativo. Acima da raiz não há pasta pai.
export function pathRoot(path) {
  const value = portablePath(path);
  const drive = /^([A-Za-z]:)(\/|$)/.exec(value);
  if (drive) return `${drive[1]}/`;
  if (value.startsWith('//')) {
    const parts = value.slice(2).split('/').filter(Boolean);
    if (parts.length >= 2) return `//${parts[0]}/${parts[1]}/`;
    return value.endsWith('/') ? value : `${value}/`;
  }
  if (value.startsWith('/')) return '/';
  return '';
}

// Um caminho absoluto em qualquer sistema: `/pasta`, `C:/pasta` ou
// `//servidor/pasta`. A letra de unidade não pode ficar de fora, senão o
// Windows recusa tudo o que vem de fora do app.
export function isAbsolutePath(path) {
  return Boolean(pathRoot(path));
}

export function baseName(path) {
  const trimmed = portablePath(path).replace(/\/+$/, '');
  return trimmed.split('/').pop() || trimmed || '';
}

// Pasta acima. `null` quando já é a raiz: `/`, `C:/` e o próprio
// compartilhamento de rede não têm pai, e subir mais é pedir ao Rust um
// caminho que ele recusa por não ser absoluto.
export function dirName(path) {
  const value = portablePath(path);
  const root = pathRoot(value);
  const trimmed = value.replace(/\/+$/, '');
  if (root && (value === root || `${trimmed}/` === root || !trimmed)) return null;
  const index = trimmed.lastIndexOf('/');
  if (index < 0) return root || '/';
  const parent = trimmed.slice(0, index);
  if (!parent) return root || '/';
  if (`${parent}/` === root) return root;
  return parent;
}

export function joinPath(dir, name) {
  const base = portablePath(dir);
  const root = pathRoot(base);
  const trimmed = base.replace(/\/+$/, '');
  // Numa raiz o separador já está no caminho: `C:/` mais `Users` é
  // `C:/Users`, nunca `C://Users`.
  if (root && `${trimmed}/` === root) return `${root}${name}`;
  return `${trimmed}/${name}`;
}

// Dentro da raiz, por igualdade ou por prefixo de pasta. `fold` normaliza os
// dois lados; o Windows não diferencia maiúsculas e precisa de
// `value => value.toLowerCase()`.
export function isInsideWith(root, path, fold = (value) => value) {
  const base = fold(portablePath(root).replace(/\/+$/, ''));
  const target = fold(portablePath(path));
  return target === base || target.startsWith(`${base}/`);
}
