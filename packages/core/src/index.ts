/**
 * @planet/core — the renderer-free half of the engine.
 *
 * Nothing in here imports `three` or touches the DOM, so the simulation can run
 * headless in Node. `pnpm check:deps` enforces that; it is not a convention.
 */

export { Vec3d, add, sub, scale, dot, cross, normalize, distance, tangentBasis } from './vec3d.ts';

export { Frame, float32PrecisionAt, type FrameOptions } from './frame.ts';

export {
  hash,
  randFloat,
  randRange,
  randInt,
  randPick,
  Pcg32,
  type Seed,
  type SeedInput,
} from './hash.ts';

export {
  deriveSeed,
  universeSeed,
  sectorSeed,
  systemSeed,
  bodySeed,
  surfaceSeed,
  resolveSeedPath,
  SEED_SALT,
  type SeedPath,
} from './seed.ts';

export {
  makeBody,
  referenceBody,
  bodyId,
  gravitationalParameter,
  surfaceGravity,
  escapeVelocity,
  meanDensity,
  maxSurfaceRadius,
  minSurfaceRadius,
  BODY_CLASSES,
  G,
  EARTH_RADIUS,
  EARTH_MASS,
  type Body,
  type BodyClass,
  type TerrainParams,
  type MakeBodyOptions,
} from './body.ts';
