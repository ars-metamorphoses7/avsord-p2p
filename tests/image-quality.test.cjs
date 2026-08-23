'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compareRgba } = require('./helpers/image-quality.cjs');

function rgba(pixels) {
  return Buffer.from(pixels.flat());
}

test('identical RGB produces perfect SSIM and JSON-safe infinite PSNR', () => {
  const reference = rgba([
    [10, 20, 30, 0],
    [40, 50, 60, 64],
    [70, 80, 90, 128],
    [100, 110, 120, 255],
  ]);
  const candidate = rgba([
    [10, 20, 30, 255],
    [40, 50, 60, 192],
    [70, 80, 90, 64],
    [100, 110, 120, 0],
  ]);

  const result = compareRgba(reference, candidate, { width: 2, height: 2, blockSize: 1 });

  assert.deepEqual(result.global, {
    mse: 0,
    psnrDb: null,
    psnrInfinite: true,
    ssim: 1,
  });
  assert.equal(result.alphaIgnored, true);
  assert.equal(result.blocks.length, 4);
  assert.ok(result.blocks.every((block) => block.ssim === 1 && block.psnrInfinite));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('black versus white has zero-decibel PSNR and the expected constant-image SSIM', () => {
  const reference = Buffer.from([0, 0, 0, 255]);
  const candidate = Buffer.from([255, 255, 255, 255]);
  const result = compareRgba(reference, candidate, { width: 1, height: 1 });
  const expectedSsim = SSIM_CONSTANT_IMAGE_BLACK_WHITE;

  assert.equal(result.global.mse, 255 ** 2);
  assert.equal(result.global.psnrDb, 0);
  assert.equal(result.global.psnrInfinite, false);
  assert.ok(Math.abs(result.global.ssim - expectedSsim) < 1e-15);
});

const SSIM_CONSTANT_IMAGE_BLACK_WHITE = ((0.01 * 255) ** 2)
  / ((255 ** 2) + ((0.01 * 255) ** 2));

test('block metrics localize degradation and handle partial edge blocks', () => {
  const reference = new Uint8ClampedArray(3 * 2 * 4);
  const candidate = new Uint8ClampedArray(reference);
  for (let y = 0; y < 2; y += 1) {
    const offset = ((y * 3) + 2) * 4;
    candidate[offset] = 255;
    candidate[offset + 1] = 255;
    candidate[offset + 2] = 255;
  }

  const result = compareRgba(reference, candidate, { width: 3, height: 2, blockSize: 2 });

  assert.equal(result.blocks.length, 2);
  assert.deepEqual(
    result.blocks.map(({ x, y, width, height, pixels }) => ({ x, y, width, height, pixels })),
    [
      { x: 0, y: 0, width: 2, height: 2, pixels: 4 },
      { x: 2, y: 0, width: 1, height: 2, pixels: 2 },
    ],
  );
  assert.equal(result.blocks[0].ssim, 1);
  assert.equal(result.blocks[0].psnrInfinite, true);
  assert.equal(result.blocks[1].psnrDb, 0);
  assert.ok(result.blocks[1].ssim < 0.001);
  assert.ok(result.blockAverage.pixelWeightedSsim > result.blockAverage.ssim);
});

test('Buffer, plain array, and typed array inputs produce deterministic results', () => {
  const reference = [0, 10, 20, 30, 40, 50, 60, 70];
  const candidate = Uint8Array.from([1, 12, 23, 255, 44, 55, 66, 0]);

  const first = compareRgba(reference, candidate, { width: 2, height: 1, blockSize: 8 });
  const second = compareRgba(reference, candidate, { width: 2, height: 1, blockSize: 8 });

  assert.deepEqual(first, second);
  assert.equal(first.blocks.length, 1);
  assert.ok(Number.isFinite(first.global.psnrDb));
  assert.ok(Number.isFinite(first.global.ssim));
});

test('validates dimensions, RGBA lengths, byte values, and block size', () => {
  const pixel = [0, 0, 0, 255];

  assert.throws(() => compareRgba(pixel, pixel), /dimensions/);
  assert.throws(() => compareRgba(pixel, pixel, { width: 0, height: 1 }), /width/);
  assert.throws(() => compareRgba(pixel, pixel, { width: 1.5, height: 1 }), /width/);
  assert.throws(() => compareRgba(pixel, pixel, { width: 1, height: 0 }), /height/);
  assert.throws(() => compareRgba(pixel, pixel, { width: 1, height: 1, blockSize: 0 }), /blockSize/);
  assert.throws(() => compareRgba(pixel, [0, 0, 0], { width: 1, height: 1 }), /length/);
  assert.throws(() => compareRgba(pixel, 'rgba', { width: 1, height: 1 }), /Buffer/);
  assert.throws(() => compareRgba([0, 0, 256, 255], pixel, { width: 1, height: 1 }), /between 0 and 255/);
  assert.throws(() => compareRgba([0, 0, 0, Number.NaN], pixel, { width: 1, height: 1 }), /between 0 and 255/);
});
