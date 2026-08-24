import { describe, expect, it } from 'vitest';
import { Pcg32, hash, randFloat, randInt, randPick, randRange } from '../src/hash.ts';

describe('hash', () => {
  it('is deterministic', () => {
    expect(hash(1, 2, 3)).toBe(hash(1, 2, 3));
    expect(hash(0)).toBe(hash(0));
  });

  it('returns an unsigned 32-bit integer', () => {
    for (let i = 0; i < 2000; i++) {
      const h = hash(i, i * 7919);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('is order sensitive', () => {
    expect(hash(1, 2, 3)).not.toBe(hash(1, 3, 2));
  });

  it('is length sensitive', () => {
    expect(hash(1, 0)).not.toBe(hash(1));
    expect(hash(1, 0, 0)).not.toBe(hash(1, 0));
  });

  it('separates neighbouring seeds', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 4096; i++) seen.add(hash(i));
    expect(seen.size).toBe(4096);
  });

  it('separates neighbouring coordinates', () => {
    const seen = new Set<number>();
    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) seen.add(hash(12345, x, y));
    }
    expect(seen.size).toBe(64 * 64);
  });

  it('accepts negative and bigint seeds', () => {
    expect(() => hash(-1, -2)).not.toThrow();
    expect(() => hash(0xdeadbeefn)).not.toThrow();
    expect(hash(-1)).not.toBe(hash(1));
  });

  it('refuses non-integers rather than truncating silently', () => {
    expect(() => hash(1.5)).toThrow(TypeError);
    expect(() => hash(1, 2.25)).toThrow(TypeError);
    expect(() => hash(Number.NaN)).toThrow(TypeError);
    expect(() => hash(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => hash(2 ** 53)).toThrow(TypeError);
  });

  it('has no obvious bias in the top bit', () => {
    let high = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) if (hash(7, i) >= 0x80000000) high++;
    expect(Math.abs(high / n - 0.5)).toBeLessThan(0.02);
  });
});

describe('randFloat / randRange / randInt', () => {
  it('stays inside [0, 1)', () => {
    for (let i = 0; i < 5000; i++) {
      const v = randFloat(3, i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('has a mean near 0.5', () => {
    let sum = 0;
    const n = 50000;
    for (let i = 0; i < n; i++) sum += randFloat(11, i);
    expect(Math.abs(sum / n - 0.5)).toBeLessThan(0.01);
  });

  it('maps into the requested range', () => {
    for (let i = 0; i < 2000; i++) {
      const v = randRange(-40, 120, 5, i);
      expect(v).toBeGreaterThanOrEqual(-40);
      expect(v).toBeLessThan(120);
    }
  });

  it('covers an inclusive integer range', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(randInt(3, 9, 17, i));
    expect([...seen].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });

  it('rejects an empty integer range', () => {
    expect(() => randInt(5, 4, 1)).toThrow(RangeError);
  });

  it('picks from an array and rejects an empty one', () => {
    expect(['a', 'b', 'c']).toContain(randPick(['a', 'b', 'c'], 9));
    expect(() => randPick([], 9)).toThrow(RangeError);
  });
});

describe('Pcg32', () => {
  it('reproduces a stream from the same seed', () => {
    const a = Pcg32.from(42, 1);
    const b = Pcg32.from(42, 1);
    for (let i = 0; i < 100; i++) expect(a.nextUint32()).toBe(b.nextUint32());
  });

  it('diverges for different seeds', () => {
    const a = Pcg32.from(42);
    const b = Pcg32.from(43);
    expect(a.nextUint32()).not.toBe(b.nextUint32());
  });

  it('does not repeat early', () => {
    const rng = Pcg32.from(1234);
    const seen = new Set<number>();
    for (let i = 0; i < 10000; i++) seen.add(rng.nextUint32());
    expect(seen.size).toBeGreaterThan(9990);
  });

  it('clones at the current position', () => {
    const rng = Pcg32.from(7);
    rng.nextUint32();
    const copy = rng.clone();
    expect(copy.nextUint32()).toBe(rng.nextUint32());
  });

  it('keeps nextInt inside its inclusive bounds', () => {
    const rng = Pcg32.from(99);
    for (let i = 0; i < 5000; i++) {
      const v = rng.nextInt(-3, 3);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThanOrEqual(3);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});
