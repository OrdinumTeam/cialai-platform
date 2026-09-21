// SPDX-License-Identifier: Apache-2.0
// Gera os tres PNGs de `apps/desktop/design/` a partir da marca branca.
//
// O icone segue o mesmo desenho dos apps irmaos da Ordinum: fundo com o
// gradiente da cor da marca, ocupando o quadro inteiro, e o simbolo em branco
// por cima. A versao branca da marca traz so antenas, olhos e boca; petala e
// face ficam vazadas, e o fundo aparece por elas.
//
// Duas decisoes que vieram de olhar o icone do Ordinum e o Dock deste macOS:
//
// O arquivo e um QUADRADO CHEIO, sem cantos arredondados desenhados. Este
// macOS aplica a mascara do sistema sozinho. O icone anterior trazia um
// squircle ja desenhado dentro de um quadro transparente, entao o sistema
// mascarava algo que ja era menor: ele aparecia encolhido ao lado dos vizinhos,
// com a borda da placa visivel dentro do quadro.
//
// O gradiente e vertical, do magenta orquidea no topo ao rosa quente embaixo.
//
// Uso:
//   node tools/brand/build-app-icons.mjs            grava os tres arquivos
//   node tools/brand/build-app-icons.mjs --medir    so imprime as medidas
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decode, empty, encode, paint, resample } from './png.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/// Gradiente vertical, do topo para a base. Cores da marca.
export const TOPO = [226, 59, 132];
export const BASE = [255, 122, 178];
/// Altura do simbolo sobre a altura do quadro.
export const ALTURA_MARCA = 0.7;
/// Zona segura do icone adaptativo do Android, 66 dp de 108 dp.
const TILE_ANDROID = 622;
/// Marca que a interface usa na barra lateral, na abertura e no primeiro uso.
/// Sai da versao preta porque o CSS a inverte para branco no tema escuro, e
/// porque importar o master de 4096 px custava 4 MB na primeira pintura.
const MARCA_INTERFACE = { arquivo: 'packages/ui/src/assets/cialai-mark-256.png', tamanho: 256 };

const ALVOS = [
  // O iOS aplica a propria mascara e exige origem opaca, sem canal alfa.
  { arquivo: 'app-icon-1024.png', fundo: true, alpha: false },
  // macOS, Windows e Linux. Alfa cheio: a mascara e do sistema.
  { arquivo: 'desktop-icon-1024.png', fundo: true, alpha: true },
  // Primeiro plano do icone adaptativo: so o simbolo, sobre o fundo que o
  // app.config.ts define. Por isso aqui o fundo nao entra.
  { arquivo: 'android-foreground-1024.png', fundo: false, alpha: true, tile: TILE_ANDROID },
];

const CANVAS = 1024;

/// Caixa com tinta, pelo canal alfa.
export function medir(imagem) {
  let x0 = imagem.width; let x1 = -1; let y0 = imagem.height; let y1 = -1;
  for (let y = 0; y < imagem.height; y += 1) {
    for (let x = 0; x < imagem.width; x += 1) {
      if (imagem.pixels[(y * imagem.width + x) * 4 + 3] <= 16) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  if (x1 < 0) throw new Error('imagem sem tinta');
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

export function gradiente(canvas, topo, base) {
  const imagem = empty(canvas, canvas);
  for (let y = 0; y < canvas; y += 1) {
    const t = canvas === 1 ? 0 : y / (canvas - 1);
    const cor = [0, 1, 2].map((c) => Math.round(topo[c] + (base[c] - topo[c]) * t));
    for (let x = 0; x < canvas; x += 1) {
      const i = (y * canvas + x) * 4;
      imagem.pixels[i] = cor[0];
      imagem.pixels[i + 1] = cor[1];
      imagem.pixels[i + 2] = cor[2];
      imagem.pixels[i + 3] = 255;
    }
  }
  return imagem;
}

function montar(alvo, marca, caixa) {
  const base = alvo.fundo ? gradiente(CANVAS, TOPO, BASE) : empty(CANVAS, CANVAS);
  const tile = alvo.tile || CANVAS;
  const altura = Math.round(tile * ALTURA_MARCA);
  const largura = Math.max(1, Math.round((caixa.width * altura) / caixa.height));
  paint(base, resample(marca, caixa, largura, altura), Math.round((CANVAS - largura) / 2), Math.round((CANVAS - altura) / 2));
  return { base, largura, altura, tile };
}

function main() {
  const marca = decode(readFileSync(`${root}brand/logo/cialai-mantis-v4-1-head-4k-white.png`));
  const caixa = medir(marca);
  const somenteMedir = process.argv.includes('--medir');
  console.log(`marca branca ${marca.width}x${marca.height}, caixa ${caixa.width}x${caixa.height}`);
  console.log(`gradiente rgb(${TOPO}) no topo para rgb(${BASE}) na base, simbolo em ${(ALTURA_MARCA * 100).toFixed(0)}% do quadro`);
  for (const alvo of ALVOS) {
    const { base, largura, altura, tile } = montar(alvo, marca, caixa);
    console.log(`${alvo.arquivo}: ${largura}x${altura} sobre ${tile}, ${alvo.fundo ? 'com gradiente' : 'so o simbolo'}`);
    if (somenteMedir) continue;
    writeFileSync(`${root}apps/desktop/design/${alvo.arquivo}`, encode(base, { alpha: alvo.alpha }));
  }

  if (!somenteMedir) {
    const preta = decode(readFileSync(`${root}brand/logo/cialai-mantis-v4-1-head-4k-black.png`));
    const caixaPreta = medir(preta);
    const lado = MARCA_INTERFACE.tamanho;
    const altura = Math.round(lado * 0.92);
    const largura = Math.max(1, Math.round((caixaPreta.width * altura) / caixaPreta.height));
    const marcaUi = empty(lado, lado);
    paint(marcaUi, resample(preta, caixaPreta, largura, altura), Math.round((lado - largura) / 2), Math.round((lado - altura) / 2));
    writeFileSync(`${root}${MARCA_INTERFACE.arquivo}`, encode(marcaUi, { alpha: true }));
    console.log(`${MARCA_INTERFACE.arquivo}: ${largura}x${altura} em ${lado}, da marca preta`);
    console.log('gravados. rode `npm run icon --workspace @cialai/desktop` para os derivados do desktop');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
