// SPDX-License-Identifier: Apache-2.0
// Leitura e escrita de PNG sem dependencia externa, no mesmo espirito de
// `tools/check/desktop-icon.mjs`, que ja decodifica na mao. Cobre o que os
// assets da marca usam: profundidade 8, sem entrelacamento, RGB ou RGBA.
import { deflateSync, inflateSync } from 'node:zlib';

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/// Imagem em RGBA de 8 bits, sempre, para o resto do gerador ter um formato so.
export function decode(png) {
  if (png.subarray(1, 4).toString() !== 'PNG') throw new Error('nao e PNG');
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
      if (data[12] !== 0) throw new Error('PNG entrelacado nao e suportado');
    }
    if (type === 'IDAT') parts.push(data);
    offset += size + 12;
  }
  if (depth !== 8 || (color !== 2 && color !== 6)) throw new Error(`PNG fora do suporte: profundidade ${depth}, cor ${color}`);
  const channels = color === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(parts));
  const flat = Buffer.alloc(stride * height);
  let input = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[input];
    input += 1;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[input + x];
      const left = x >= channels ? flat[y * stride + x - channels] : 0;
      const up = y > 0 ? flat[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? flat[(y - 1) * stride + x - channels] : 0;
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
      } else throw new Error(`filtro PNG sem suporte: ${filter}`);
      flat[y * stride + x] = decoded & 0xff;
    }
    input += stride;
  }
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i += 1, j += channels) {
    pixels[i * 4] = flat[j];
    pixels[i * 4 + 1] = flat[j + 1];
    pixels[i * 4 + 2] = flat[j + 2];
    pixels[i * 4 + 3] = channels === 4 ? flat[j + 3] : 255;
  }
  return { width, height, pixels };
}

/// `alpha` falso grava RGB opaco, que e o que o iOS exige do `app-icon`.
export function encode({ width, height, pixels }, { alpha = true } = {}) {
  const channels = alpha ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4;
      const to = y * (stride + 1) + 1 + x * channels;
      raw[to] = pixels[from];
      raw[to + 1] = pixels[from + 1];
      raw[to + 2] = pixels[from + 2];
      if (alpha) raw[to + 3] = pixels[from + 3];
    }
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function empty(width, height) {
  return { width, height, pixels: Buffer.alloc(width * height * 4) };
}

/// Recorte com reamostragem por area. Vai sempre do master de 4096 para
/// algumas centenas de pixels, entao a media de area e o filtro certo: nao
/// inventa detalhe e nao serrilha a diagonal fina das antenas.
export function resample(source, box, width, height) {
  const out = empty(width, height);
  const scaleX = box.width / width;
  const scaleY = box.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = box.y + y * scaleY;
    const y1 = y0 + scaleY;
    for (let x = 0; x < width; x += 1) {
      const x0 = box.x + x * scaleX;
      const x1 = x0 + scaleX;
      let r = 0; let g = 0; let b = 0; let a = 0; let weight = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy += 1) {
        if (sy < 0 || sy >= source.height) continue;
        const coverY = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (coverY <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx += 1) {
          if (sx < 0 || sx >= source.width) continue;
          const coverX = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (coverX <= 0) continue;
          const w = coverX * coverY;
          const i = (sy * source.width + sx) * 4;
          const alpha = source.pixels[i + 3] / 255;
          // Media na cor pre multiplicada, senao a borda transparente puxa
          // a cor do fundo para dentro do desenho.
          r += source.pixels[i] * alpha * w;
          g += source.pixels[i + 1] * alpha * w;
          b += source.pixels[i + 2] * alpha * w;
          a += alpha * w;
          weight += w;
        }
      }
      const to = (y * width + x) * 4;
      if (weight <= 0 || a <= 0) continue;
      out.pixels[to] = Math.round(r / a);
      out.pixels[to + 1] = Math.round(g / a);
      out.pixels[to + 2] = Math.round(b / a);
      out.pixels[to + 3] = Math.round((a / weight) * 255);
    }
  }
  return out;
}

/// Desenha `top` sobre `base` no ponto dado, com mistura alfa normal.
export function paint(base, top, atX, atY) {
  for (let y = 0; y < top.height; y += 1) {
    const by = atY + y;
    if (by < 0 || by >= base.height) continue;
    for (let x = 0; x < top.width; x += 1) {
      const bx = atX + x;
      if (bx < 0 || bx >= base.width) continue;
      const from = (y * top.width + x) * 4;
      const alpha = top.pixels[from + 3] / 255;
      if (alpha <= 0) continue;
      const to = (by * base.width + bx) * 4;
      const under = base.pixels[to + 3] / 255;
      const result = alpha + under * (1 - alpha);
      for (let c = 0; c < 3; c += 1) {
        base.pixels[to + c] = Math.round((top.pixels[from + c] * alpha + base.pixels[to + c] * under * (1 - alpha)) / result);
      }
      base.pixels[to + 3] = Math.round(result * 255);
    }
  }
  return base;
}

export function fill(image, [r, g, b, a = 255]) {
  for (let i = 0; i < image.width * image.height; i += 1) {
    image.pixels[i * 4] = r;
    image.pixels[i * 4 + 1] = g;
    image.pixels[i * 4 + 2] = b;
    image.pixels[i * 4 + 3] = a;
  }
  return image;
}
