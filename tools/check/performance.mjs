// SPDX-License-Identifier: Apache-2.0
// Orçamento de desempenho da interface, medido num computador simulado mais
// simples e sobre o build de produção.
//
// Por que existe: o estúdio roda em máquinas modestas, e o custo de abrir o app
// só aparece quando a CPU é lenta. Sem número gravado, uma regressão entra sem
// ninguém ver. Este check mede, compara com a linha de base versionada e falha
// quando passa do orçamento, imprimindo a variação para a evolução ficar à
// vista.
//
// O que ele não faz: ganhar desempenho desligando animação. O cenário de
// animação roda com o movimento ligado e exige taxa de quadros mínima, então
// cortar animação para passar no check é impossível: o próprio check confere
// que a folha anima.
//
// A linha de base vale para o computador em que foi medida. O runner do GitHub
// é mais lento e muda de máquina a cada rodada: no mesmo código, a abertura
// variou de 1154 a 2483 ms. Lá o check compara este build com o da main,
// aberto alternado na mesma máquina, e reprova quando o tempo piora além da
// tolerância. Payload e requisições não dependem da máquina e seguem o teto.
//
// Uso:
//   node tools/check/performance.mjs                       mede e compara com a base
//   node tools/check/performance.mjs --registrar           regrava a linha de base
//   node tools/check/performance.mjs --comparar <dist>     compara com outro build, como o da main
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const desktop = `${root}apps/desktop/`;
const BASELINE = `${root}tools/check/performance-baseline.json`;

// Quatro vezes mais lento que esta máquina. É a faixa de um notebook de entrada
// de alguns anos atrás, que é o computador que este check protege.
const CPU = 4;
const REPETICOES = 3;
const VIEWPORT = { width: 1440, height: 900 };
// Na comparação cada build abre cinco vezes, alternando, e o tempo deste pode
// passar o da main em até 25% antes de reprovar.
const REPETICOES_COMPARACAO = 5;
const TOLERANCIA = 0.25;
const COMPARADAS = ['interactiveMs', 'longTaskMs'];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const mediana = (valores) => [...valores].sort((a, b) => a - b)[Math.floor(valores.length / 2)];

/// Uma abertura do estúdio, do zero, com a CPU afunilada.
async function medirAbertura(browser, base) {
  const page = await browser.newPage({ viewport: VIEWPORT, locale: 'pt-BR' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await page.addInitScript(() => {
    window.__longTask = 0;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__longTask += entry.duration;
      }).observe({ type: 'longtask', buffered: true });
    } catch (_error) { /* sem suporte a longtask */ }
  });
  const inicio = Date.now();
  await page.goto(`${base}/index.html?terminais=demo&motion=0&platform=macos#terminais`, { waitUntil: 'load' });
  await page.waitForSelector('.terminais-card', { timeout: 60_000 });
  const interactiveMs = Date.now() - inicio;
  const medido = await page.evaluate(() => {
    let bytes = 0;
    let maior = 0;
    let maiorNome = '';
    const recursos = performance.getEntriesByType('resource');
    for (const recurso of recursos) {
      const tamanho = recurso.encodedBodySize || 0;
      bytes += tamanho;
      if (tamanho > maior) { maior = tamanho; maiorNome = recurso.name.split('/').pop(); }
    }
    return {
      payloadKb: Math.round(bytes / 1024),
      requests: recursos.length,
      longTaskMs: Math.round(window.__longTask || 0),
      maiorKb: Math.round(maior / 1024),
      maiorNome,
    };
  });
  await page.close();
  return { interactiveMs, ...medido };
}

/// Abertura da folha de Preferências com doze contas e o movimento LIGADO.
/// Mede a taxa de quadros durante a animação e confirma que ela existe.
async function medirAnimacao(browser, base) {
  const page = await browser.newPage({ viewport: VIEWPORT, locale: 'pt-BR' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await page.goto(`${base}/index.html?prefs=notch&notch=demo:many&platform=macos`, { waitUntil: 'load' });
  await page.waitForSelector('.notch-prefs__profile', { timeout: 60_000 });
  const resultado = await page.evaluate(() => new Promise((resolve) => {
    const paper = document.querySelector('.MuiDialog-paper');
    const animado = Boolean(paper && paper.getAnimations && paper.getAnimations().length >= 0);
    const declarada = paper ? getComputedStyle(paper).animationName : '';
    let quadros = 0;
    const comeco = performance.now();
    const passo = () => {
      quadros += 1;
      if (performance.now() - comeco < 800) requestAnimationFrame(passo);
      else resolve({
        fps: Math.round((quadros / (performance.now() - comeco)) * 1000),
        animado,
        declarada,
        movimento: document.documentElement.dataset.motion || '',
      });
    };
    requestAnimationFrame(passo);
  }));
  await page.close();
  return resultado;
}

function resumo(rodadas) {
  return {
    interactiveMs: mediana(rodadas.map((item) => item.interactiveMs)),
    payloadKb: mediana(rodadas.map((item) => item.payloadKb)),
    requests: mediana(rodadas.map((item) => item.requests)),
    longTaskMs: mediana(rodadas.map((item) => item.longTaskMs)),
    maiorKb: mediana(rodadas.map((item) => item.maiorKb)),
    maiorNome: rodadas[0].maiorNome,
  };
}

function argumento(nome) {
  const indice = process.argv.indexOf(nome);
  return indice > 0 ? process.argv[indice + 1] : null;
}

async function main() {
  const registrar = process.argv.includes('--registrar');
  const comparar = argumento('--comparar');
  assert.ok(!(registrar && comparar), '--registrar e --comparar não andam juntos');
  if (comparar) assert.ok(existsSync(`${comparar}/index.html`), `${comparar}/index.html ausente; construa o build a comparar antes`);
  assert.ok(existsSync(`${desktop}dist/index.html`), 'apps/desktop/dist ausente; rode npm run build:ui --workspace @cialai/desktop antes');
  const { chromium } = createRequire(`${root}tools/browser/run-browser-checks.mjs`)('playwright');
  const { preview } = await import(pathToFileURL(`${root}node_modules/vite/dist/node/index.js`).href);
  const servir = async (outDir) => {
    const port = await freePort();
    const server = await preview({
      configFile: `${desktop}vite.config.js`,
      root: desktop,
      logLevel: 'warn',
      ...(outDir ? { build: { outDir } } : {}),
      preview: { host: '127.0.0.1', port, strictPort: true },
    });
    return { url: `http://127.0.0.1:${port}`, server };
  };
  const atual = await servir(null);
  const outro = comparar ? await servir(comparar) : null;
  const browser = await chromium.launch();
  let medidas;
  let referencia = null;
  let animacao;
  try {
    const rodadas = [];
    const rodadasOutro = [];
    const voltas = comparar ? REPETICOES_COMPARACAO : REPETICOES;
    for (let volta = 0; volta < voltas; volta += 1) {
      if (outro) rodadasOutro.push(await medirAbertura(browser, outro.url));
      rodadas.push(await medirAbertura(browser, atual.url));
    }
    medidas = resumo(rodadas);
    if (outro) referencia = resumo(rodadasOutro);
    animacao = await medirAnimacao(browser, atual.url);
  } finally {
    await browser.close();
    await atual.server.close();
    if (outro) await outro.server.close();
  }

  // Qualidade primeiro: passar no orçamento desligando animação não vale.
  assert.notEqual(animacao.movimento, 'none', 'o cenário de animação precisa rodar com o movimento ligado');
  assert.ok(animacao.declarada && animacao.declarada !== 'none', `a folha precisa continuar animando, veio ${animacao.declarada || 'nada'}`);

  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const atualMedido = { ...medidas, fps: animacao.fps };
  if (registrar) {
    writeFileSync(BASELINE, `${JSON.stringify({ ...baseline, medido: atualMedido }, null, 2)}\n`);
    console.log('linha de base regravada');
    return;
  }

  const linhas = [];
  let falhou = 0;
  for (const [chave, teto] of Object.entries(baseline.orcamento)) {
    const valor = atualMedido[chave];
    if (referencia && COMPARADAS.includes(chave)) {
      const antes = referencia[chave];
      const limite = Math.round(antes * (1 + TOLERANCIA));
      const passou = valor <= limite;
      if (!passou) falhou += 1;
      const variacao = antes ? `${valor > antes ? '+' : ''}${Math.round(((valor - antes) / antes) * 100)}%` : 'novo';
      linhas.push(`  ${passou ? 'ok  ' : 'FAIL'} ${chave.padEnd(14)} ${String(valor).padStart(6)}  main ${String(antes).padStart(6)}  limite ${String(limite).padStart(6)}  ${variacao}`);
      continue;
    }
    const antes = baseline.medido[chave];
    const variacao = antes ? `${valor > antes ? '+' : ''}${Math.round(((valor - antes) / antes) * 100)}%` : 'novo';
    const passou = valor <= teto;
    if (!passou) falhou += 1;
    linhas.push(`  ${passou ? 'ok  ' : 'FAIL'} ${chave.padEnd(14)} ${String(valor).padStart(6)}  teto ${String(teto).padStart(6)}  contra a base ${variacao}`);
  }
  // Taxa de quadros é piso, não teto: animação não pode ficar pior.
  const pisoFps = baseline.piso.fps;
  const okFps = atualMedido.fps >= pisoFps;
  if (!okFps) falhou += 1;
  // Taxa de quadros varia alguns quadros entre execucoes; so vale chamar de
  // pior quando a diferenca sai do ruido.
  const quedaFps = baseline.medido.fps - atualMedido.fps;
  const notaFps = quedaFps > baseline.medido.fps * 0.1 ? 'pior' : 'dentro do ruido';
  linhas.push(`  ${okFps ? 'ok  ' : 'FAIL'} ${'fps'.padEnd(14)} ${String(atualMedido.fps).padStart(6)}  piso ${String(pisoFps).padStart(6)}  contra a base ${notaFps}`);

  const cabecalho = referencia
    ? `desempenho com a CPU ${CPU} vezes mais lenta, mediana de ${REPETICOES_COMPARACAO} aberturas alternadas com ${comparar}, tolerância de ${TOLERANCIA * 100}%:`
    : `desempenho com a CPU ${CPU} vezes mais lenta, mediana de ${REPETICOES} aberturas:`;
  console.log(cabecalho);
  for (const linha of linhas) console.log(linha);
  console.log(`  maior recurso: ${atualMedido.maiorKb} KB, ${atualMedido.maiorNome}`);
  assert.equal(falhou, 0, `${falhou} métrica ou métricas fora do orçamento`);
  console.log(`PASS performance: studio interactive in ${atualMedido.interactiveMs} ms and ${atualMedido.payloadKb} KB on a ${CPU}x slower CPU${referencia ? `, against ${referencia.interactiveMs} ms on the compared build` : ''}, sheet still animating at ${atualMedido.fps} fps`);
}

await main();
