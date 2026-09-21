// SPDX-License-Identifier: Apache-2.0
// Checks de navegador da interface por Playwright. Sobe o Vite do desktop numa porta livre, abre as
// entradas com dados fictícios e espera o título PASS gravado pelos roteiros de packages/ui/scripts.
//
// Duas origens. `dev` é o servidor de desenvolvimento, que é o que sempre se
// usou. `build` serve `apps/desktop/dist` por `preview`, porque parte do que
// quebra só existe em produção: a ordem dos pedaços do Vite e o modo de
// inserção do emotion, que lá injeta por CSSOM. O cenário da geometria dos
// diálogos roda nessa segunda origem de propósito.
import { existsSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const desktop = fileURLToPath(new URL('../../apps/desktop/', import.meta.url));
const TIMEOUT_MS = 90000;

export const SCENARIOS = [
  {
    name: 'desktop studio',
    path: '/?terminais=demo&motion=0&platform=macos#terminais',
    viewport: { width: 1440, height: 960 },
    script: 'packages/ui/scripts/check-studio-browser.js',
  },
  {
    name: 'desktop network',
    path: '/?terminais=demo&motion=0&platform=macos&tunnel=demo&network-check=1',
    viewport: { width: 1440, height: 960 },
  },
  {
    name: 'phone terminal',
    path: '/mobile.html?terminais=demo&motion=0&platform=macos',
    viewport: { width: 393, height: 852 },
    script: 'packages/ui/scripts/check-studio-browser.js',
  },
  {
    name: 'desktop dialog geometry',
    origin: 'build',
    path: '/index.html?prefs=notch&notch=demo:many&dialog-check=1&motion=0&platform=macos',
    viewport: { width: 1440, height: 900 },
  },
  // Janela estreita com folha larga: é onde as consultas presas à janela
  // erravam, colapsando a grade do QR com os 700 px do papel inteiros.
  {
    name: 'desktop dialog geometry on a narrow window',
    origin: 'build',
    path: '/index.html?prefs=notch&notch=demo:many&dialog-check=1&motion=0&platform=macos',
    viewport: { width: 880, height: 820 },
  },
];

// Arquivos fora da raiz do Vite são servidos pelo prefixo /@fs com o caminho absoluto em barras normais.
export function viteFsPath(workspaceRoot, relative) {
  const absolute = `${workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '')}/${relative}`;
  return `/@fs${absolute.startsWith('/') ? '' : '/'}${absolute}`;
}

export function verdict(title) {
  if (title.startsWith('PASS')) return 'pass';
  if (title.startsWith('FAIL')) return 'fail';
  return 'pending';
}

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

// Os roteiros conferem textos em português e atalhos do macOS, então a página fixa idioma e sistema.
async function runScenario(browser, baseUrl, scenario) {
  const page = await browser.newPage({ viewport: scenario.viewport, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const problems = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  try {
    await page.goto(`${baseUrl}${scenario.path}`, { waitUntil: 'load' });
    let importing = Promise.resolve();
    if (scenario.script) {
      importing = page.evaluate((source) => import(source).then(() => undefined), viteFsPath(root, scenario.script));
    }
    const failure = importing.then(() => null, (error) => error);
    await page.waitForFunction(() => /^(PASS|FAIL)/.test(document.title), null, { timeout: TIMEOUT_MS })
      .catch(async (error) => {
        const imported = await Promise.race([failure, Promise.resolve(null)]);
        throw imported || error;
      });
    const title = await page.title();
    const importError = await Promise.race([failure, new Promise((resolve) => setTimeout(() => resolve(null), 500))]);
    if (verdict(title) !== 'pass' || importError) {
      throw new Error(`${title}${importError ? ` ${importError.message}` : ''}`);
    }
    return title;
  } catch (error) {
    const detail = problems.length ? `\n  ${problems.slice(0, 5).join('\n  ')}` : '';
    throw new Error(`${scenario.name}: ${error.message}${detail}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const { chromium } = await import('playwright');
  const { createServer, preview } = await import(pathToFileURL(`${root}node_modules/vite/dist/node/index.js`).href);
  const port = await freePort();
  const server = await createServer({
    configFile: `${desktop}vite.config.js`,
    root: desktop,
    logLevel: 'warn',
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  await server.listen();
  const origins = { dev: `http://127.0.0.1:${port}` };
  // O `preview` só existe se houver build. Sem ele o cenário da geometria
  // falha dizendo o que rodar, em vez de passar calado.
  let built = null;
  if (SCENARIOS.some((scenario) => scenario.origin === 'build')) {
    if (!existsSync(`${desktop}dist/index.html`)) throw new Error('apps/desktop/dist ausente; rode npm run build:ui --workspace @cialai/desktop antes');
    const buildPort = await freePort();
    built = await preview({
      configFile: `${desktop}vite.config.js`,
      root: desktop,
      logLevel: 'warn',
      preview: { host: '127.0.0.1', port: buildPort, strictPort: true },
    });
    origins.build = `http://127.0.0.1:${buildPort}`;
  }
  const browser = await chromium.launch();
  let failed = 0;
  try {
    for (const scenario of SCENARIOS) {
      try {
        const title = await runScenario(browser, origins[scenario.origin || 'dev'], scenario);
        console.log(`PASS ${scenario.name}: ${title.replace(/^PASS:\s*/, '')}`);
      } catch (error) {
        failed += 1;
        console.error(`FAIL ${error.message}`);
      }
    }
  } finally {
    await browser.close();
    await server.close();
    if (built) await built.close();
  }
  if (failed) process.exit(1);
  console.log(`PASS browser checks: ${SCENARIOS.length} scenarios in headless Chromium, ${SCENARIOS.filter((scenario) => scenario.origin === 'build').length} against the production build`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
