/**
 * The one and only hash in the engine.
 *
 * Everything that needs a deterministic number — seed derivation, body
 * parameters, scatter placement, later on the noise domain offsets — goes
 * through here. There is no second implementation anywhere, and `Math.random()`
 * is blocked in this package by `pnpm check:deps` and by ESLint.
 *
 * Algorithm: PCG-XSH-RR 64/32 (O'Neill 2014), the standard `pcg32` variant.
 * 64-bit state in `BigInt` so the arithmetic is exact and portable — this runs
 * a few thousand times during world generation, not per pixel.
 *
 * Changing anything in this file changes every generated world. That is what
 * the golden tests in `test/golden.test.ts` are there to catch; a break is the
 * signal, not the failure. Record it in STATE.md.
 */

const M64 = (1n << 64n) - 1n;

/** LCG multiplier from the PCG reference implementation. */
const MULT = 6364136223846793005n;

/** LCG increment. Must be odd. */
const INC = 1442695040888963407n;

/** 64-bit golden ratio, used to spread input words across the state. */
const GOLDEN = 0x9e3779b97f4a7c15n;

/** 2^32, for turning a u32 into a float in [0, 1). */
const TWO_POW_32 = 4294967296;

/** Anything that can seed the generator. */
export type SeedInput = number | bigint;

/** A derived seed. Always an unsigned 32-bit integer. */
export type Seed = number;

function toU64(value: SeedInput): bigint {
  if (typeof value === 'bigint') return value & M64;
  if (!Number.isFinite(value)) {
    throw new TypeError(`hash: expected a finite integer, got ${String(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `hash: expected a safe integer, got ${String(value)} — ` +
        'silently truncating would make world generation platform-dependent',
    );
  }
  return BigInt(value) & M64;
}

/** One LCG step of the PCG state. */
function step(state: bigint): bigint {
  return (state * MULT + INC) & M64;
}

/** PCG's XSH-RR output permutation: 64-bit state to a well-mixed u32. */
function permute(state: bigint): number {
  const xorshifted = Number((((state >> 18n) ^ state) >> 27n) & 0xffffffffn);
  const rot = Number((state >> 59n) & 31n);
  return ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0;
}

/**
 * Hash a seed plus any number of integers into a u32.
 *
 * Order-sensitive and length-sensitive: `hash(s, 1, 2)`, `hash(s, 2, 1)` and
 * `hash(s, 1)` are three different values.
 */
export function hash(seed: SeedInput, ...values: number[]): Seed {
  let state = step(toU64(seed) ^ GOLDEN);
  for (let i = 0; i < values.length; i++) {
    state = step(state ^ ((toU64(values[i] as number) * GOLDEN) & M64));
  }
  return permute(step(state));
}

/** Hash to a float in [0, 1). 32 bits of resolution. */
export function randFloat(seed: SeedInput, ...values: number[]): number {
  return hash(seed, ...values) / TWO_POW_32;
}

/** Hash to a float in [min, max). */
export function randRange(min: number, max: number, seed: SeedInput, ...values: number[]): number {
  return min + (max - min) * randFloat(seed, ...values);
}

/** Hash to an integer in [min, max], both inclusive. */
export function randInt(min: number, max: number, seed: SeedInput, ...values: number[]): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
    throw new TypeError('randInt: bounds must be safe integers');
  }
  if (max < min) throw new RangeError(`randInt: empty range [${min}, ${max}]`);
  const span = max - min + 1;
  return min + Math.floor(randFloat(seed, ...values) * span);
}

/** Pick one element of a non-empty array. */
export function randPick<T>(items: readonly T[], seed: SeedInput, ...values: number[]): T {
  if (items.length === 0) throw new RangeError('randPick: empty array');
  return items[randInt(0, items.length - 1, seed, ...values)] as T;
}

/**
 * A sequential PCG32 stream, for when a caller wants many draws in a row
 * without inventing index arguments. Same algorithm, same file, no second
 * implementation.
 */
export class Pcg32 {
  private state: bigint;

  private constructor(state: bigint) {
    this.state = state;
  }

  /** Start a stream from a seed and optional discriminator integers. */
  static from(seed: SeedInput, ...values: number[]): Pcg32 {
    return new Pcg32(step(toU64(hash(seed, ...values)) ^ GOLDEN));
  }

  /** Next raw u32. */
  nextUint32(): number {
    const old = this.state;
    this.state = step(old);
    return permute(old);
  }

  /** Next float in [0, 1). */
  nextFloat(): number {
    return this.nextUint32() / TWO_POW_32;
  }

  /** Next float in [min, max). */
  nextRange(min: number, max: number): number {
    return min + (max - min) * this.nextFloat();
  }

  /** Next integer in [min, max], both inclusive. */
  nextInt(min: number, max: number): number {
    if (max < min) throw new RangeError(`nextInt: empty range [${min}, ${max}]`);
    return min + Math.floor(this.nextFloat() * (max - min + 1));
  }

  /** Copy the stream at its current position. */
  clone(): Pcg32 {
    return new Pcg32(this.state);
  }
}
