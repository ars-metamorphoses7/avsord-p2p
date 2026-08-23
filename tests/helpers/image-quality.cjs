'use strict';

const DEFAULT_BLOCK_SIZE = 8;
const MAX_SAMPLE_VALUE = 255;
const SSIM_C1 = (0.01 * MAX_SAMPLE_VALUE) ** 2;
const SSIM_C2 = (0.03 * MAX_SAMPLE_VALUE) ** 2;

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function assertRgbaInput(value, name, expectedLength) {
  const supported = Array.isArray(value)
    || Buffer.isBuffer(value)
    || (ArrayBuffer.isView(value) && !(value instanceof DataView));
  if (!supported) {
    throw new TypeError(`${name} must be a Buffer, numeric array, or typed array.`);
  }
  if (value.length !== expectedLength) {
    throw new RangeError(`${name} length must be exactly ${expectedLength} RGBA entries; received ${value.length}.`);
  }
}

function byteAt(input, index, name) {
  const value = input[index];
  if (!Number.isInteger(value) || value < 0 || value > MAX_SAMPLE_VALUE) {
    throw new RangeError(`${name}[${index}] must be an integer between 0 and 255.`);
  }
  return value;
}

function createAccumulator() {
  return {
    pixels: 0,
    squaredError: 0,
    referenceSum: [0, 0, 0],
    candidateSum: [0, 0, 0],
    referenceSquareSum: [0, 0, 0],
    candidateSquareSum: [0, 0, 0],
    crossSum: [0, 0, 0],
  };
}

function addPixel(accumulator, reference, candidate, offset, referenceName, candidateName) {
  // Alpha is validated as part of the RGBA shape, but deliberately excluded
  // from every error and similarity calculation.
  byteAt(reference, offset + 3, referenceName);
  byteAt(candidate, offset + 3, candidateName);

  for (let channel = 0; channel < 3; channel += 1) {
    const referenceValue = byteAt(reference, offset + channel, referenceName);
    const candidateValue = byteAt(candidate, offset + channel, candidateName);
    const difference = referenceValue - candidateValue;
    accumulator.squaredError += difference * difference;
    accumulator.referenceSum[channel] += referenceValue;
    accumulator.candidateSum[channel] += candidateValue;
    accumulator.referenceSquareSum[channel] += referenceValue * referenceValue;
    accumulator.candidateSquareSum[channel] += candidateValue * candidateValue;
    accumulator.crossSum[channel] += referenceValue * candidateValue;
  }
  accumulator.pixels += 1;
}

function mergeAccumulator(target, source) {
  target.pixels += source.pixels;
  target.squaredError += source.squaredError;
  for (let channel = 0; channel < 3; channel += 1) {
    target.referenceSum[channel] += source.referenceSum[channel];
    target.candidateSum[channel] += source.candidateSum[channel];
    target.referenceSquareSum[channel] += source.referenceSquareSum[channel];
    target.candidateSquareSum[channel] += source.candidateSquareSum[channel];
    target.crossSum[channel] += source.crossSum[channel];
  }
}

function clampSsim(value) {
  return Math.max(-1, Math.min(1, value));
}

function summarizeAccumulator(accumulator) {
  const sampleCount = accumulator.pixels * 3;
  const mse = accumulator.squaredError / sampleCount;
  const psnrInfinite = mse === 0;
  const psnrDb = psnrInfinite
    ? null
    : 10 * Math.log10((MAX_SAMPLE_VALUE * MAX_SAMPLE_VALUE) / mse);

  let ssimTotal = 0;
  for (let channel = 0; channel < 3; channel += 1) {
    const referenceMean = accumulator.referenceSum[channel] / accumulator.pixels;
    const candidateMean = accumulator.candidateSum[channel] / accumulator.pixels;
    const referenceVariance = Math.max(
      0,
      (accumulator.referenceSquareSum[channel] / accumulator.pixels) - (referenceMean ** 2),
    );
    const candidateVariance = Math.max(
      0,
      (accumulator.candidateSquareSum[channel] / accumulator.pixels) - (candidateMean ** 2),
    );
    const covariance = (accumulator.crossSum[channel] / accumulator.pixels)
      - (referenceMean * candidateMean);
    const numerator = ((2 * referenceMean * candidateMean) + SSIM_C1)
      * ((2 * covariance) + SSIM_C2);
    const denominator = ((referenceMean ** 2) + (candidateMean ** 2) + SSIM_C1)
      * (referenceVariance + candidateVariance + SSIM_C2);
    ssimTotal += clampSsim(numerator / denominator);
  }

  return {
    mse,
    psnrDb,
    psnrInfinite,
    ssim: ssimTotal / 3,
  };
}

/**
 * Compare equally-sized 8-bit RGBA images. Alpha participates in input
 * validation only and never affects PSNR or SSIM.
 *
 * @param {Buffer|Array|TypedArray} referenceRgba
 * @param {Buffer|Array|TypedArray} candidateRgba
 * @param {{width: number, height: number, blockSize?: number}} dimensions
 * @returns {{
 *   width: number,
 *   height: number,
 *   pixels: number,
 *   blockSize: number,
 *   alphaIgnored: true,
 *   global: {mse: number, psnrDb: number|null, psnrInfinite: boolean, ssim: number},
 *   blockAverage: {ssim: number, pixelWeightedSsim: number},
 *   blocks: Array<{x: number, y: number, width: number, height: number, pixels: number, mse: number, psnrDb: number|null, psnrInfinite: boolean, ssim: number}>
 * }}
 */
function compareRgba(referenceRgba, candidateRgba, dimensions) {
  if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) {
    throw new TypeError('dimensions must be an object containing width and height.');
  }
  const { width, height } = dimensions;
  const blockSize = dimensions.blockSize ?? DEFAULT_BLOCK_SIZE;
  assertPositiveInteger(width, 'width');
  assertPositiveInteger(height, 'height');
  assertPositiveInteger(blockSize, 'blockSize');

  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > Math.floor(Number.MAX_SAFE_INTEGER / 4)) {
    throw new RangeError('width * height is too large for a safe RGBA length.');
  }
  const expectedLength = pixels * 4;
  assertRgbaInput(referenceRgba, 'referenceRgba', expectedLength);
  assertRgbaInput(candidateRgba, 'candidateRgba', expectedLength);

  const globalAccumulator = createAccumulator();
  const blocks = [];
  let blockSsimTotal = 0;
  let weightedBlockSsimTotal = 0;

  for (let blockY = 0; blockY < height; blockY += blockSize) {
    const blockHeight = Math.min(blockSize, height - blockY);
    for (let blockX = 0; blockX < width; blockX += blockSize) {
      const blockWidth = Math.min(blockSize, width - blockX);
      const blockAccumulator = createAccumulator();
      for (let y = blockY; y < blockY + blockHeight; y += 1) {
        for (let x = blockX; x < blockX + blockWidth; x += 1) {
          const offset = ((y * width) + x) * 4;
          addPixel(
            blockAccumulator,
            referenceRgba,
            candidateRgba,
            offset,
            'referenceRgba',
            'candidateRgba',
          );
        }
      }
      mergeAccumulator(globalAccumulator, blockAccumulator);
      const metrics = summarizeAccumulator(blockAccumulator);
      blocks.push({
        x: blockX,
        y: blockY,
        width: blockWidth,
        height: blockHeight,
        pixels: blockAccumulator.pixels,
        ...metrics,
      });
      blockSsimTotal += metrics.ssim;
      weightedBlockSsimTotal += metrics.ssim * blockAccumulator.pixels;
    }
  }

  return {
    width,
    height,
    pixels,
    blockSize,
    alphaIgnored: true,
    global: summarizeAccumulator(globalAccumulator),
    blockAverage: {
      ssim: blockSsimTotal / blocks.length,
      pixelWeightedSsim: weightedBlockSsimTotal / pixels,
    },
    blocks,
  };
}

module.exports = {
  compareRgba,
};
