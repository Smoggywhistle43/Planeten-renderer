/**
 * Seed derivation chain: universe -> sector -> system -> body -> surface.
 *
 * Every level is a pure function of its parent plus a salt, so any node in the
 * tree can be reconstructed from the root seed and a path — nothing has to be
 * stored. All of it goes through the single `hash` in `hash.ts`; there is no
 * string hash of its own here, strings are fed to `hash` as code units.
 */

import { hash, type Seed, type SeedInput } from './hash.ts';

/**
 * Turn a string into integers for `hash`. Length goes in first so that
 * `"ab"` and `"a"` + `"b"` in different positions cannot collide.
 */
function stringToInts(value: string): number[] {
  const out = new Array<number>(value.length + 1);
  out[0] = value.length;
  for (let i = 0; i < value.length; i++) out[i + 1] = value.charCodeAt(i);
  return out;
}

/** The salts used by the derivation chain. Changing one re-rolls that level. */
export const SEED_SALT = {
  universe: 'planeten.universe.v1',
  sector: 'planeten.sector.v1',
  system: 'planeten.system.v1',
  body: 'planeten.body.v1',
  surface: 'planeten.surface.v1',
} as const;

/**
 * Derive a child seed from a parent seed and a salt.
 *
 * The salt is what separates two children of the same parent that share the
 * same numeric coordinates — a body's surface seed and its orbit seed, say.
 */
export function deriveSeed(parent: SeedInput, salt: string | number, ...extra: number[]): Seed {
  const saltInts = typeof salt === 'string' ? stringToInts(salt) : [salt];
  return hash(parent, ...saltInts, ...extra);
}

/** Root of the chain. Accepts a human-typed string or a number. */
export function universeSeed(root: string | number): Seed {
  const rootInts = typeof root === 'string' ? stringToInts(root) : [root];
  return deriveSeed(0, SEED_SALT.universe, ...rootInts);
}

/** A sector of space, addressed by integer grid coordinates. */
export function sectorSeed(universe: Seed, sx: number, sy: number, sz: number): Seed {
  return deriveSeed(universe, SEED_SALT.sector, sx, sy, sz);
}

/** A star system inside a sector, addressed by index. */
export function systemSeed(sector: Seed, index: number): Seed {
  return deriveSeed(sector, SEED_SALT.system, index);
}

/** A body inside a system, addressed by index. */
export function bodySeed(system: Seed, index: number): Seed {
  return deriveSeed(system, SEED_SALT.body, index);
}

/** The surface field of a body. This is what the terrain noise is keyed on. */
export function surfaceSeed(body: Seed): Seed {
  return deriveSeed(body, SEED_SALT.surface);
}

/** A full path through the chain, for logging and for reproducing a location. */
export interface SeedPath {
  readonly universe: string | number;
  readonly sector: readonly [number, number, number];
  readonly system: number;
  readonly body: number;
}

/** Walk a whole path in one call. */
export function resolveSeedPath(path: SeedPath): {
  universe: Seed;
  sector: Seed;
  system: Seed;
  body: Seed;
  surface: Seed;
} {
  const universe = universeSeed(path.universe);
  const sector = sectorSeed(universe, path.sector[0], path.sector[1], path.sector[2]);
  const system = systemSeed(sector, path.system);
  const body = bodySeed(system, path.body);
  const surface = surfaceSeed(body);
  return { universe, sector, system, body, surface };
}
