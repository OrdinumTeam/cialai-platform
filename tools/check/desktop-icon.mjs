// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourcePath = `${root}/apps/desktop/design/app-icon-1024.png`;
assert.ok(existsSync(sourcePath), 'Missing approved desktop icon source');

const png = readFileSync(sourcePath);
assert.equal(png.subarray(1, 4).toString(), 'PNG', 'Desktop icon must be a PNG');

let offset = 8;
let width = 0;
let height = 0;
let bitDepth = 0;
let colorType = 0;
const compressed = [];
while (offset < png.length) {
  const size = png.readUInt32BE(offset);
  const type = png.subarray(offset + 4, offset + 8).toString();
  const data = png.subarray(offset + 8, offset + 8 + size);
  if (type === 'IHDR') {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
    bitDepth = data[8];
    colorType = data[9];
    assert.equal(data[12], 0, 'Desktop icon must not be interlaced');
  }
  if (type === 'IDAT') compressed.push(data);
  offset += size + 12;
}

assert.equal(width, 1024);
assert.equal(height, 1024);
assert.equal(bitDepth, 8);
assert.equal(colorType, 2, 'Desktop icon must be opaque RGB without an alpha channel');

const bytesPerPixel = 3;
const stride = width * bytesPerPixel;
const raw = inflateSync(Buffer.concat(compressed));
const pixels = Buffer.alloc(stride * height);
let input = 0;
for (let y = 0; y < height; y += 1) {
  const filter = raw[input];
  input += 1;
  for (let x = 0; x < stride; x += 1) {
    const value = raw[input + x];
    const left = x >= bytesPerPixel ? pixels[y * stride + x - bytesPerPixel] : 0;
    const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
    const upLeft = y > 0 && x >= bytesPerPixel ? pixels[(y - 1) * stride + x - bytesPerPixel] : 0;
    let decoded;
    if (filter === 0) decoded = value;
    else if (filter === 1) decoded = value + left;
    else if (filter === 2) decoded = value + up;
    else if (filter === 3) decoded = value + Math.floor((left + up) / 2);
    else if (filter === 4) {
      const estimate = left + up - upLeft;
      const leftDistance = Math.abs(estimate - left);
      const upDistance = Math.abs(estimate - up);
      const diagonalDistance = Math.abs(estimate - upLeft);
      decoded = value + (leftDistance <= upDistance && leftDistance <= diagonalDistance ? left : upDistance <= diagonalDistance ? up : upLeft);
    } else throw new Error(`Unsupported PNG filter: ${filter}`);
    pixels[y * stride + x] = decoded & 0xff;
  }
  input += stride;
}

let white = 0;
let pink = 0;
let plum = 0;
for (let index = 0; index < pixels.length; index += bytesPerPixel) {
  const red = pixels[index];
  const green = pixels[index + 1];
  const blue = pixels[index + 2];
  if (red > 245 && green > 245 && blue > 245) white += 1;
  if (red > 190 && green < 155 && blue > 110 && red > blue + 20) pink += 1;
  if (red < 110 && green < 65 && blue < 100 && red > green) plum += 1;
}

assert.ok(white > 300_000, `Expected an opaque white background, found ${white} light pixels`);
assert.ok(pink > 100_000, `Expected the Cialai pink symbol, found ${pink} pink pixels`);
assert.ok(plum > 5_000, `Expected the Cialai plum details, found ${plum} plum pixels`);

const desktopPackage = JSON.parse(readFileSync(`${root}/apps/desktop/package.json`, 'utf8'));
assert.match(desktopPackage.scripts.icon, /design\/app-icon-1024\.png$/);

console.log('PASS desktop icon: approved Cialai symbol on an opaque 1024 px white source');
