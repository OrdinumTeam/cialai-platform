// SPDX-License-Identifier: Apache-2.0
// Gera a assinatura horizontal que a interface do desktop usa na barra
// lateral, na abertura e no primeiro uso, nas duas versoes de tema.
//
// Nada aqui redesenha forma. As duas pecas saem da assinatura aprovada,
// `brand/logo/cialai-lockup-1-4k.png`, recortada justo e reduzida por media
// de area:
//
//   `cialai-lockup.png`       a assinatura como esta, para o tema claro
//   `cialai-lockup-dark.png`  a mesma peca com as letras em branco, para o
//                             tema escuro e a tela de abertura
//   `boot-lockup.png`         a versao escura menor, para a tela estatica de
//                             `apps/desktop/index.html`, que aparece antes do
//                             bundle e so enxerga arquivos do proprio app
//   `cialai-wordmark.png`     so o lettering, sem a cabeca, recortado justo,
//   `cialai-wordmark-dark.png` nas cores e em branco: a marca discreta da
//                             toolbar quando a lateral fecha, por decisao do
//                             usuario em 18/10/2026
//
// O app do celular recebe as mesmas duas assinaturas, para o Inicio, e a
// cabeca sozinha, de `brand/logo/cialai-mantis-v4-1-head-4k.png`, recortada
// justo e centrada num quadrado de 192 px, para os lugares pequenos como
// Sobre. O simbolo vazado de uma cor so saiu das duas interfaces.
//
// Na versao escura so a cor das letras muda: o alfa de cada pixel fica, entao
// curvas, recortes entre tracos e pingos dos i sao os do lettering original.
// A cabeca continua nas cores da marca, como o app do celular a mostra sobre
// fundo escuro. Cabeca e letras nao se sobrepoem: a divisao e a primeira
// faixa de colunas vazias depois da cabeca, medida no proprio arquivo.
//
// A assinatura para fundo escuro ainda e pendencia da marca em vetor
// (brand/00-README.md); esta e a derivacao para tela ate la.
//
// Toda peca sai reduzida a paleta pelo `pngquant`, com os parametros fixos de
// QUANTIZAR: a marca tem cores chapadas, a diferenca media fica abaixo de um
// nivel de 255 e o arquivo cai a menos da metade, o que pesa na primeira
// pintura do app. Sem o `pngquant` no PATH o script para, em vez de gravar
// pecas pesadas em silencio.
//
// Uso:
//   node tools/brand/build-ui-lockup.mjs            grava os arquivos
//   node tools/brand/build-ui-lockup.mjs --medir    so imprime as medidas
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decode, encode, resample } from './png.mjs';
import { medir } from './build-app-icons.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ORIGEM = 'brand/logo/cialai-lockup-1-4k.png';
/// Largura das pecas: 120 px na barra lateral, o minimo da marca, e 220 na
/// abertura, que sempre aparece ao iniciar. 480 cobre a abertura em 2x, a
/// densidade das telas Retina, e a lateral com folga; 720, para o 3x que
/// computador quase nao usa, dobrava o peso da primeira pintura.
const LARGURA = 480;
const CLARA = 'packages/ui/src/assets/cialai-lockup.png';
const ESCURA = 'packages/ui/src/assets/cialai-lockup-dark.png';
const BOOT = { arquivo: 'apps/desktop/src/assets/boot-lockup.png', largura: 360 };
/// O lettering sozinho aparece com cerca de 60 px na toolbar; 360 serve 3x
/// com folga.
const ESCRITA = { clara: 'packages/ui/src/assets/cialai-wordmark.png', escura: 'packages/ui/src/assets/cialai-wordmark-dark.png', largura: 360 };
const CELULAR = {
  clara: 'apps/mobile/src/assets/cialai-lockup.png',
  escura: 'apps/mobile/src/assets/cialai-lockup-dark.png',
  cabeca: { origem: 'brand/logo/cialai-mantis-v4-1-head-4k.png', arquivo: 'apps/mobile/src/assets/cialai-head.png', lado: 192 },
};
/// Qualidade minima e maxima e esforco do `pngquant`. Mudar qualquer um muda
/// os bytes de todas as pecas.
const QUANTIZAR = ['--quality=85-98', '--speed', '1', '--strip'];

/// A peca reduzida a paleta, lida e devolvida pela entrada e saida padrao.
export function quantizar(png) {
  const resultado = spawnSync('pngquant', [...QUANTIZAR, '-'], { input: png, maxBuffer: 64 * 1024 * 1024 });
  if (resultado.error) throw new Error(`pngquant indisponivel: ${resultado.error.message}`);
  if (resultado.status !== 0) throw new Error(`pngquant saiu com ${resultado.status}: ${String(resultado.stderr).trim()}`);
  return resultado.stdout;
}

/// Uma coluna conta como vazia com todo pixel abaixo deste alfa.
const ALFA_VAZIO = 16;

/// Primeira coluna da faixa vazia que separa a cabeca das letras: a mais
/// larga dentro da caixa com tinta, que e o respiro entre a cabeca e o C.
export function colunaDeDivisao(imagem, caixa) {
  const vazia = (x) => {
    for (let y = caixa.y; y < caixa.y + caixa.height; y += 1) {
      if (imagem.pixels[(y * imagem.width + x) * 4 + 3] > ALFA_VAZIO) return false;
    }
    return true;
  };
  let melhor = { inicio: -1, largura: 0 };
  let inicio = -1;
  for (let x = caixa.x; x < caixa.x + caixa.width; x += 1) {
    if (vazia(x)) {
      if (inicio < 0) inicio = x;
      continue;
    }
    if (inicio >= 0 && x - inicio > melhor.largura) melhor = { inicio, largura: x - inicio };
    inicio = -1;
  }
  if (melhor.inicio < 0) throw new Error('sem faixa vazia entre a cabeca e as letras');
  return melhor.inicio + Math.floor(melhor.largura / 2);
}

/// Caixa justa das letras, so a direita da divisao: a altura delas e menor
/// que a da cabeca, entao a caixa da assinatura inteira sobraria em cima e
/// embaixo.
export function caixaDasLetras(imagem, caixa, divisao) {
  let x0 = Infinity; let x1 = -1; let y0 = Infinity; let y1 = -1;
  for (let y = caixa.y; y < caixa.y + caixa.height; y += 1) {
    for (let x = divisao; x < caixa.x + caixa.width; x += 1) {
      if (imagem.pixels[(y * imagem.width + x) * 4 + 3] <= ALFA_VAZIO) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error('sem letras a direita da divisao');
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/// Copia da imagem com as letras, a direita da divisao, em branco.
export function letrasEmBranco(imagem, divisao) {
  const copia = { width: imagem.width, height: imagem.height, pixels: Buffer.from(imagem.pixels) };
  for (let y = 0; y < copia.height; y += 1) {
    for (let x = divisao; x < copia.width; x += 1) {
      const i = (y * copia.width + x) * 4;
      if (copia.pixels[i + 3] === 0) continue;
      copia.pixels[i] = 255;
      copia.pixels[i + 1] = 255;
      copia.pixels[i + 2] = 255;
    }
  }
  return copia;
}

/// Quadrado centrado na caixa com tinta, para a cabeca nao deformar.
export function quadradoCentrado(imagem, caixa) {
  const lado = Math.max(caixa.width, caixa.height);
  const quadrado = {
    x: Math.round(caixa.x + caixa.width / 2 - lado / 2),
    y: Math.round(caixa.y + caixa.height / 2 - lado / 2),
    width: lado,
    height: lado,
  };
  if (quadrado.x < 0 || quadrado.y < 0 || quadrado.x + lado > imagem.width || quadrado.y + lado > imagem.height) {
    throw new Error('quadrado da cabeca fora da imagem');
  }
  return quadrado;
}

function main() {
  const origem = decode(readFileSync(`${root}${ORIGEM}`));
  const caixa = medir(origem);
  const divisao = colunaDeDivisao(origem, caixa);
  const altura = Math.round((caixa.height * LARGURA) / caixa.width);
  console.log(`assinatura ${origem.width}x${origem.height}, tinta ${caixa.width}x${caixa.height} em ${caixa.x},${caixa.y}, divisao na coluna ${divisao}`);
  console.log(`pecas ${LARGURA}x${altura}, proporcao ${(caixa.width / caixa.height).toFixed(3)}`);
  const letras = caixaDasLetras(origem, caixa, divisao);
  const alturaEscrita = Math.round((letras.height * ESCRITA.largura) / letras.width);
  console.log(`letras ${letras.width}x${letras.height} em ${letras.x},${letras.y}, escrita ${ESCRITA.largura}x${alturaEscrita}`);
  if (process.argv.includes('--medir')) return;
  const clara = quantizar(encode(resample(origem, caixa, LARGURA, altura), { alpha: true }));
  writeFileSync(`${root}${CLARA}`, clara);
  writeFileSync(`${root}${CELULAR.clara}`, clara);
  const branca = letrasEmBranco(origem, divisao);
  const escura = quantizar(encode(resample(branca, caixa, LARGURA, altura), { alpha: true }));
  writeFileSync(`${root}${ESCURA}`, escura);
  writeFileSync(`${root}${CELULAR.escura}`, escura);
  const cabeca = decode(readFileSync(`${root}${CELULAR.cabeca.origem}`));
  const { lado } = CELULAR.cabeca;
  writeFileSync(`${root}${CELULAR.cabeca.arquivo}`, quantizar(encode(resample(cabeca, quadradoCentrado(cabeca, medir(cabeca)), lado, lado), { alpha: true })));
  const alturaBoot = Math.round((caixa.height * BOOT.largura) / caixa.width);
  writeFileSync(`${root}${BOOT.arquivo}`, quantizar(encode(resample(branca, caixa, BOOT.largura, alturaBoot), { alpha: true })));
  writeFileSync(`${root}${ESCRITA.clara}`, quantizar(encode(resample(origem, letras, ESCRITA.largura, alturaEscrita), { alpha: true })));
  writeFileSync(`${root}${ESCRITA.escura}`, quantizar(encode(resample(branca, letras, ESCRITA.largura, alturaEscrita), { alpha: true })));
  console.log(`gravados ${CLARA}, ${ESCURA}, ${BOOT.arquivo}, ${ESCRITA.clara} e ${ESCRITA.escura}`);
  console.log(`e no celular ${CELULAR.clara}, ${CELULAR.escura} e ${CELULAR.cabeca.arquivo}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
