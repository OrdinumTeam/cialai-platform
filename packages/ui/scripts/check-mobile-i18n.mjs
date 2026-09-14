// SPDX-License-Identifier: Apache-2.0
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '@babel/parser';
import { dictionaries, SUPPORTED_LOCALES } from '@cialai/i18n';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../../..');
export const SOURCE_ROOTS = Object.freeze([
  path.join(repositoryRoot, 'packages/ui/src/mobile'),
  path.join(repositoryRoot, 'packages/ui/src/desktop'),
  path.join(repositoryRoot, 'packages/ui/src/components'),
  path.join(repositoryRoot, 'packages/ui/src/views'),
  path.join(repositoryRoot, 'packages/ui/src/terminals'),
  path.join(repositoryRoot, 'packages/ui/src/shared'),
  path.join(repositoryRoot, 'packages/ui/src/lib'),
  path.join(repositoryRoot, 'apps/mobile'),
]);
const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
const ignoredDirectories = new Set(['android', 'coverage', 'ios', 'node_modules']);

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name) || entry.name === '__tests__' || /\.test\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(fullPath));
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(fullPath);
  }
  return files;
}

const dictionaryKeys = Object.keys(dictionaries['pt-BR']).sort();
const dictionaryKeySet = new Set(dictionaryKeys);
const placeholderPattern = /\{([A-Za-z][A-Za-z0-9]*)\}/gu;
const parserOptions = { sourceType: 'unambiguous', plugins: ['jsx', 'typescript', 'decorators-legacy', 'importAttributes'] };

export function placeholdersOf(value) {
  return [...new Set([...String(value).matchAll(placeholderPattern)].map((match) => match[1]))].sort();
}

// Os tres idiomas precisam existir com as mesmas chaves, sem valores vazios
// e com os mesmos placeholders, porque a traducao falha fechada.
export function checkDictionaries(source, expected = SUPPORTED_LOCALES) {
  const errors = [];
  const locales = Object.keys(source);
  if (locales.join('|') !== expected.join('|')) {
    errors.push(`idiomas esperados ${expected.join(', ')}; encontrados ${locales.join(', ')}`);
  }
  const base = source['pt-BR'] ?? {};
  const baseKeys = Object.keys(base).sort().join('|');
  for (const locale of locales) {
    const dictionary = source[locale];
    if (Object.keys(dictionary).sort().join('|') !== baseKeys) errors.push(`dicionario ${locale} nao possui as mesmas chaves de pt-BR`);
    for (const [key, value] of Object.entries(dictionary)) {
      if (typeof value !== 'string' || !value.trim()) {
        errors.push(`valor vazio em ${locale}: ${key}`);
        continue;
      }
      if (locale !== 'pt-BR' && typeof base[key] === 'string' && placeholdersOf(value).join('|') !== placeholdersOf(base[key]).join('|')) {
        errors.push(`placeholders de ${locale} diferem em ${key}`);
      }
    }
  }
  return errors;
}

function providedValues(node) {
  if (!node) return new Set();
  if (node.type !== 'ObjectExpression' || node.properties.some((property) => property.type !== 'ObjectProperty')) return null;
  return new Set(node.properties.map((property) => propertyName(property.key)).filter(Boolean));
}

// Chave usada quando aparece como literal em qualquer ponto da fonte, inclusive
// em mapas de codigos. Um template com expressao marca a familia do prefixo.
export function collectKeyUsage(source) {
  const literals = new Set();
  const families = new Set();
  let ast;
  try { ast = parse(source, parserOptions); } catch { return { literals, families }; }
  const walk = (node) => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    if (node.type === 'StringLiteral') literals.add(node.value);
    if (node.type === 'TemplateLiteral') {
      const first = node.quasis[0]?.value.cooked ?? '';
      if (node.expressions.length === 0) literals.add(first);
      else if (/^[A-Za-z]+(?:\.[A-Za-z]+)*\.$/u.test(first)) families.add(first);
    }
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(walk);
      else walk(child);
    }
  };
  walk(ast);
  return { literals, families };
}

export function unusedKeys(keys, usages) {
  return keys.filter((key) => !usages.some((usage) => usage.literals.has(key) || [...usage.families].some((prefix) => key.startsWith(prefix))));
}
const allowedLiterals = new Set(['Cialai', 'Codex', 'Dev Browser', 'Material Mica', 'Promise', 'Shell', 'hskey-api']);
const accessibleProperties = new Set(['aria-label', 'title', 'placeholder', 'accessibilityLabel', 'accessibilityHint']);
const configurationProperties = new Set(['label', 'message', 'description', 'emptyText', 'buttonText', 'headerTitle', 'promptMessage', 'cancelLabel', 'fallbackLabel', 'title', 'placeholder', 'hint', 'subtitle', 'kind', 'confirmLabel', 'dialogTitle']);
const visibleProperties = new Set([...configurationProperties, 'alt', 'ariaLabel', 'helperText']);
const browserDialogs = new Set(['alert', 'confirm', 'prompt', 'window.alert', 'window.confirm', 'window.prompt']);

function allowedLiteral(value) {
  const text = value.trim();
  return allowedLiterals.has(text)
    || dictionaryKeySet.has(text)
    || /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*(?::[a-z0-9_.-]+)?$/u.test(text)
    || /^--?[A-Za-z][\w-]*$/u.test(text)
    || /^:.*\?$/u.test(text)
    || /^(?:#[0-9A-Fa-f]{3,8}|https?:\/\/|\/|~\/|[A-Za-z]:\\)/u.test(text);
}

function propertyName(node) {
  if (node?.type === 'Identifier' || node?.type === 'JSXIdentifier') return node.name;
  if (node?.type === 'StringLiteral') return node.value;
  return null;
}

function literalValue(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('');
  }
  return null;
}

function renderedLiterals(node, conditional = false, bindings = new Map()) {
  const value = literalValue(node);
  if (value !== null) return [{ value, conditional }];
  if (!node) return [];
  if (node.type === 'Identifier' && bindings.has(node.name)) return [{ value: bindings.get(node.name), conditional }];
  if (node.type === 'ConditionalExpression') {
    return [...renderedLiterals(node.consequent, true, bindings), ...renderedLiterals(node.alternate, true, bindings)];
  }
  if (node.type === 'LogicalExpression') {
    if (node.operator === '&&') return renderedLiterals(node.right, true, bindings);
    return [...renderedLiterals(node.left, true, bindings), ...renderedLiterals(node.right, true, bindings)];
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return [...renderedLiterals(node.left, conditional, bindings), ...renderedLiterals(node.right, conditional, bindings)];
  }
  if (node.type === 'ArrayExpression') return node.elements.flatMap((element) => renderedLiterals(element, conditional, bindings));
  if (['ParenthesizedExpression', 'TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression'].includes(node.type)) {
    return renderedLiterals(node.expression, conditional, bindings);
  }
  return [];
}

function translationKeys(node) {
  const value = literalValue(node);
  if (value !== null) return [value];
  if (!node) return [];
  if (node.type === 'ConditionalExpression') return [...translationKeys(node.consequent), ...translationKeys(node.alternate)];
  if (node.type === 'LogicalExpression') return [...translationKeys(node.left), ...translationKeys(node.right)];
  if (['ParenthesizedExpression', 'TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression'].includes(node.type)) return translationKeys(node.expression);
  return [];
}

function memberCallName(node) {
  if (node?.type !== 'MemberExpression' && node?.type !== 'OptionalMemberExpression') return null;
  const object = propertyName(node.object);
  const property = propertyName(node.property);
  return object && property ? `${object}.${property}` : null;
}

export function inspectSource(source, displayPath) {
  const errors = [];
  let ast;
  try {
    ast = parse(source, parserOptions);
  } catch (error) {
    return [`${displayPath}:${error.loc?.line || 1}: fonte invalida para o gate de i18n: ${error.message}`];
  }

  const addLiteral = (node, name, value) => {
    const text = value.replace(/\s+/gu, ' ').trim();
    if (text && /[A-Za-z\u00c0-\u024f]/u.test(text) && !allowedLiteral(text)) {
      errors.push(`${displayPath}:${node.loc?.start.line || 1}: ${name} sem chave: ${text}`);
    }
  };

  const bindings = new Map();
  const repeatedBindings = new Set();
  const collectBindings = (node, parent = null) => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    if (node.type === 'VariableDeclarator' && parent?.type === 'VariableDeclaration' && parent.kind === 'const' && node.id?.type === 'Identifier') {
      const value = literalValue(node.init);
      if (value !== null) {
        if (bindings.has(node.id.name)) repeatedBindings.add(node.id.name);
        else bindings.set(node.id.name, value);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra'].includes(key)) continue;
      if (Array.isArray(child)) for (const item of child) collectBindings(item, node);
      else collectBindings(child, node);
    }
  };
  collectBindings(ast);
  for (const name of repeatedBindings) bindings.delete(name);

  const visit = (node, parent = null) => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    if (node.type === 'JSXText') addLiteral(node, 'texto JSX', node.value);

    if (node.type === 'JSXExpressionContainer' && parent?.type !== 'JSXAttribute') {
      for (const literal of renderedLiterals(node.expression, false, bindings)) {
        addLiteral(node, literal.conditional ? 'texto JSX condicional' : 'texto JSX entre chaves', literal.value);
      }
    }

    const attributeName = node.type === 'JSXAttribute' ? propertyName(node.name) : null;
    if (attributeName && (accessibleProperties.has(attributeName) || visibleProperties.has(attributeName))) {
      const label = accessibleProperties.has(attributeName) ? 'propriedade acessivel' : 'propriedade visivel';
      if (node.value?.type === 'StringLiteral') addLiteral(node, label, node.value.value);
      if (node.value?.type === 'JSXExpressionContainer') {
        for (const literal of renderedLiterals(node.value.expression, false, bindings)) {
          addLiteral(node, literal.conditional ? `${label} condicional` : `${label} entre chaves`, literal.value);
        }
      }
    }

    if (node.type === 'ObjectProperty') {
      const name = propertyName(node.key);
      const label = name === 'text' ? 'botao nativo' : configurationProperties.has(name) ? 'mensagem de configuração' : null;
      if (label) for (const literal of renderedLiterals(node.value, false, bindings)) addLiteral(node, label, literal.value);
    }

    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const calleeName = propertyName(node.callee);
      if (calleeName === 't' || calleeName === 'translate') {
        const provided = providedValues(node.arguments[1]);
        for (const key of translationKeys(node.arguments[0])) {
          if (!dictionaryKeySet.has(key)) {
            errors.push(`${displayPath}:${node.loc?.start.line || 1}: chave desconhecida: ${key}`);
            continue;
          }
          const missing = provided ? placeholdersOf(dictionaries['pt-BR'][key]).filter((name) => !provided.has(name)) : [];
          if (missing.length) errors.push(`${displayPath}:${node.loc?.start.line || 1}: valores ausentes para ${key}: ${missing.join(', ')}`);
        }
        const dynamicKey = node.arguments[0];
        if (dynamicKey?.type === 'TemplateLiteral' && dynamicKey.expressions.length > 0) {
          const prefix = dynamicKey.quasis[0]?.value.cooked ?? dynamicKey.quasis[0]?.value.raw ?? '';
          if (!prefix || !dictionaryKeys.some((key) => key.startsWith(prefix))) {
            errors.push(`${displayPath}:${node.loc?.start.line || 1}: familia de chave desconhecida: ${prefix}`);
          }
        }
      }
      if (calleeName === 'notify' || calleeName === 'announce') {
        for (const literal of renderedLiterals(node.arguments[0], false, bindings)) addLiteral(node, 'notificacao', literal.value);
      }
      const nativeCall = memberCallName(node.callee);
      if (browserDialogs.has(nativeCall || calleeName)) {
        for (const literal of renderedLiterals(node.arguments[0], false, bindings)) addLiteral(node, 'dialogo do navegador', literal.value);
      }
      if (nativeCall === 'Alert.alert' || nativeCall === 'ToastAndroid.show') {
        const visibleArguments = nativeCall === 'Alert.alert' ? node.arguments.slice(0, 2) : node.arguments.slice(0, 1);
        for (const argument of visibleArguments) {
          for (const literal of renderedLiterals(argument, false, bindings)) addLiteral(node, 'mensagem nativa', literal.value);
        }
      }
    }

    if (node.type === 'NewExpression' && propertyName(node.callee) === 'Error') {
      for (const literal of renderedLiterals(node.arguments[0], false, bindings)) addLiteral(node, 'mensagem de erro', literal.value);
    }

    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra'].includes(key)) continue;
      if (Array.isArray(child)) for (const item of child) visit(item, node);
      else visit(child, node);
    }
  };

  visit(ast);
  return errors;
}

export async function checkI18n() {
  const errors = checkDictionaries(dictionaries);
  const usages = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of await sourceFiles(root)) {
      const source = await readFile(file, 'utf8');
      errors.push(...inspectSource(source, path.relative(repositoryRoot, file)));
      usages.push(collectKeyUsage(source));
    }
  }
  for (const key of unusedKeys(dictionaryKeys, usages)) errors.push(`chave sem uso: ${key}`);
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const errors = await checkI18n();
  if (errors.length) {
    console.error('FAIL i18n');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS i18n: ${dictionaryKeys.length} chaves em ${Object.keys(dictionaries).length} idiomas e ${SOURCE_ROOTS.length} superficies`);
  }
}
