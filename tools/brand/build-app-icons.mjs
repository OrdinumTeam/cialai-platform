// SPDX-License-Identifier: Apache-2.0
// Gera os tres PNGs de `apps/desktop/design/` e a marca da interface.
//
// O icone e a cabeca do louva-a-deus em cores sobre placa branca arredondada.
// Ele vem pronto de duas pecas da marca, e nada aqui redesenha forma:
//
//   `cialai-icon.png`     placa branca arredondada com a arte dentro
//   `cialai-icon-v2.png`  a mesma arte, sem a placa
//
// As duas trazem a arte no mesmo lugar e no mesmo tamanho, 87,6% da altura do
// quadro, entao a segunda e a primeira sem o fundo. Por isso a placa do desktop
// sai da propria peca aprovada, reduzida, e nao de um retangulo arredondado
// desenhado aqui: a curva e a do designer.
//
// A diferenca entre os alvos e so o enquadramento, e cada um tem um motivo:
//
// No iPhone e no Android a placa ocupa o quadro inteiro, porque quem recorta e
// o sistema. No iOS o arquivo ainda precisa ser opaco, sem canal alfa, entao os
// cantos que a placa deixa de fora viram branco; o recorte do iOS os come.
//
// No macOS a placa recua para a grade do sistema, 824 de 1024 px, com a margem
// transparente que o Dock espera. E a mesma grade dos aplicativos que vem com o
// sistema, e sem ela o icone encosta nos vizinhos.
//
// Uso:
//   node tools/brand/build-app-icons.mjs            grava os arquivos
//   node tools/brand/build-app-icons.mjs --medir    so imprime as medidas
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decode, empty, encode, fill, paint, resample } from './png.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

const CANVAS = 1024;
/// Grade de icone do macOS: corpo de 824 px em tela de 1024, margem de 100.
export const PLACA_MACOS = 824;
/// Mascara do icone adaptativo do Android, 72 dp de 108 dp, e a zona segura,
/// 66 dp. A arte segue a mascara e ainda assim cabe na zona segura.
const MASCARA_ANDROID = Math.round((CANVAS * 72) / 108);
const SEGURA_ANDROID = Math.round((CANVAS * 66) / 108);
/// Marca que a interface usa na barra lateral, na abertura e no primeiro uso.
/// Sai da versao preta porque o CSS a inverte para branco no tema escuro, e
/// porque importar o master de 4096 px custava 4 MB na primeira pintura.
const MARCA_INTERFACE = { arquivo: 'packages/ui/src/assets/cialai-mark-256.png', tamanho: 256 };

const ICONE = 'brand/logo/cialai-icon.png';
const ARTE = 'brand/logo/cialai-icon-v2.png';

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

/// Quadro inteiro, para reamostrar a peca sem recortar nada dela.
function quadro(imagem) {
  return { x: 0, y: 0, width: imagem.width, height: imagem.height };
}

/// A peca inteira reduzida e centrada numa tela de 1024.
function placa(icone, lado) {
  const tela = empty(CANVAS, CANVAS);
  const canto = Math.round((CANVAS - lado) / 2);
  paint(tela, resample(icone, quadro(icone), lado, lado), canto, canto);
  return tela;
}

/// Fracao da altura do quadro que a arte ocupa na peca aprovada.
export function proporcaoDaArte(icone) {
  return medir(icone).height / icone.height;
}

function main() {
  const icone = decode(readFileSync(`${root}${ICONE}`));
  const arte = decode(readFileSync(`${root}${ARTE}`));
  const caixa = medir(arte);
  const fracao = caixa.height / arte.height;
  const somenteMedir = process.argv.includes('--medir');
  console.log(`placa ${icone.width}x${icone.height}, arte ${caixa.width}x${caixa.height}, ${(fracao * 100).toFixed(1)}% da altura`);

  // iPhone, Android como icone simples e favicon do site. Placa no quadro
  // inteiro, e os cantos em branco porque o iOS recusa canal alfa.
  const movel = fill(empty(CANVAS, CANVAS), [255, 255, 255, 255]);
  paint(movel, resample(icone, quadro(icone), CANVAS, CANVAS), 0, 0);
  console.log(`app-icon-1024.png: placa em ${CANVAS} de ${CANVAS}, opaca, sem alfa`);

  // macOS, Windows e Linux. A placa recua para a grade do sistema.
  const desktop = placa(icone, PLACA_MACOS);
  console.log(`desktop-icon-1024.png: placa em ${PLACA_MACOS} de ${CANVAS}, margem transparente de ${(CANVAS - PLACA_MACOS) / 2}`);

  // Primeiro plano do icone adaptativo: so a arte, sobre o branco que o
  // `app.config.ts` define. Dimensionada pela mascara, nao pelo quadro, e
  // conferida contra a zona segura.
  const altura = Math.round(MASCARA_ANDROID * fracao);
  const largura = Math.max(1, Math.round((caixa.width * altura) / caixa.height));
  if (altura > SEGURA_ANDROID || largura > SEGURA_ANDROID) {
    throw new Error(`a arte ${largura}x${altura} passa da zona segura de ${SEGURA_ANDROID}`);
  }
  const android = empty(CANVAS, CANVAS);
  paint(android, resample(arte, caixa, largura, altura), Math.round((CANVAS - largura) / 2), Math.round((CANVAS - altura) / 2));
  console.log(`android-foreground-1024.png: arte ${largura}x${altura}, mascara ${MASCARA_ANDROID}, zona segura ${SEGURA_ANDROID}`);

  if (somenteMedir) return;
  writeFileSync(`${root}apps/desktop/design/app-icon-1024.png`, encode(movel, { alpha: false }));
  writeFileSync(`${root}apps/desktop/design/desktop-icon-1024.png`, encode(desktop, { alpha: true }));
  writeFileSync(`${root}apps/desktop/design/android-foreground-1024.png`, encode(android, { alpha: true }));

  const preta = decode(readFileSync(`${root}brand/logo/cialai-mantis-v4-1-head-4k-black.png`));
  const caixaPreta = medir(preta);
  const lado = MARCA_INTERFACE.tamanho;
  const alturaUi = Math.round(lado * 0.92);
  const larguraUi = Math.max(1, Math.round((caixaPreta.width * alturaUi) / caixaPreta.height));
  const marcaUi = empty(lado, lado);
  paint(marcaUi, resample(preta, caixaPreta, larguraUi, alturaUi), Math.round((lado - larguraUi) / 2), Math.round((lado - alturaUi) / 2));
  writeFileSync(`${root}${MARCA_INTERFACE.arquivo}`, encode(marcaUi, { alpha: true }));
  console.log(`${MARCA_INTERFACE.arquivo}: ${larguraUi}x${alturaUi} em ${lado}, da marca preta`);
  console.log('gravados. rode `npm run icon --workspace @cialai/desktop` para os derivados do desktop');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
