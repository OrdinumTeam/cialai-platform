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

// Regras de primeiro nível com o seletor normalizado, na ordem efetiva.
const rules = [];
for (const match of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
  rules.push({ selector: match[1].trim().replace(/["']/g, ''), body: match[2], index: match.index });
}
const SHELL = ':is([data-shell=desktop],[data-platform=macos])';
const lastDefinition = (token, selectors) => {
  const found = rules.filter((rule) => selectors.includes(rule.selector) && rule.body.includes(`${token}:`));
  assert.ok(found.length > 0, `nenhuma definição de ${token} em ${selectors.join(' ou ')}`);
  const last = found.at(-1);
  return last.body.split(`${token}:`)[1].split(';')[0].trim();
};

// A identidade Cialai precisa vencer os tokens herdados da casca.
assert.equal(lastDefinition('--mac-accent', [':root', SHELL]), 'var(--cialai-magenta)', 'brand.css perdeu o acento claro para a casca');
assert.match(lastDefinition('--mac-sidebar-bg', [':root', SHELL]), /var\(--cialai-blush\)/, 'brand.css perdeu a sidebar clara para a casca');
assert.equal(lastDefinition('--mac-accent', [':root[data-theme=dark]', `${SHELL}[data-theme=dark]`]), 'var(--cialai-pink)', 'brand.css perdeu o acento escuro para a casca');

// O estúdio troca o padding padrão da área de conteúdo depois da casca.
const contentRule = rules.findLast((rule) => rule.selector === '.mac-content');
const studioRule = rules.findLast((rule) => rule.selector.includes('.mac-content:has(>.terminais-page)') || rule.selector.includes('.mac-content:has(> .terminais-page)'));
assert.ok(contentRule && studioRule && studioRule.index > contentRule.index, 'Terminais.css precisa vir depois de shell.css');

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

console.log(`PASS css cascade: ${sheets.length} desktop stylesheets keep shell, platform, brand and studio order in production, and the terminal viewport outranks the xterm black on desktop and phone`);
