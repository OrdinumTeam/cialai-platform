// SPDX-License-Identifier: Apache-2.0
// Gera o icone do Cialai Broto e a marca da janela dele.
//
// A arte aprovada, `brand/logo/broto-icon.jpg`, e o broto sobre fundo branco
// quadrado, sem curva. O icone do Broto sai na mesma geometria do icone do
// Cialai, por decisao do usuario em 28/10/2026: a placa branca arredondada de
// `brand/logo/cialai-icon.png`, com a curva do designer, e a arte do Broto
// dentro dela, menor que no JPG para os cantos da placa nao cortarem as folhas.
//
// O fundo branco do JPG sai pela brancura de cada pixel, 255 menos o menor
// canal. Ate LIMPO e fundo, a partir de CHEIO e desenho, e no meio fica a
// borda suavizada, com a cor tirada de cima do branco para nao deixar halo
// claro no tema escuro. O broto central, o tom mais claro da arte, tem
// brancura perto de 50 e fica inteiro.
//
// Sai, como no desktop:
//   `apps/broto/design/desktop-icon-1024.png`  placa em 824 de 1024, a grade
//                                             do macOS, com margem transparente
//   `apps/broto/src-tauri/icons/icon.{png,icns,ico}`  pelo `tauri icon`
//   `packages/ui/src/assets/broto-mark.png`   so a arte, sem placa, para o
//                                             cabecalho da janela
//
// Depende do `sips`, do macOS, para ler o JPG, e do `pngquant` para a marca
// da interface.
//
// Uso:
//   node tools/brand/build-broto-icons.mjs            grava os arquivos
//   node tools/brand/build-broto-icons.mjs --medir    so imprime as medidas
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, empty, encode, paint, resample } from './png.mjs';
import { medir, PLACA_MACOS } from './build-app-icons.mjs';
import { quantizar } from './build-ui-lockup.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

const ARTE = 'brand/logo/broto-icon.jpg';
const PLACA = 'brand/logo/cialai-icon.png';
const DESKTOP = 'apps/broto/design/desktop-icon-1024.png';
const ICONES = 'apps/broto/src-tauri/icons';
const MARCA = { arquivo: 'packages/ui/src/assets/broto-mark.png', lado: 128, ocupacao: 0.94 };

const CANVAS = 1024;
/// Largura da arte em fracao da placa. No JPG o broto ocupa 0,73 do quadro e
/// as folhas encostam na borda; em 0,66 elas respiram dentro da curva e o
/// desenho ainda pesa como a cabeca do louva-a-deus no icone do Cialai.
const LARGURA_DA_ARTE = 0.66;
const LIMPO = 4;
const CHEIO = 28;

function lerJpg(caminho) {
  const pasta = mkdtempSync(join(tmpdir(), 'broto-icon-'));
  try {
    const saida = join(pasta, 'arte.png');
    const resultado = spawnSync('sips', ['-s', 'format', 'png', caminho, '--out', saida]);
    if (resultado.error) throw new Error(`sips indisponivel: ${resultado.error.message}`);
    if (resultado.status !== 0) throw new Error(`sips saiu com ${resultado.status}: ${String(resultado.stderr).trim()}`);
    return decode(readFileSync(saida));
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
}

/// A arte sem o fundo branco.
export function semFundo(imagem) {
  const saida = empty(imagem.width, imagem.height);
  for (let i = 0; i < imagem.width * imagem.height * 4; i += 4) {
    const cor = [imagem.pixels[i], imagem.pixels[i + 1], imagem.pixels[i + 2]];
    const alfa = Math.min(1, Math.max(0, (255 - Math.min(...cor) - LIMPO) / (CHEIO - LIMPO)));
    if (alfa <= 0) continue;
    for (let c = 0; c < 3; c += 1) saida.pixels[i + c] = Math.min(255, Math.max(0, Math.round(255 - (255 - cor[c]) / alfa)));
    saida.pixels[i + 3] = Math.round(alfa * 255);
  }
  return saida;
}

/// So a placa branca da peca do Cialai: o alfa dela, sem a cabeca dentro.
function placaBranca(icone) {
  const placa = empty(icone.width, icone.height);
  for (let i = 0; i < icone.width * icone.height * 4; i += 4) {
    placa.pixels.fill(255, i, i + 3);
    placa.pixels[i + 3] = icone.pixels[i + 3];
  }
  return placa;
}

/// A arte centrada na placa, no tamanho da placa aprovada.
export function iconeNaPlaca(arte, caixa, placa) {
  const icone = placaBranca(placa);
  const largura = Math.round(icone.width * LARGURA_DA_ARTE);
  const altura = Math.round((caixa.height * largura) / caixa.width);
  paint(icone, resample(arte, caixa, largura, altura), Math.round((icone.width - largura) / 2), Math.round((icone.height - altura) / 2));
  return { icone, largura, altura };
}

function tauriIcon(origem) {
  const pasta = mkdtempSync(join(tmpdir(), 'broto-tauri-icon-'));
  try {
    const resultado = spawnSync(join(root, 'node_modules/.bin/tauri'), ['icon', origem, '--output', pasta], { cwd: join(root, 'apps/broto'), encoding: 'utf8' });
    if (resultado.error) throw new Error(`tauri indisponivel: ${resultado.error.message}`);
    if (resultado.status !== 0) throw new Error(`tauri icon saiu com ${resultado.status}: ${resultado.stderr.trim()}`);
    for (const nome of ['icon.png', 'icon.icns', 'icon.ico']) copyFileSync(join(pasta, nome), join(root, ICONES, nome));
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
}

function main() {
  const arte = semFundo(lerJpg(`${root}${ARTE}`));
  const caixa = medir(arte);
  const placa = decode(readFileSync(`${root}${PLACA}`));
  const { icone, largura, altura } = iconeNaPlaca(arte, caixa, placa);
  console.log(`arte ${caixa.width}x${caixa.height} em ${caixa.x},${caixa.y}; na placa de ${icone.width}, ${largura}x${altura}`);

  const ladoMarca = Math.round(MARCA.lado * MARCA.ocupacao);
  const larguraMarca = caixa.width >= caixa.height ? ladoMarca : Math.round((caixa.width * ladoMarca) / caixa.height);
  const alturaMarca = caixa.width >= caixa.height ? Math.round((caixa.height * ladoMarca) / caixa.width) : ladoMarca;
  console.log(`${MARCA.arquivo}: ${larguraMarca}x${alturaMarca} em ${MARCA.lado}`);
  if (process.argv.includes('--medir')) return;

  const desktop = empty(CANVAS, CANVAS);
  const canto = Math.round((CANVAS - PLACA_MACOS) / 2);
  paint(desktop, resample(icone, { x: 0, y: 0, width: icone.width, height: icone.height }, PLACA_MACOS, PLACA_MACOS), canto, canto);
  mkdirSync(join(root, 'apps/broto/design'), { recursive: true });
  writeFileSync(`${root}${DESKTOP}`, encode(desktop, { alpha: true }));
  tauriIcon(`${root}${DESKTOP}`);
  console.log(`gravados ${DESKTOP} e ${ICONES}/icon.png, icon.icns e icon.ico`);

  const marca = empty(MARCA.lado, MARCA.lado);
  paint(marca, resample(arte, caixa, larguraMarca, alturaMarca), Math.round((MARCA.lado - larguraMarca) / 2), Math.round((MARCA.lado - alturaMarca) / 2));
  writeFileSync(`${root}${MARCA.arquivo}`, quantizar(encode(marca, { alpha: true })));
  console.log(`gravada ${MARCA.arquivo}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
