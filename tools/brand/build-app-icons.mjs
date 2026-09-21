// SPDX-License-Identifier: Apache-2.0
// Gera os tres PNGs de `apps/desktop/design/` a partir do master da marca.
//
// Ate aqui esses tres arquivos eram desenhados a mao e nada os regerava, o que
// deixava o enquadramento sem regra: a marca vinha de `brand/logo/cialai-icon.png`,
// que ja e o master com zoom, e acabava ocupando 87,7% da altura do tile, com
// 6,2% de respiro. No Dock isso le como moldura dentro de moldura.
//
// A regra agora e explicita e medida, nao desenhada. O enquadramento segue a
// MASSA SOLIDA da cabeca, isto e, as linhas em que ha tinta de verdade, e nao a
// caixa envolvente, que e esticada por tres pontas finas: o bico da petala, as
// pontas das antenas e o afunilamento da boca, que sozinho consome 14% da
// altura. Essas pontas passam a viver na margem.
//
// Uso:
//   node tools/brand/build-app-icons.mjs            grava os tres arquivos
//   node tools/brand/build-app-icons.mjs --medir    so imprime as medidas
//   node tools/brand/build-app-icons.mjs --folha    grava a folha de comparacao
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, empty, encode, fill, paint, resample } from './png.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Quanto da altura do tile a massa solida da cabeca deve ocupar. E a alavanca
// principal: subir engorda a cabeca e aproxima as pontas finas da borda.
export const ALVO_MASSA = 0.68;
// Teto da caixa envolvente sobre o tile, contando as pontas finas. Impede que
// a antena chegue a encostar quando o alvo acima subir.
export const TETO_CAIXA = 0.94;
// Uma linha conta como massa solida quando tem pelo menos um terco da largura
// da caixa envolvente. Duas antenas somam bem menos que isso, entao o criterio
// separa corpo de ponta sem depender da cor nem do tamanho do arquivo.
export const FRACAO_SOLIDA = 1 / 3;

// A interface mostra a marca a 20 px na barra lateral, 52 px na abertura e
// 64 px no primeiro uso. Ate aqui as tres telas importavam o master de 4096 px:
// 4 MB baixados e decodificados antes da primeira pintura, para desenhar algumas
// dezenas de pixels. Este derivado mantem o enquadramento do master, entao a
// aparencia nao muda, e corta a maior parte do custo de abrir o app.
const MARCA_INTERFACE = { arquivo: 'packages/ui/src/assets/cialai-mark-256.png', tamanho: 256 };

const ALVOS = [
  // O iOS aplica a propria mascara, entao a fonte e o quadrado branco cheio e
  // o tile e o canvas inteiro.
  { arquivo: 'app-icon-1024.png', canvas: 1024, tile: 1024, fundo: [255, 255, 255, 255], alpha: false },
  // A grade do macOS pede 824 px dentro de 1024, e o squircle e desenhado no
  // proprio arquivo porque o icns nao recebe mascara do sistema.
  { arquivo: 'desktop-icon-1024.png', canvas: 1024, tile: 824, mascara: true, alpha: true },
  // Zona segura de 66 dp em 108 dp do icone adaptativo do Android.
  { arquivo: 'android-foreground-1024.png', canvas: 1024, tile: 622, alpha: true },
];

/// Caixa envolvente e caixa da massa solida, em pixels da imagem de origem.
export function medir(image, { fracaoSolida = FRACAO_SOLIDA } = {}) {
  const linhas = [];
  let x0 = image.width; let x1 = -1; let y0 = image.height; let y1 = -1;
  for (let y = 0; y < image.height; y += 1) {
    let tinta = 0; let min = image.width; let max = -1;
    for (let x = 0; x < image.width; x += 1) {
      if (image.pixels[(y * image.width + x) * 4 + 3] <= 32) continue;
      tinta += 1;
      if (x < min) min = x;
      if (x > max) max = x;
    }
    linhas.push({ tinta, min, max });
    if (tinta === 0) continue;
    if (min < x0) x0 = min;
    if (max > x1) x1 = max;
    if (y0 > y) y0 = y;
    y1 = y;
  }
  if (x1 < 0) throw new Error('imagem sem tinta');
  const caixa = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  const limite = caixa.width * fracaoSolida;
  const solidas = linhas.map((linha, y) => ({ ...linha, y })).filter((linha) => linha.tinta >= limite);
  if (!solidas.length) throw new Error('imagem sem massa solida');
  const sx0 = Math.min(...solidas.map((linha) => linha.min));
  const sx1 = Math.max(...solidas.map((linha) => linha.max));
  const massa = { x: sx0, y: solidas[0].y, width: sx1 - sx0 + 1, height: solidas[solidas.length - 1].y - solidas[0].y + 1 };
  return { caixa, massa };
}

/// Escala e posicao da marca dentro de um tile, pela massa solida.
export function enquadrar({ caixa, massa }, { canvas, tile, alvo = ALVO_MASSA, teto = TETO_CAIXA }) {
  const escala = Math.min(
    (tile * alvo) / massa.height,
    (tile * teto) / caixa.height,
    (tile * teto) / caixa.width,
  );
  const largura = Math.max(1, Math.round(caixa.width * escala));
  const altura = Math.max(1, Math.round(caixa.height * escala));
  const centro = canvas / 2;
  // Centraliza pela massa solida, que e o que o olho le como centro, e nao
  // pela caixa envolvente, que a cauda da boca puxa para baixo.
  const massaCentroX = (massa.x - caixa.x + massa.width / 2) * escala;
  const massaCentroY = (massa.y - caixa.y + massa.height / 2) * escala;
  const borda = (canvas - tile) / 2 + (tile * (1 - teto)) / 2;
  const limitar = (valor, tamanho) => Math.round(Math.min(Math.max(valor, borda), canvas - borda - tamanho));
  return {
    escala,
    largura,
    altura,
    x: limitar(centro - massaCentroX, largura),
    y: limitar(centro - massaCentroY, altura),
  };
}

function marcaSobre(alvo, master, metricas) {
  const posicao = enquadrar(metricas, alvo);
  const marca = resample(master, metricas.caixa, posicao.largura, posicao.altura);
  const base = empty(alvo.canvas, alvo.canvas);
  if (alvo.fundo) fill(base, alvo.fundo);
  let mascara = null;
  if (alvo.mascara) {
    // O squircle aprovado vem do arquivo atual: reaproveitar o canal alfa
    // preserva a curva exata da grade, em vez de redesenhar uma superelipse.
    const atual = decode(readFileSync(`${root}apps/desktop/design/${alvo.arquivo}`));
    mascara = atual;
    for (let i = 0; i < atual.width * atual.height; i += 1) {
      base.pixels[i * 4] = 255;
      base.pixels[i * 4 + 1] = 255;
      base.pixels[i * 4 + 2] = 255;
      base.pixels[i * 4 + 3] = atual.pixels[i * 4 + 3];
    }
  }
  paint(base, marca, posicao.x, posicao.y);
  if (mascara) {
    // Reimpoe a mascara: nenhuma ponta da marca pode vazar o squircle, e
    // rodar de novo sobre o proprio resultado tem de dar o mesmo arquivo.
    for (let i = 0; i < base.width * base.height; i += 1) base.pixels[i * 4 + 3] = mascara.pixels[i * 4 + 3];
  }
  return { base, posicao };
}

function porcento(valor) {
  return `${(valor * 100).toFixed(1)}%`;
}

function main() {
  const master = decode(readFileSync(`${root}brand/logo/cialai-mantis-v4-1-head-4k.png`));
  const metricas = medir(master);
  const { caixa, massa } = metricas;
  const somenteMedir = process.argv.includes('--medir');
  const folha = process.argv.includes('--folha');

  console.log(`master ${master.width}x${master.height}`);
  console.log(`  caixa envolvente ${caixa.width}x${caixa.height} em ${caixa.x},${caixa.y}`);
  console.log(`  massa solida     ${massa.width}x${massa.height} em ${massa.x},${massa.y}, ${porcento(massa.height / caixa.height)} da caixa`);
  console.log(`  alvo da massa ${porcento(ALVO_MASSA)} do tile, teto da caixa ${porcento(TETO_CAIXA)}`);

  if (folha) return escreverFolha(master, metricas);

  if (!somenteMedir) {
    const marca = resample(master, { x: 0, y: 0, width: master.width, height: master.height }, MARCA_INTERFACE.tamanho, MARCA_INTERFACE.tamanho);
    writeFileSync(`${root}${MARCA_INTERFACE.arquivo}`, encode(marca, { alpha: true }));
    console.log(`${MARCA_INTERFACE.arquivo}: ${MARCA_INTERFACE.tamanho} px, enquadramento do master`);
  }

  for (const alvo of ALVOS) {
    const { base, posicao } = marcaSobre(alvo, master, metricas);
    const massaNoTile = (massa.height * posicao.escala) / alvo.tile;
    const caixaNoTile = posicao.altura / alvo.tile;
    console.log(`${alvo.arquivo}: tile ${alvo.tile}, marca ${posicao.largura}x${posicao.altura} em ${posicao.x},${posicao.y}, massa ${porcento(massaNoTile)} do tile, caixa ${porcento(caixaNoTile)}`);
    if (somenteMedir) continue;
    writeFileSync(`${root}apps/desktop/design/${alvo.arquivo}`, encode(base, { alpha: alvo.alpha }));
  }
  if (!somenteMedir) console.log('gravados. rode `npm run icon --workspace @cialai/desktop` para os derivados do desktop');
}

/// Folha de comparacao: o icone de hoje e tres candidatos, nos tamanhos em que
/// o Dock realmente desenha. Existe para a decisao visual acontecer antes de
/// regerar os dezessete derivados.
function escreverFolha(master, metricas) {
  const candidatos = [
    { nome: 'hoje', atual: true },
    { nome: 'alvo 72', alvo: 0.72 },
    { nome: 'alvo 76', alvo: 0.76 },
    { nome: 'alvo 79', alvo: 0.79 },
  ];
  const tamanhos = [32, 64, 128, 256];
  const margem = 24;
  const passo = 256 + margem;
  const largura = margem + candidatos.length * passo;
  const altura = margem + tamanhos.reduce((total, tamanho) => total + tamanho + margem, 0);
  const folha = fill(empty(largura, altura), [22, 22, 24, 255]);
  const atual = decode(readFileSync(`${root}apps/desktop/design/desktop-icon-1024.png`));

  candidatos.forEach((candidato, coluna) => {
    const origem = candidato.atual
      ? atual
      : marcaSobre({ arquivo: 'desktop-icon-1024.png', canvas: 1024, tile: 824, mascara: true, alvo: candidato.alvo }, master, metricas).base;
    let y = margem;
    for (const tamanho of tamanhos) {
      const pequeno = resample(origem, { x: 0, y: 0, width: origem.width, height: origem.height }, tamanho, tamanho);
      paint(folha, pequeno, margem + coluna * passo + (256 - tamanho) / 2, y);
      y += tamanho + margem;
    }
  });
  // Fora do repositorio: e material de decisao, nao asset da marca.
  const destino = join(tmpdir(), 'cialai-folha-comparacao.png');
  writeFileSync(destino, encode(folha, { alpha: false }));
  console.log(`folha em ${destino}, colunas: hoje, 72, 76, 79`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
