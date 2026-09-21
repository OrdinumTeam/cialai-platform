// SPDX-License-Identifier: Apache-2.0
// Contrato visivel da geometria dos dialogos, rodando sobre o build de
// producao por `?dialog-check=1`. Auto contido de proposito: o `preview` do
// Vite nao serve `/@fs`, entao este roteiro nao importa fonte do app.
//
// Existe porque a 0.2.6 saiu com a folha de Preferencias esticada e nenhum
// check apontou. Pior: a lista de contas da Barra de IA nem renderizava fora
// do modo nativo, entao toda a evidencia visual foi capturada com a secao
// vazia. Aqui a primeira assercao e justamente a contagem de contas.

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
async function until(test, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${label}`);
    await pause();
  }
  return test();
}

// Os mesmos numeros de `packages/ui/src/components/modal-geometry.js`. Repetidos
// aqui porque o roteiro nao importa fonte do app; `tools/check/dialog-geometry.mjs`
// cruza os dois lados e falha se divergirem.
const LARGURA = { xs: 400, sm: 520, md: 700, lg: 880 };
const TETO = 660;
const FOLGA_X = 48;
const FOLGA_Y = 96;

// A transicao de entrada do MUI e feita em JS, com estilo em linha, e nao
// obedece ao `data-motion="none"` que desliga as animacoes de CSS. Medir no
// susto pega a folha ainda escalada. Espera a largura repetir duas vezes.
async function assentar(selector, onde) {
  let anterior = -1;
  const deadline = Date.now() + 8000;
  for (;;) {
    const alvo = document.querySelector(selector);
    const largura = alvo ? Math.round(alvo.getBoundingClientRect().width) : -1;
    if (largura > 0 && largura === anterior) return alvo;
    if (Date.now() > deadline) throw new Error(`${onde}: a folha nunca parou de mudar de tamanho`);
    anterior = largura;
    await pause(80);
  }
}

function medirPapel(tamanho, onde) {
  const paper = document.querySelector('.MuiDialog-paper');
  assert(paper, `${onde}: sem papel de dialogo`);
  assert(paper.getAttribute('data-modal') === tamanho, `${onde}: o papel deveria ser do tamanho ${tamanho}`);
  const caixa = paper.getBoundingClientRect();
  const esperada = Math.min(LARGURA[tamanho], window.innerWidth - FOLGA_X);
  assert(Math.abs(caixa.width - esperada) <= 1, `${onde}: papel com ${Math.round(caixa.width)}px de largura, esperado ${Math.round(esperada)}px, transform ${getComputedStyle(paper).transform}`);
  const tetoAltura = Math.min(TETO, window.innerHeight - FOLGA_Y);
  assert(caixa.height <= tetoAltura + 1, `${onde}: papel com ${Math.round(caixa.height)}px de altura, teto ${Math.round(tetoAltura)}px`);
  assert(caixa.top >= -1 && caixa.bottom <= window.innerHeight + 1, `${onde}: papel cortado pela janela, topo ${Math.round(caixa.top)} base ${Math.round(caixa.bottom)}`);
  assert(paper.scrollWidth <= paper.clientWidth + 1, `${onde}: conteudo estourando a largura do papel`);
  assert(paper.scrollHeight <= paper.clientHeight + 1, `${onde}: quem rola deveria ser o corpo, nao o papel`);
  return paper;
}

async function fechar() {
  const paper = document.querySelector('.MuiDialog-paper');
  if (!paper) return;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => !document.querySelector('.MuiDialog-paper'), 'fechar dialogo').catch(() => {});
}

async function main() {
  document.title = 'CHECK: Cialai dialog geometry';

  // Preferencias, com a secao de contas cheia.
  await until(() => document.querySelector('.MuiDialog-paper'), 'folha de Preferencias');
  await until(() => document.querySelectorAll('.notch-prefs__profile').length > 0, 'lista de contas');
  const contas = document.querySelectorAll('.notch-prefs__profile').length;
  assert(contas === 12, `a medicao precisa das 12 contas do cenario, vieram ${contas}`);

  await assentar('.MuiDialog-paper', 'Preferencias');
  const paper = medirPapel('md', 'Preferencias');
  const corpo = paper.querySelector('.MuiDialogContent-root');
  assert(corpo, 'Preferencias: sem corpo de dialogo');
  assert(corpo.scrollHeight > corpo.clientHeight, 'Preferencias: com 12 contas o corpo deveria rolar por dentro');
  assert(getComputedStyle(corpo).containerType === 'inline-size', 'o corpo da folha precisa ser contêiner de consulta');

  // As secoes medem a folha, e nao a janela. O gatilho e a largura do corpo do
  // dialogo; a largura da janela nao tem nada a ver com isso. Ancorar aqui e o
  // que faz este roteiro pegar a regressao numa janela de 880, onde o papel
  // continua com 700 e mesmo assim o formulario colapsava.
  const folhaLarga = corpo.getBoundingClientRect().width > 620;
  const linha = document.querySelector('.mac-prefs__row');
  assert(linha, 'Preferencias: sem linha de formulario');
  if (folhaLarga) assert(getComputedStyle(linha).flexDirection === 'row', `folha de ${Math.round(corpo.getBoundingClientRect().width)}px e a linha colapsou como se a janela mandasse`);

  // O veu precisa ser visivel: com uma folha grande, 18% de preto sumia.
  const veu = document.querySelector('.MuiBackdrop-root');
  assert(veu, 'sem veu atras da folha');
  const opacidade = Number((getComputedStyle(veu).backgroundColor.match(/[\d.]+\)$/) || ['1)'])[0].replace(')', ''));
  assert(opacidade >= 0.3, `veu fraco demais, ${opacidade}`);

  await fechar();

  // A folha de pareamento, no mesmo primitivo, com o QR. Ela e a que colapsava
  // para uma coluna numa janela de 880 com os 700px do papel inteiros.
  const url = new URL(window.location.href);
  url.searchParams.delete('prefs');
  url.searchParams.set('pair', '1');
  url.searchParams.set('tunnel', 'demo');
  history.replaceState(null, '', url);
  window.dispatchEvent(new CustomEvent('cialai:pair-device'));
  await until(() => document.querySelector('.mac-pair'), 'folha de pareamento');
  await assentar('.MuiDialog-paper', 'Pareamento');
  const folhaPar = medirPapel('md', 'Pareamento').querySelector('.MuiDialogContent-root');
  const grade = getComputedStyle(document.querySelector('.mac-pair')).gridTemplateColumns;
  if (folhaPar.getBoundingClientRect().width > 620) {
    assert(grade.split(' ').length === 2, `folha de ${Math.round(folhaPar.getBoundingClientRect().width)}px e o pareamento caiu para uma coluna, veio ${grade}`);
  }

  // Por último, o caso que quebrou a 0.2.7 na máquina de verdade: o estilo que
  // o MUI injeta em tempo de execução não aplicou, e o diálogo caiu no fluxo do
  // documento, no canto de baixo, sem véu. Derrubar as folhas do emotion aqui
  // reproduz isso sem depender de a falha acontecer sozinha. Vem por último
  // porque destrói o resto da página.
  const folhas = [...document.querySelectorAll('style[data-emotion]')];
  assert(folhas.length > 0, 'nenhuma folha do emotion na página; a simulação não valeria');
  for (const folha of folhas) folha.remove();
  await pause(300);
  const orfa = document.querySelector('.MuiDialog-paper');
  assert(orfa, 'sem emotion: a folha sumiu');
  const raiz = document.querySelector('.MuiDialog-root');
  assert(getComputedStyle(raiz).position === 'fixed', 'sem emotion: o diálogo saiu da camada fixa e caiu no fluxo do documento');
  const caixa = getComputedStyle(document.querySelector('.MuiDialog-container'));
  assert(caixa.alignItems === 'center' && caixa.justifyContent === 'center', 'sem emotion: a folha deixou de ser centralizada');
  const veuOrfao = getComputedStyle(document.querySelector('.MuiBackdrop-root'));
  assert(veuOrfao.position === 'fixed', 'sem emotion: o véu saiu da camada fixa');
  assert(!/rgba\(0, 0, 0, 0\)|transparent/.test(veuOrfao.backgroundColor), `sem emotion: o véu ficou sem cor, ${veuOrfao.backgroundColor}`);
  const sem = orfa.getBoundingClientRect();
  assert(Math.abs(sem.width - LARGURA.md) <= 1, `sem emotion: papel com ${Math.round(sem.width)}px de largura`);
  assert(sem.top >= -1 && sem.bottom <= window.innerHeight + 1 && sem.left >= -1, `sem emotion: folha fora da janela, topo ${Math.round(sem.top)} esquerda ${Math.round(sem.left)}`);

  document.title = `PASS: Cialai dialog geometry at ${window.innerWidth}x${window.innerHeight}, ${contas} accounts in a ${LARGURA.md}px sheet, body scrolls inside, sections measure the sheet, and it survives losing the runtime styles`;
}

main().catch((error) => {
  document.title = `FAIL: ${error.message}`;
  console.error('[dialog-check]', error);
});
