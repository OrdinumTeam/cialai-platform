// SPDX-License-Identifier: Apache-2.0
// Leitor de QR para o autoteste, sem dependências. Lê o texto do QR que o
// diálogo de pareamento desenhou no canvas, sem consultar o estado do React e
// sem guardar o payload no relatório. Cobre o que a biblioteca `qrcode` gera:
// símbolo reto e sem rotação, versões 1 a 40, os quatro níveis de correção e
// os modos numérico, alfanumérico e byte em UTF-8. Não corrige erros, porque a
// imagem sai do próprio canvas e não de uma câmera.

// Blocos e palavras de correção por bloco, por versão, na ordem L, M, Q e H
// da norma ISO/IEC 18004.
const EC_BLOCKS = [
  [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];
const EC_PER_BLOCK = [
  [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
// Bits do nível no formato: L 01, M 00, Q 11 e H 10.
const LEVEL_BITS = [1, 0, 3, 2];
export const LEVELS = ['L', 'M', 'Q', 'H'];
const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
// Bits do contador por modo nas faixas de versão 1 a 9, 10 a 26 e 27 a 40.
const COUNT_BITS = { 1: [10, 12, 14], 2: [9, 11, 13], 4: [8, 16, 16] };

function formatWord(level, mask) {
  const data = (LEVEL_BITS[level] << 3) | mask;
  let remainder = data;
  for (let index = 0; index < 10; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

function readFormat(dark, size) {
  let first = 0;
  let second = 0;
  const bit = (value, index) => (value ? 1 << index : 0);
  for (let index = 0; index < 6; index += 1) first |= bit(dark(index, 8), index);
  first |= bit(dark(7, 8), 6) | bit(dark(8, 8), 7) | bit(dark(8, 7), 8);
  for (let index = 9; index < 15; index += 1) first |= bit(dark(8, 14 - index), index);
  for (let index = 0; index < 8; index += 1) second |= bit(dark(8, size - 1 - index), index);
  for (let index = 8; index < 15; index += 1) second |= bit(dark(size - 15 + index, 8), index);
  let best = null;
  for (let level = 0; level < 4; level += 1) {
    for (let mask = 0; mask < 8; mask += 1) {
      const word = formatWord(level, mask);
      const distance = Math.min(popcount(word ^ first), popcount(word ^ second));
      if (!best || distance < best.distance) best = { level, mask, distance };
    }
  }
  if (best.distance > 3) throw new Error('o formato do QR não pôde ser lido');
  return best;
}

function popcount(value) {
  let count = 0;
  for (let rest = value; rest; rest &= rest - 1) count += 1;
  return count;
}

export function alignmentPositions(version) {
  if (version === 1) return [];
  const size = 17 + version * 4;
  const count = Math.floor(version / 7) + 2;
  const step = size === 145 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
  const positions = [size - 7];
  while (positions.length < count - 1) positions.push(positions.at(-1) - step);
  positions.push(6);
  return positions.reverse();
}

function functionModules(version) {
  const size = 17 + version * 4;
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));
  const fill = (top, left, height, width) => {
    for (let row = Math.max(0, top); row < Math.min(size, top + height); row += 1) {
      for (let col = Math.max(0, left); col < Math.min(size, left + width); col += 1) reserved[row][col] = 1;
    }
  };
  // Localizadores com separador e área de formato, depois as linhas de tempo.
  fill(0, 0, 9, 9);
  fill(0, size - 8, 9, 8);
  fill(size - 8, 0, 8, 9);
  fill(6, 0, 1, size);
  fill(0, 6, size, 1);
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  positions.forEach((row, rowIndex) => positions.forEach((col, colIndex) => {
    const finder = (rowIndex === 0 && colIndex === 0) || (rowIndex === 0 && colIndex === last) || (rowIndex === last && colIndex === 0);
    if (!finder) fill(row - 2, col - 2, 5, 5);
  }));
  if (version >= 7) {
    fill(0, size - 11, 6, 3);
    fill(size - 11, 0, 3, 6);
  }
  return reserved;
}

function maskBit(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row * col) % 3) + ((row + col) % 2)) % 2 === 0;
  }
}

// Palavras de dados na ordem original, desfeito o entrelaçamento dos blocos.
function dataCodewords(dark, size, version, level, mask) {
  const reserved = functionModules(version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (!reserved[row][col]) bits.push(dark(row, col) !== maskBit(mask, row, col) ? 1 : 0);
      }
    }
  }
  const total = Math.floor(bits.length / 8);
  const codewords = Array.from({ length: total }, (_, index) => bits.slice(index * 8, index * 8 + 8).reduce((value, bit) => (value << 1) | bit, 0));
  const blocks = EC_BLOCKS[level][version - 1];
  const dataTotal = total - blocks * EC_PER_BLOCK[level][version - 1];
  const shortBlocks = blocks - (dataTotal % blocks);
  const shortLength = Math.floor(dataTotal / blocks);
  const lengths = Array.from({ length: blocks }, (_, index) => shortLength + (index < shortBlocks ? 0 : 1));
  const parts = lengths.map(() => []);
  let cursor = 0;
  for (let index = 0; index <= shortLength; index += 1) {
    for (let block = 0; block < blocks; block += 1) {
      if (index < lengths[block]) parts[block].push(codewords[cursor++]);
    }
  }
  return parts.flat();
}

function parseSegments(data, version) {
  let position = 0;
  const available = data.length * 8;
  const read = (count) => {
    if (position + count > available) throw new Error('o fluxo do QR terminou antes do esperado');
    let value = 0;
    for (let index = 0; index < count; index += 1, position += 1) value = (value << 1) | ((data[position >> 3] >> (7 - (position & 7))) & 1);
    return value;
  };
  const tier = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  const bytes = [];
  const ascii = (text) => { for (const char of text) bytes.push(char.charCodeAt(0)); };
  while (available - position >= 4) {
    const mode = read(4);
    if (mode === 0) break;
    if (!COUNT_BITS[mode]) throw new Error(`modo ${mode} do QR não é suportado`);
    let count = read(COUNT_BITS[mode][tier]);
    if (mode === 1) {
      for (; count >= 3; count -= 3) ascii(String(read(10)).padStart(3, '0'));
      if (count === 2) ascii(String(read(7)).padStart(2, '0'));
      if (count === 1) ascii(String(read(4)));
    } else if (mode === 2) {
      for (; count >= 2; count -= 2) {
        const value = read(11);
        ascii(ALPHANUMERIC[Math.floor(value / 45)] + ALPHANUMERIC[value % 45]);
      }
      if (count === 1) ascii(ALPHANUMERIC[read(6)]);
    } else {
      for (; count > 0; count -= 1) bytes.push(read(8));
    }
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
}

// `dark(row, col)` diz se o módulo é escuro, com a zona de silêncio já fora.
export function decodeModules(dark, size) {
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 40) throw new Error(`tamanho de QR inválido: ${size}`);
  const { level, mask } = readFormat(dark, size);
  return { text: parseSegments(dataCodewords(dark, size, version, level, mask), version), version, level: LEVELS[level] };
}

// Amostra o centro de cada módulo de uma imagem RGBA com fundo claro, como a
// de `getImageData`. O tamanho vem da largura do localizador superior esquerdo.
export function modulesFromImage({ data, width, height }) {
  const darkPixel = (x, y) => {
    const index = (y * width + x) * 4;
    const alpha = data[index + 3] / 255;
    const luminance = (0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]) * alpha + 255 * (1 - alpha);
    return luminance < 128;
  };
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!darkPixel(x, y)) continue;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) throw new Error('o canvas não tem módulos escuros');
  let finder = 0;
  while (left + finder <= right && darkPixel(left + finder, top)) finder += 1;
  const span = right - left + 1;
  const version = Math.round((span / (finder / 7) - 17) / 4);
  const size = 17 + version * 4;
  if (version < 1 || version > 40 || Math.abs((bottom - top + 1) - span) > span / size) throw new Error('o canvas não parece um QR reto');
  const pitch = span / size;
  const dark = (row, col) => darkPixel(Math.min(right, left + Math.floor((col + 0.5) * pitch)), Math.min(bottom, top + Math.floor((row + 0.5) * pitch)));
  return { dark, size };
}

export function decodeImage(image) {
  const { dark, size } = modulesFromImage(image);
  return decodeModules(dark, size);
}
