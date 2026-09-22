// SPDX-License-Identifier: Apache-2.0
// Confere os tres PNGs de origem do icone, decodificando na mao para nao
// depender de biblioteca de imagem.
//
// O icone e a cabeca do louva-a-deus em cores sobre placa branca arredondada.
// O que este portao guarda e o ENQUADRAMENTO, que e o que se perde numa
// regeracao distraida e o que muda de alvo para alvo:
//
// No celular a placa ocupa o quadro inteiro e o arquivo e opaco, sem canal
// alfa. O iOS recusa alfa na origem do icone, e quem arredonda e ele.
//
// No macOS a placa recua para a grade do sistema, 824 de 1024 px, com margem
// transparente. Sem o recuo o icone encosta nos vizinhos do Dock.
//
// No Android o primeiro plano e so a arte, e ela tem que caber na zona segura
// de 66 dp, senao alguma mascara de fabricante corta a antena.
//
// Os numeros sao lidos do proprio gerador, para arquivo e codigo nao
// divergirem em silencio.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { PLACA_MACOS } from '../brand/build-app-icons.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const CANVAS = 1024;
/// Zona segura do icone adaptativo do Android, 66 dp de 108 dp.
const SEGURA_ANDROID = Math.round((CANVAS * 66) / 108);

function decode(path) {
  const png = readFileSync(path);
  assert.equal(png.subarray(1, 4).toString(), 'PNG', `${path} nao e PNG`);
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  const parts = [];
  while (offset < png.length) {
    const size = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString();
    const data = png.subarray(offset + 8, offset + 8 + size);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      color = data[9];
      assert.equal(data[12], 0, `${path} nao pode ser entrelacado`);
    }
    if (type === 'IDAT') parts.push(data);
    offset += size + 12;
  }
  assert.equal(depth, 8, `${path} precisa de profundidade 8`);
  const channels = color === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(parts));
  const pixels = Buffer.alloc(stride * height);
  let input = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[input];
    input += 1;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[input + x];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let decoded;
      if (filter === 0) decoded = value;
      else if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + up;
      else if (filter === 3) decoded = value + Math.floor((left + up) / 2);
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const dLeft = Math.abs(estimate - left);
        const dUp = Math.abs(estimate - up);
        const dDiagonal = Math.abs(estimate - upLeft);
        decoded = value + (dLeft <= dUp && dLeft <= dDiagonal ? left : dUp <= dDiagonal ? up : upLeft);
      } else throw new Error(`filtro PNG sem suporte em ${path}: ${filter}`);
      pixels[y * stride + x] = decoded & 0xff;
    }
    input += stride;
  }
  const at = (x, y) => {
    const i = y * stride + x * channels;
    return [pixels[i], pixels[i + 1], pixels[i + 2], channels === 4 ? pixels[i + 3] : 255];
  };
  return { width, height, color, channels, at };
}

/// Caixa do que nao e transparente, e caixa do que tem cor, ignorando o branco
/// da placa. A segunda e a arte.
function caixas(imagem) {
  const opaco = { x0: imagem.width, x1: -1, y0: imagem.height, y1: -1 };
  const arte = { x0: imagem.width, x1: -1, y0: imagem.height, y1: -1 };
  let rosa = 0;
  let ameixa = 0;
  for (let y = 0; y < imagem.height; y += 1) {
    for (let x = 0; x < imagem.width; x += 1) {
      const [r, g, b, a] = imagem.at(x, y);
      if (a > 16) {
        if (x < opaco.x0) opaco.x0 = x;
        if (x > opaco.x1) opaco.x1 = x;
        if (y < opaco.y0) opaco.y0 = y;
        opaco.y1 = y;
      }
      if (a < 200 || (r > 245 && g > 245 && b > 245)) continue;
      if (x < arte.x0) arte.x0 = x;
      if (x > arte.x1) arte.x1 = x;
      if (y < arte.y0) arte.y0 = y;
      arte.y1 = y;
      if (r > 200 && b > 140 && g < 190) rosa += 1;
      if (r > 30 && r < 110 && g < 70 && b < 100) ameixa += 1;
    }
  }
  const medida = (caixa) => ({ x: caixa.x0, y: caixa.y0, width: caixa.x1 - caixa.x0 + 1, height: caixa.y1 - caixa.y0 + 1 });
  return { opaco: medida(opaco), arte: medida(arte), rosa, ameixa };
}

// iPhone, Android como icone simples e favicon: placa no quadro inteiro, e o
// arquivo opaco porque o iOS recusa canal alfa na origem.
const caminhoMovel = `${root}apps/desktop/design/app-icon-1024.png`;
assert.ok(existsSync(caminhoMovel), 'falta a origem do icone do celular');
const movel = decode(caminhoMovel);
assert.equal(movel.width, CANVAS);
assert.equal(movel.height, CANVAS);
assert.equal(movel.color, 2, 'a origem do celular precisa ser RGB opaco, sem canal alfa');
for (const [x, y] of [[0, 0], [CANVAS - 1, 0], [0, CANVAS - 1], [CANVAS - 1, CANVAS - 1]]) {
  const [r, g, b] = movel.at(x, y);
  assert.ok(r > 245 && g > 245 && b > 245, `o canto ${x},${y} do icone do celular deveria ser branco, veio rgb(${r},${g},${b})`);
}
const medidasMovel = caixas(movel);
assert.deepEqual(
  { width: medidasMovel.opaco.width, height: medidasMovel.opaco.height },
  { width: CANVAS, height: CANVAS },
  'a placa do celular precisa ocupar o quadro inteiro',
);

// macOS, Windows e Linux: a placa recua para a grade do sistema.
const desktop = decode(`${root}apps/desktop/design/desktop-icon-1024.png`);
assert.equal(desktop.width, CANVAS);
assert.equal(desktop.color, 6, 'a origem do desktop precisa de canal alfa para a margem');
const margem = Math.round((CANVAS - PLACA_MACOS) / 2);
const medidasDesktop = caixas(desktop);
assert.deepEqual(
  medidasDesktop.opaco,
  { x: margem, y: margem, width: PLACA_MACOS, height: PLACA_MACOS },
  `a placa do desktop precisa medir ${PLACA_MACOS} de ${CANVAS} e ficar centrada, que e a grade de icone do macOS`,
);
for (const [x, y] of [[0, 0], [CANVAS - 1, 0], [0, CANVAS - 1], [CANVAS - 1, CANVAS - 1], [512, margem - 20]]) {
  assert.equal(desktop.at(x, y)[3], 0, `o icone do desktop precisa de margem transparente em ${x},${y}`);
}
assert.equal(desktop.at(512, margem + 10)[3], 255, 'a placa do desktop precisa ser opaca por dentro');

// As duas placas carregam a arte, e na mesma proporcao, porque saem da mesma
// peca. A do desktop e menor na mesma medida em que a placa recuou.
const proporcaoMovel = medidasMovel.arte.height / CANVAS;
const proporcaoDesktop = medidasDesktop.arte.height / PLACA_MACOS;
assert.ok(proporcaoMovel > 0.8, `a arte do celular sumiu, so ${(proporcaoMovel * 100).toFixed(1)}% da altura`);
assert.ok(
  Math.abs(proporcaoMovel - proporcaoDesktop) < 0.02,
  `a arte deveria ocupar a mesma fracao das duas placas, veio ${(proporcaoMovel * 100).toFixed(1)}% e ${(proporcaoDesktop * 100).toFixed(1)}%`,
);
for (const [nome, medidas] of [['celular', medidasMovel], ['desktop', medidasDesktop]]) {
  assert.ok(medidas.rosa > 60_000, `o icone do ${nome} ficou sem o rosa da marca, so ${medidas.rosa} pixels`);
  assert.ok(medidas.ameixa > 8_000, `o icone do ${nome} ficou sem a ameixa das antenas, so ${medidas.ameixa} pixels`);
}

// Android: so a arte, sobre o branco que o app.config.ts define, e dentro da
// zona segura para nenhuma mascara de fabricante cortar a antena.
const android = decode(`${root}apps/desktop/design/android-foreground-1024.png`);
assert.equal(android.width, CANVAS);
assert.equal(android.color, 6, 'o primeiro plano do Android precisa de canal alfa');
assert.equal(android.at(4, 4)[3], 0, 'o primeiro plano do Android precisa nascer transparente');
const medidasAndroid = caixas(android);
assert.ok(medidasAndroid.rosa > 30_000, 'o primeiro plano do Android ficou sem a arte');
assert.ok(
  medidasAndroid.opaco.width <= SEGURA_ANDROID && medidasAndroid.opaco.height <= SEGURA_ANDROID,
  `a arte do Android mede ${medidasAndroid.opaco.width}x${medidasAndroid.opaco.height} e passa da zona segura de ${SEGURA_ANDROID}`,
);

const desktopPackage = JSON.parse(readFileSync(`${root}apps/desktop/package.json`, 'utf8'));
assert.match(desktopPackage.scripts.icon, /design\/desktop-icon-1024\.png$/);

// O fundo do icone adaptativo e a placa: a arte e colorida e vive sobre branco,
// igual ao que o iPhone mostra.
const config = readFileSync(`${root}apps/mobile/app.config.ts`, 'utf8');
const fundo = /backgroundColor:\s*'(#[0-9A-Fa-f]{6})'/.exec(config);
assert.ok(fundo, 'app.config.ts sem backgroundColor do icone adaptativo');
assert.equal(fundo[1].toUpperCase(), '#FFFFFF', 'o fundo do icone adaptativo e a placa branca, como no iPhone');

console.log(`PASS desktop icon: full bleed opaque plate for phones, ${PLACA_MACOS} of ${CANVAS} for the desktop grid, and an Android foreground inside the safe zone`);
