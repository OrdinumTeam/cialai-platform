// SPDX-License-Identifier: Apache-2.0
// Trava a geometria dos dialogos no build de producao, no espirito de
// `css-cascade.mjs`. Existe porque a 0.2.6 saiu com a folha de Preferencias
// esticada e nenhum check apontou: nao havia nada medindo diálogo, e a lista
// de contas da Barra de IA nem renderizava fora do modo nativo, entao toda a
// evidencia visual foi capturada com a secao vazia.
//
// Os numeros vivem em `packages/ui/src/components/modal-geometry.js` e sao
// cruzados com o CSS gerado: JS e folha nao podem divergir em silencio.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODAL_GUTTER_X, MODAL_GUTTER_Y, MODAL_MAX_HEIGHT_PX, MODAL_SIZES, MODAL_WIDTH } from '../../packages/ui/src/components/modal-geometry.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = `${root}apps/desktop/dist`;
assert.ok(existsSync(`${dist}/index.html`), 'dist ausente; rode npm run build:ui --workspace @cialai/desktop antes');

const html = readFileSync(`${dist}/index.html`, 'utf8');
const sheets = [...html.matchAll(/<link rel="stylesheet"[^>]*href="\.\/([^"]+\.css)"/g)].map((match) => match[1]);
assert.ok(sheets.length > 0, 'index.html sem folhas de estilo');
const css = sheets.map((sheet) => readFileSync(`${dist}/${sheet}`, 'utf8')).join('\n');

// Regras de primeiro nivel, na ordem efetiva, ignorando o conteudo de @media
// e @container, que nao competem com a regra base.
const rules = [];
for (const match of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
  rules.push({ selector: match[1].trim().replace(/["']/g, ''), body: match[2], index: match.index });
}

const SHELL = ':is([data-shell=desktop],[data-platform=macos])';
const base = rules.filter((rule) => rule.selector === `${SHELL} .MuiDialog-paper[data-modal]`);
assert.equal(base.length, 1, 'a regra base da geometria do papel precisa existir uma vez, com o prefixo da casca');
const geometry = base[0];

// Especificidade de tres classes. Sem o prefixo, a regra empata com a classe
// do emotion e volta a depender da ordem de injecao.
assert.ok(geometry.selector.startsWith(SHELL), 'a geometria precisa do prefixo da casca para vencer por especificidade');
assert.match(geometry.body, new RegExp(`max-width:calc\\(100vw - ${MODAL_GUTTER_X}px\\)`), `max-width deve usar a folga de ${MODAL_GUTTER_X}px`);
assert.match(geometry.body, new RegExp(`max-height:min\\(${MODAL_MAX_HEIGHT_PX}px,calc\\(100dvh - ${MODAL_GUTTER_Y}px\\)\\)`), `max-height deve ser o teto de ${MODAL_MAX_HEIGHT_PX}px com folga de ${MODAL_GUTTER_Y}px`);
// Unidade de viewport, nunca percentual: a altura percentual depende de o
// contêiner do MUI ter altura, e essa altura tambem vem do emotion.
assert.doesNotMatch(geometry.body, /max-height:[^;]*100%/, 'o teto de altura nao pode depender de altura percentual do contêiner');
assert.match(geometry.body, /width:var\(--mac-modal-w/, 'a largura deve sair da variavel por tamanho');

// Cada tamanho declarado no JS precisa existir no CSS com o mesmo numero.
for (const size of MODAL_SIZES) {
  const selector = `${SHELL} .MuiDialog-paper[data-modal=${size}]`;
  const rule = rules.findLast((item) => item.selector === selector);
  assert.ok(rule, `sem regra de largura para o tamanho ${size}`);
  assert.match(rule.body, new RegExp(`--mac-modal-w:${MODAL_WIDTH[size]}px`), `o tamanho ${size} deveria medir ${MODAL_WIDTH[size]}px no CSS`);
}

// Nada pode redefinir a caixa do papel depois da geometria, a nao ser a folha
// do celular, que e escopada por atributo e so vale na pagina do telefone.
const later = rules.filter((rule) => rule.index > geometry.index
  && rule.selector.includes('.MuiDialog-paper')
  && !rule.selector.includes('data-form-factor')
  && /(^|;)(width|max-width|max-height):/.test(rule.body));
assert.deepEqual(later.map((rule) => rule.selector), [], 'alguma folha redefine a caixa do papel depois da geometria');

// E quando ela aparece, continua com !important, que e o que garante que o
// telefone vence a regra do desktop, e nao a ordem das folhas.
for (const rule of rules.filter((item) => item.selector.includes('data-form-factor') && item.selector.includes('.MuiDialog-paper'))) {
  if (!/(^|;)width:/.test(rule.body)) continue;
  assert.match(rule.body, /width:[^;]*!important/, 'a folha do celular perdeu o !important da largura');
}

// O corpo da folha e o contêiner que as secoes medem. Sem ele, `@container`
// nao casa e o formulario volta a se dimensionar pela janela.
assert.match(css, /\.MuiDialog-paper\[data-modal\] \.MuiDialogContent-root\{[^}]*container-type:inline-size/, 'o corpo da folha precisa ser contêiner de consulta');
assert.match(css, /\.MuiDialog-paper\[data-modal\] \.MuiDialogContent-root\{[^}]*container-name:sheet/, 'o contêiner da folha precisa se chamar sheet');
assert.ok(css.includes('@container sheet'), 'nenhuma secao mede a folha');
// A grade do QR media a janela: numa janela de 880 ela colapsava para uma
// coluna com os 700px do papel inteiros, e a folha pulava de 463 para 660.
assert.doesNotMatch(css, /@media[^{]*\{[^{]*\.mac-pair\{grid-template-columns:1fr/, 'o colapso do pareamento voltou a medir a janela');

// A folha do celular continua sobrepondo com !important, que e o que protege
// o telefone das regras acima.
const mobile = readFileSync(`${root}packages/ui/src/mobile/mobile.css`, 'utf8');
const phonePaper = mobile.match(/\[data-form-factor="phone"\] \.MuiDialog-paper \{([^}]*)\}/);
assert.ok(phonePaper, 'mobile.css sem a regra do papel do celular');
for (const property of ['width', 'max-width', 'max-height', 'margin']) {
  assert.match(phonePaper[1], new RegExp(`${property}:[^;]*!important`), `mobile.css precisa manter ${property} com !important`);
}

// A marcacao existe nas tres portas e chega ao bundle.
const geometrySource = readFileSync(`${root}packages/ui/src/components/modal-geometry.js`, 'utf8');
assert.match(geometrySource, /'data-modal':/, 'modal-geometry.js precisa emitir data-modal');
for (const [file, expected] of [
  ['packages/ui/src/components/ui.jsx', /PaperProps=\{modalPaperProps\(/],
  ['packages/ui/src/terminals/ui/dialogs.jsx', /PaperProps=\{modalPaperProps\(/],
]) {
  assert.match(readFileSync(`${root}${file}`, 'utf8'), expected, `${file} precisa marcar o papel por modalPaperProps`);
}
// O primitivo entra por importacao tardia, entao a marcacao pode cair em
// qualquer pedaco do build, nao so na entrada.
const chunks = readdirSync(`${dist}/assets`).filter((name) => name.endsWith('.js'));
const marked = chunks.filter((name) => readFileSync(`${dist}/assets/${name}`, 'utf8').includes('data-modal'));
assert.ok(marked.length > 0, 'nenhum pedaco do build emite data-modal');

console.log(`PASS dialog geometry: ${MODAL_SIZES.length} sizes cross checked between modal-geometry.js and the production stylesheet, paper box unbeaten, phone overrides intact`);
