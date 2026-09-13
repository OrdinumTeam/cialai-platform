// SPDX-License-Identifier: Apache-2.0
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dictionaries } from '@cialai/i18n';

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/mobile');
const appRoot = path.resolve(uiRoot, '../../../../apps/mobile');
const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
const ignoredFiles = new Set(['i18n.js', 'i18n.ts']);

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || /\.test\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(fullPath));
    else if (sourceExtensions.has(path.extname(entry.name)) && !ignoredFiles.has(entry.name)) files.push(fullPath);
  }
  return files;
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

const visiblePatterns = [
  { name: 'texto JSX', expression: />\s*([^<>{}\n]*[A-Za-z\u00c0-\u024f][^<>{}\n]*)\s*</gu },
  { name: 'texto JSX entre chaves', expression: />\s*\{\s*['"]([^'"]*[A-Za-z\u00c0-\u024f][^'"]*)['"]\s*\}\s*</gu },
  { name: 'propriedade acessivel', expression: /\b(?:aria-label|title|placeholder|accessibilityLabel|accessibilityHint)\s*=\s*['"]([^'"]*[A-Za-z\u00c0-\u024f][^'"]*)['"]/gu },
  { name: 'propriedade acessivel entre chaves', expression: /\b(?:aria-label|title|placeholder|accessibilityLabel|accessibilityHint)\s*=\s*\{\s*['"]([^'"]*[A-Za-z\u00c0-\u024f][^'"]*)['"]\s*\}/gu },
  { name: 'mensagem de configuração', expression: /\b(?:label|message|description|emptyText|buttonText|headerTitle|promptMessage|cancelLabel|fallbackLabel)\s*:\s*['"]([^'"]*[A-Za-z\u00c0-\u024f][^'"]*)['"]/gu },
  { name: 'mensagem nativa', expression: /\b(?:Alert\.alert|ToastAndroid\.show)\s*\(\s*['"]([^'"]*[A-Za-z\u00c0-\u024f][^'"]*)['"]/gu },
];

const errors = [];
const dictionaryKeys = Object.keys(dictionaries['pt-BR']).sort();
for (const locale of Object.keys(dictionaries)) {
  const keys = Object.keys(dictionaries[locale]).sort();
  if (JSON.stringify(keys) !== JSON.stringify(dictionaryKeys)) {
    errors.push(`dicionario ${locale} nao possui as mesmas chaves de pt-BR`);
  }
}

for (const file of [...await sourceFiles(uiRoot), ...await sourceFiles(appRoot)]) {
  const source = await readFile(file, 'utf8');
  for (const pattern of visiblePatterns) {
    for (const match of source.matchAll(pattern.expression)) {
      errors.push(`${path.relative(path.resolve(uiRoot, '../../../..'), file)}:${lineNumber(source, match.index)}: ${pattern.name} sem chave: ${match[1].trim()}`);
    }
  }
  for (const match of source.matchAll(/\b(?:t|translate)\(\s*['"]([^'"]+)['"]/gu)) {
    if (!dictionaryKeys.includes(match[1])) {
      errors.push(`${path.relative(path.resolve(uiRoot, '../../../..'), file)}:${lineNumber(source, match.index)}: chave desconhecida: ${match[1]}`);
    }
  }
}

if (errors.length) {
  console.error('FAIL mobile i18n');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`PASS mobile i18n: ${dictionaryKeys.length} chaves em ${Object.keys(dictionaries).length} idiomas`);
}
