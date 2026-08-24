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
  ALBEDO,
  ASTRONOMICAL_UNIT,
  CLEAR_SKY_SURFACE_ILLUMINANCE,
  INCIDENT_LIGHT_CALIBRATION,
  MAX_HALF_FLOAT,
  REFLECTED_LIGHT_CALIBRATION,
  SOLAR_CONSTANT,
  SOLAR_ILLUMINANCE_1AU,
  SOLAR_RADIUS,
  SOLAR_TEMPERATURE,
  SUN,
  SUNNY_16,
  adaptEv100,
  angularRadius,
  discLuminance,
  ev100FromCamera,
  ev100FromIlluminance,
  ev100FromLuminance,
  exposeLuminance,
  exposureFromEv100,
  illuminanceAtDistance,
  lambertLuminance,
  luminanceFromEv100,
  solidAngle,
  subsolarLuminance,
  type CameraSettings,
  type Star,
} from './photometry.ts';

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
