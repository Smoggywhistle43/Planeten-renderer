import { describe, expect, it } from 'vitest';
import {
  SEED_SALT,
  bodySeed,
  deriveSeed,
  resolveSeedPath,
  sectorSeed,
  surfaceSeed,
  systemSeed,
  universeSeed,
} from '../src/seed.ts';

describe('deriveSeed', () => {
  it('is deterministic', () => {
    expect(deriveSeed(1, 'salt', 2)).toBe(deriveSeed(1, 'salt', 2));
  });

  it('separates salts', () => {
    expect(deriveSeed(1, 'a')).not.toBe(deriveSeed(1, 'b'));
    expect(deriveSeed(1, SEED_SALT.body)).not.toBe(deriveSeed(1, SEED_SALT.surface));
  });

  it('separates a string salt from its concatenations', () => {
    expect(deriveSeed(1, 'ab')).not.toBe(deriveSeed(1, 'a', 'b'.charCodeAt(0)));
  });

  it('separates parents', () => {
    expect(deriveSeed(1, 'x')).not.toBe(deriveSeed(2, 'x'));
  });

  it('accepts a numeric salt', () => {
    expect(deriveSeed(1, 7)).not.toBe(deriveSeed(1, 8));
  });
});

describe('the derivation chain', () => {
  it('gives every sector its own seed', () => {
    const universe = universeSeed('planeten');
    const seen = new Set<number>();
    for (let x = -8; x < 8; x++) {
      for (let y = -8; y < 8; y++) seen.add(sectorSeed(universe, x, y, 0));
    }
    expect(seen.size).toBe(16 * 16);
  });

  it('gives every system and body in a sector its own seed', () => {
    const sector = sectorSeed(universeSeed('planeten'), 0, 0, 0);
    const seen = new Set<number>();
    for (let s = 0; s < 32; s++) {
      for (let b = 0; b < 16; b++) seen.add(bodySeed(systemSeed(sector, s), b));
    }
    expect(seen.size).toBe(32 * 16);
  });

  it('derives a surface seed that differs from the body seed', () => {
    const body = bodySeed(systemSeed(sectorSeed(universeSeed('x'), 1, 2, 3), 4), 5);
    expect(surfaceSeed(body)).not.toBe(body);
  });

  it('rebuilds the whole path from the root', () => {
    const path = { universe: 'planeten', sector: [3, -1, 7] as const, system: 2, body: 4 };
    const a = resolveSeedPath(path);
    const b = resolveSeedPath(path);
    expect(a).toEqual(b);
    expect(a.surface).toBe(surfaceSeed(a.body));
    expect(a.body).toBe(bodySeed(a.system, 4));
  });

  it('reacts to a change anywhere along the path', () => {
    const base = { universe: 'planeten', sector: [0, 0, 0] as const, system: 0, body: 0 };
    const ref = resolveSeedPath(base).surface;
    expect(resolveSeedPath({ ...base, universe: 'planeten2' }).surface).not.toBe(ref);
    expect(resolveSeedPath({ ...base, sector: [0, 0, 1] }).surface).not.toBe(ref);
    expect(resolveSeedPath({ ...base, system: 1 }).surface).not.toBe(ref);
    expect(resolveSeedPath({ ...base, body: 1 }).surface).not.toBe(ref);
  });
});
