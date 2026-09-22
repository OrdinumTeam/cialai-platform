// SPDX-License-Identifier: Apache-2.0
// Gera os assets de marca do site a partir das mesmas fontes do app.
//
// O simbolo mudou: passou a ser so antenas, olhos e boca, nas versoes branca e
// preta, e o icone virou o gradiente da marca com o simbolo em branco. O site
// carregava o desenho anterior em favicon, marca e atalho do iPhone, entao ele
// ficaria fora de compasso com o aplicativo.
//
// Cada arquivo sai com AS MESMAS dimensoes do que ele substitui, e o simbolo e
// encaixado dentro preservando a proporcao. Assim nada no HTML precisa mudar e
// nada distorce.
//
// Uso: node tools/brand/build-site-brand.mjs [caminho do site]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decode, empty, encode, paint, resample } from './png.mjs';
import { medir } from './build-app-icons.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const site = process.argv[2] || join(root, '..', 'cialai-website');
const destino = join(site, 'assets', 'img', 'brand');

/// Encaixa o simbolo num quadro do tamanho pedido, preservando a proporcao e
/// deixando o resto transparente. Manter o tamanho evita mexer no HTML.
function encaixar(marca, caixa, largura, altura, folga = 1) {
  const quadro = empty(largura, altura);
  const escala = Math.min((largura * folga) / caixa.width, (altura * folga) / caixa.height);
  const w = Math.max(1, Math.round(caixa.width * escala));
  const h = Math.max(1, Math.round(caixa.height * escala));
  paint(quadro, resample(marca, caixa, w, h), Math.round((largura - w) / 2), Math.round((altura - h) / 2));
  return quadro;
}

function webp(origem, saida, qualidade = 90) {
  try {
    execFileSync('cwebp', ['-quiet', '-q', String(qualidade), '-alpha_q', '100', origem, '-o', saida]);
    return true;
  } catch (_erro) {
    return false;
  }
}

function main() {
  if (!existsSync(destino)) throw new Error(`nao achei os assets do site em ${destino}`);
  const preta = decode(readFileSync(`${root}brand/logo/cialai-mantis-v4-1-head-4k-black.png`));
  const branca = decode(readFileSync(`${root}brand/logo/cialai-mantis-v4-1-head-4k-white.png`));
  // Duas formas da mesma peca. O favicon fica com a placa recortada, para a
  // aba do navegador mostrar o canto arredondado e nao um quadrado branco. O
  // atalho do iPhone fica com a versao opaca, porque o iOS compoe o que for
  // transparente sobre preto.
  const placa = decode(readFileSync(`${root}brand/logo/cialai-icon.png`));
  const opaco = decode(readFileSync(`${root}apps/desktop/design/app-icon-1024.png`));
  const caixaPreta = medir(preta);
  const caixaBranca = medir(branca);
  const temporario = tmpdir();
  const escritos = [];

  // Simbolo, nas duas cores, no tamanho que o site ja usa.
  const marcas = [
    ['cialai-mark.png', preta, caixaPreta, 681, 1024],
    ['cialai-mark-white.png', branca, caixaBranca, 679, 1024],
  ];
  for (const [nome, fonte, caixa, largura, altura] of marcas) {
    const png = encode(encaixar(fonte, caixa, largura, altura), { alpha: true });
    writeFileSync(join(destino, nome), png);
    escritos.push(`${nome} ${largura}x${altura}`);
    const comWebp = join(destino, nome.replace(/\.png$/, '.webp'));
    if (webp(join(destino, nome), comWebp)) escritos.push(`${nome.replace(/\.png$/, '.webp')}`);
  }

  // Versoes pequenas que o site referencia com largura e altura fixas.
  const pequenas = [
    ['cialai-mark-120.webp', preta, caixaPreta, 120, 181],
    ['cialai-mark-white-72.webp', branca, caixaBranca, 72, 109],
  ];
  for (const [nome, fonte, caixa, largura, altura] of pequenas) {
    const bruto = join(temporario, nome.replace(/\.webp$/, '.png'));
    writeFileSync(bruto, encode(encaixar(fonte, caixa, largura, altura), { alpha: true }));
    if (webp(bruto, join(destino, nome))) escritos.push(`${nome} ${largura}x${altura}`);
  }

  // Favicon e atalho do iPhone: o mesmo icone do aplicativo.
  const quadrados = [
    ['favicon-32.png', 32, placa], ['favicon-64.png', 64, placa],
    ['favicon-192.png', 192, placa], ['favicon-512.png', 512, placa],
    ['apple-touch-icon.png', 180, opaco],
  ];
  for (const [nome, lado, fonte] of quadrados) {
    const inteiro = { x: 0, y: 0, width: fonte.width, height: fonte.height };
    writeFileSync(join(destino, nome), encode(resample(fonte, inteiro, lado, lado), { alpha: true }));
    escritos.push(`${nome} ${lado}x${lado}`);
  }

  for (const linha of escritos) console.log(`  ${linha}`);
  console.log(`${escritos.length} arquivos gravados em ${destino}`);
  console.log('a assinatura horizontal continua sendo peca de design, feita fora daqui');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
