// SPDX-License-Identifier: Apache-2.0
// Confere os tres PNGs de origem do icone, decodificando na mao para nao
// depender de biblioteca de imagem.
//
// O icone segue o desenho dos apps irmaos da Ordinum: gradiente da cor da
// marca ocupando o quadro inteiro e o simbolo em branco por cima. Duas coisas
// aqui nao sao detalhe:
//
// O arquivo do desktop precisa ser OPACO de ponta a ponta. Este macOS aplica a
// mascara do sistema; um squircle ja desenhado dentro de um quadro
// transparente faz o icone nascer menor que os vizinhos no Dock, que foi o
// defeito que essa versao corrigiu.
//
// E o gradiente e cruzado com as constantes do gerador, para o arquivo e o
// codigo nao divergirem em silencio.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { ALTURA_MARCA, BASE, TOPO } from '../brand/build-app-icons.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

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

const perto = (a, b, folga = 12) => a.every((valor, i) => Math.abs(valor - b[i]) <= folga);

// iOS e Expo: quadrado opaco, sem canal alfa, com o gradiente e o simbolo.
const mobile = `${root}apps/desktop/design/app-icon-1024.png`;
assert.ok(existsSync(mobile), 'falta a origem do icone do celular');
const movel = decode(mobile);
assert.equal(movel.width, 1024);
assert.equal(movel.height, 1024);
assert.equal(movel.color, 2, 'a origem do celular precisa ser RGB opaco, sem canal alfa');

// Desktop: quadrado de ponta a ponta. A mascara e do sistema, nao do arquivo.
const desktopPath = `${root}apps/desktop/design/desktop-icon-1024.png`;
const desktop = decode(desktopPath);
assert.equal(desktop.width, 1024);
assert.equal(desktop.color, 6, 'a origem do desktop precisa de canal alfa');
for (const [x, y] of [[0, 0], [1023, 0], [0, 1023], [1023, 1023], [512, 0], [0, 512]]) {
  assert.equal(desktop.at(x, y)[3], 255, `o icone do desktop precisa ser opaco em ${x},${y}; o canto transparente faz o sistema encolher o icone no Dock`);
}

// O gradiente do arquivo e o do gerador precisam ser o mesmo.
for (const imagem of [movel, desktop]) {
  assert.ok(perto(imagem.at(512, 2).slice(0, 3), TOPO), `o topo do gradiente deveria ser rgb(${TOPO}), veio rgb(${imagem.at(512, 2).slice(0, 3)})`);
  assert.ok(perto(imagem.at(512, 1021).slice(0, 3), BASE), `a base do gradiente deveria ser rgb(${BASE}), veio rgb(${imagem.at(512, 1021).slice(0, 3)})`);
  assert.ok(imagem.at(512, 1021)[0] + imagem.at(512, 1021)[2] > imagem.at(512, 2)[0] + imagem.at(512, 2)[2], 'o gradiente precisa clarear de cima para baixo');
}

// O simbolo em branco precisa existir, e com a altura que o gerador declara.
function marcaBranca(imagem) {
  let pixels = 0;
  let topo = imagem.height;
  let base = -1;
  for (let y = 0; y < imagem.height; y += 1) {
    for (let x = 0; x < imagem.width; x += 1) {
      const [r, g, b, a] = imagem.at(x, y);
      if (a < 200 || r < 245 || g < 245 || b < 245) continue;
      pixels += 1;
      if (y < topo) topo = y;
      base = y;
    }
  }
  return { pixels, altura: base - topo + 1 };
}
for (const [nome, imagem] of [['celular', movel], ['desktop', desktop]]) {
  const marca = marcaBranca(imagem);
  assert.ok(marca.pixels > 30_000, `o simbolo branco do ${nome} sumiu, so ${marca.pixels} pixels`);
  const esperada = Math.round(1024 * ALTURA_MARCA);
  assert.ok(Math.abs(marca.altura - esperada) <= 12, `o simbolo do ${nome} deveria medir ${esperada}px de altura, veio ${marca.altura}`);
}

// Android: só o símbolo, sobre o fundo que o app.config.ts define.
const android = decode(`${root}apps/desktop/design/android-foreground-1024.png`);
assert.equal(android.width, 1024);
assert.equal(android.color, 6, 'o primeiro plano do Android precisa de canal alfa');
assert.equal(android.at(4, 4)[3], 0, 'o primeiro plano do Android precisa nascer transparente');
assert.ok(marcaBranca(android).pixels > 10_000, 'o primeiro plano do Android ficou sem o simbolo');

const desktopPackage = JSON.parse(readFileSync(`${root}apps/desktop/package.json`, 'utf8'));
assert.match(desktopPackage.scripts.icon, /design\/desktop-icon-1024\.png$/);

// O fundo do icone adaptativo precisa acompanhar o gradiente, senao o simbolo
// branco cai sobre branco e some.
const config = readFileSync(`${root}apps/mobile/app.config.ts`, 'utf8');
const fundo = /backgroundColor:\s*'(#[0-9A-Fa-f]{6})'/.exec(config);
assert.ok(fundo, 'app.config.ts sem backgroundColor do icone adaptativo');
assert.notEqual(fundo[1].toUpperCase(), '#FFFFFF', 'o simbolo branco do Android nao pode cair sobre fundo branco');

console.log('PASS desktop icon: gradient brand icon edge to edge, white symbol at the declared height, opaque desktop source and a transparent Android foreground');
