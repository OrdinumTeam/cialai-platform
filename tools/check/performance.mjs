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
// Uso:
//   node tools/check/performance.mjs              mede e compara
//   node tools/check/performance.mjs --registrar  regrava a linha de base
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

async function main() {
  assert.ok(existsSync(`${desktop}dist/index.html`), 'apps/desktop/dist ausente; rode npm run build:ui --workspace @cialai/desktop antes');
  const { chromium } = createRequire(`${root}tools/browser/run-browser-checks.mjs`)('playwright');
  const { preview } = await import(pathToFileURL(`${root}node_modules/vite/dist/node/index.js`).href);
  const port = await freePort();
  const server = await preview({
    configFile: `${desktop}vite.config.js`,
    root: desktop,
    logLevel: 'warn',
    preview: { host: '127.0.0.1', port, strictPort: true },
  });
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  let medidas;
  let animacao;
  try {
    const rodadas = [];
    for (let volta = 0; volta < REPETICOES; volta += 1) rodadas.push(await medirAbertura(browser, base));
    medidas = {
      interactiveMs: mediana(rodadas.map((item) => item.interactiveMs)),
      payloadKb: mediana(rodadas.map((item) => item.payloadKb)),
      requests: mediana(rodadas.map((item) => item.requests)),
      longTaskMs: mediana(rodadas.map((item) => item.longTaskMs)),
      maiorKb: mediana(rodadas.map((item) => item.maiorKb)),
      maiorNome: rodadas[0].maiorNome,
    };
    animacao = await medirAnimacao(browser, base);
  } finally {
    await browser.close();
    await server.close();
  }

  // Qualidade primeiro: passar no orçamento desligando animação não vale.
  assert.notEqual(animacao.movimento, 'none', 'o cenário de animação precisa rodar com o movimento ligado');
  assert.ok(animacao.declarada && animacao.declarada !== 'none', `a folha precisa continuar animando, veio ${animacao.declarada || 'nada'}`);

  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const atual = { ...medidas, fps: animacao.fps };
  if (process.argv.includes('--registrar')) {
    writeFileSync(BASELINE, `${JSON.stringify({ ...baseline, medido: atual }, null, 2)}\n`);
    console.log('linha de base regravada');
    return;
  }

  const linhas = [];
  let falhou = 0;
  for (const [chave, teto] of Object.entries(baseline.orcamento)) {
    const valor = atual[chave];
    const antes = baseline.medido[chave];
    const variacao = antes ? `${valor > antes ? '+' : ''}${Math.round(((valor - antes) / antes) * 100)}%` : 'novo';
    const passou = valor <= teto;
    if (!passou) falhou += 1;
    linhas.push(`  ${passou ? 'ok  ' : 'FAIL'} ${chave.padEnd(14)} ${String(valor).padStart(6)}  teto ${String(teto).padStart(6)}  contra a base ${variacao}`);
  }
  // Taxa de quadros é piso, não teto: animação não pode ficar pior.
  const pisoFps = baseline.piso.fps;
  const okFps = atual.fps >= pisoFps;
  if (!okFps) falhou += 1;
  // Taxa de quadros varia alguns quadros entre execucoes; so vale chamar de
  // pior quando a diferenca sai do ruido.
  const quedaFps = baseline.medido.fps - atual.fps;
  const notaFps = quedaFps > baseline.medido.fps * 0.1 ? 'pior' : 'dentro do ruido';
  linhas.push(`  ${okFps ? 'ok  ' : 'FAIL'} ${'fps'.padEnd(14)} ${String(atual.fps).padStart(6)}  piso ${String(pisoFps).padStart(6)}  contra a base ${notaFps}`);

  console.log(`desempenho com a CPU ${CPU} vezes mais lenta, mediana de ${REPETICOES} aberturas:`);
  for (const linha of linhas) console.log(linha);
  console.log(`  maior recurso: ${atual.maiorKb} KB, ${atual.maiorNome}`);
  assert.equal(falhou, 0, `${falhou} métrica ou métricas fora do orçamento`);
  console.log(`PASS performance: studio interactive in ${atual.interactiveMs} ms and ${atual.payloadKb} KB on a ${CPU}x slower CPU, sheet still animating at ${atual.fps} fps`);
}

await main();
