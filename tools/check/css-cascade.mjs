// SPDX-License-Identifier: Apache-2.0
// Confere a cascata do CSS no build de produção da entrada desktop. O Vite
// separa em chunks anteriores o CSS compartilhado com a página do celular, e o
// servidor de desenvolvimento não mostra essa ordem. Rode depois do build.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = `${root}apps/desktop/dist`;
assert.ok(existsSync(`${dist}/index.html`), 'dist ausente; rode npm run build:ui --workspace @cialai/desktop antes');

const html = readFileSync(`${dist}/index.html`, 'utf8');
const sheets = [...html.matchAll(/<link rel="stylesheet"[^>]*href="\.\/([^"]+\.css)"/g)].map((match) => match[1]);
assert.ok(sheets.length > 0, 'index.html sem folhas de estilo');
const css = sheets.map((sheet) => readFileSync(`${dist}/${sheet}`, 'utf8')).join('\n');

// Partes de uma lista de seletores, sem cortar dentro de parenteses. Os blocos
// de tokens repetem o seletor para o contenedor do terminal com tema proprio.
function selectorParts(selector) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) { parts.push(selector.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(selector.slice(start).trim());
  return parts;
}

// Regras de primeiro nível com o seletor normalizado, na ordem efetiva.
const rules = [];
for (const match of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
  const selector = match[1].trim().replace(/["']/g, '');
  rules.push({ selector, parts: selectorParts(selector), body: match[2], index: match.index });
}
const SHELL = ':is([data-shell=desktop],[data-platform=macos])';
const lastDefinition = (token, selectors) => {
  const found = rules.filter((rule) => rule.parts.some((part) => selectors.includes(part)) && rule.body.includes(`${token}:`));
  assert.ok(found.length > 0, `nenhuma definição de ${token} em ${selectors.join(' ou ')}`);
  const last = found.at(-1);
  return last.body.split(`${token}:`)[1].split(';')[0].trim();
};

// A identidade Cialai precisa vencer os tokens herdados da casca.
assert.equal(lastDefinition('--mac-accent', [':root', SHELL]), 'var(--cialai-magenta)', 'brand.css perdeu o acento claro para a casca');
assert.match(lastDefinition('--mac-sidebar-bg', [':root', SHELL]), /var\(--cialai-blush\)/, 'brand.css perdeu a sidebar clara para a casca');
assert.equal(lastDefinition('--mac-accent', [':root[data-theme=dark]', `${SHELL}[data-theme=dark]`]), 'var(--cialai-pink)', 'brand.css perdeu o acento escuro para a casca');

// A camada sólida do desktop vem depois da marca: no desktop a lateral é cor
// sólida, nunca o gradiente que brand.css ainda define para a página do
// celular, e os tokens dela não podem perder para os de brand.css.
const DESKTOP = 'html[data-shell=desktop]';
assert.doesNotMatch(lastDefinition('--mac-sidebar-bg', [DESKTOP]), /gradient/, 'solid.css perdeu a lateral sólida');
assert.doesNotMatch(lastDefinition('--mac-sidebar-bg', [`${DESKTOP}[data-theme=dark]`]), /gradient/, 'solid.css perdeu a lateral sólida no escuro');
const brandBlock = rules.findLast((rule) => rule.parts.includes(':root') && rule.body.includes('--mac-sidebar-bg:'));
const solidBlock = rules.findLast((rule) => rule.parts.includes(DESKTOP) && rule.body.includes('--mac-sidebar-bg:'));
assert.ok(brandBlock && solidBlock && solidBlock.index > brandBlock.index, 'solid.css precisa vir depois de brand.css');

// O estúdio troca o padding padrão da área de conteúdo depois da casca.
const contentRule = rules.findLast((rule) => rule.selector === '.mac-content');
const studioRule = rules.findLast((rule) => rule.selector.includes('.mac-content:has(>.terminais-page)') || rule.selector.includes('.mac-content:has(> .terminais-page)'));
assert.ok(contentRule && studioRule && studioRule.index > contentRule.index, 'Terminais.css precisa vir depois de shell.css');

// O tema proprio do terminal depende do seletor espelhado com o atributo
// repetido, que iguala a especificidade do bloco escuro. Um minificador que
// juntasse a repeticao faria o terminal perder para a janela. O build pode
// repetir folhas entre pedacos, entao a conta e por seletor, nao por ocorrencia.
const compact = (selector) => selector.replace(/["'\s]/g, '');
const sourceSheets = [...readFileSync(`${root}packages/ui/src/desktop/desktop.css`, 'utf8').matchAll(/@import '([^']+)';/g)]
  .map((match) => readFileSync(fileURLToPath(new URL(match[1], `file://${root}packages/ui/src/desktop/`)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
  .join('\n');
const mirrors = new Set([...sourceSheets.matchAll(/([^{}@]+)\{[^{}]*\}/g)]
  .flatMap((match) => selectorParts(match[1].trim()))
  .filter((part) => part.includes('[data-terminal-scope][data-terminal-scope]'))
  .map(compact));
const built = new Set(rules.flatMap((rule) => rule.parts.map(compact)));
assert.ok(mirrors.size > 0, 'as folhas perderam o espelho do tema do terminal');
for (const mirror of mirrors) assert.ok(built.has(mirror), `o build mudou o espelho do tema do terminal: ${mirror}`);

// O CSS do xterm vem num chunk carregado depois das folhas da página e pinta
// o viewport de preto. O fundo do terminal precisa vencer por especificidade
// no desktop e no celular, não pela ordem.
const assetCss = readdirSync(`${dist}/assets`).filter((name) => name.endsWith('.css')).map((name) => readFileSync(`${dist}/assets/${name}`, 'utf8')).join('\n');
const xtermViewport = [...assetCss.matchAll(/([^{}@]+)\{([^{}]*)\}/g)]
  .map((match) => ({ selector: match[1].trim(), body: match[2] }))
  .filter((rule) => rule.selector.endsWith('.xterm .xterm-viewport') && /background-color:var\(--terminais-terminal-bg\)/.test(rule.body));
for (const host of ['.terminais-terminal__host', '.phone-terminal__host']) {
  assert.ok(xtermViewport.some((rule) => rule.selector.includes(host)), `fundo do viewport do xterm sem regra específica para ${host}`);
}

console.log(`PASS css cascade: ${sheets.length} desktop stylesheets keep shell, platform, brand, solid surfaces and studio order in production, the terminal theme mirrors keep their weight, and the terminal viewport outranks the xterm black on desktop and phone`);
