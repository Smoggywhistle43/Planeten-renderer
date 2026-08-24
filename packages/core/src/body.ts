/**
 * A body is data. No class, no methods, no inheritance hierarchy for planet
 * types — a rocky planet and a gas giant are the same shape of record with
 * different numbers in it. Anything that needs behaviour is a free function
 * that takes a `Body`.
 *
 * This is the contract the headless simulation and the renderer share, so it
 * has to stay a plain serialisable object.
 */

import { Pcg32, type Seed } from './hash.ts';
import { surfaceSeed } from './seed.ts';

/** Gravitational constant, m^3 kg^-1 s^-2 (CODATA 2018). */
export const G = 6.6743e-11;

export const EARTH_RADIUS = 6.371e6;
export const EARTH_MASS = 5.9722e24;

/**
 * Coarse classification. It selects parameter ranges during generation; it does
 * not select code paths. Rendering never branches on this.
 */
export type BodyClass = 'rocky' | 'ocean' | 'ice' | 'desert' | 'gasGiant' | 'moon';

export const BODY_CLASSES: readonly BodyClass[] = [
  'rocky',
  'ocean',
  'ice',
  'desert',
  'gasGiant',
  'moon',
] as const;

/**
 * Parameters of the height field. Consumed by `@planet/field`, which is the
 * only place the noise itself lives.
 */
export interface TerrainParams {
  /** Peak-to-mean displacement in metres. */
  readonly amplitude: number;
  /** Cycles per unit sphere radius at the base octave. */
  readonly frequency: number;
  /** Number of fBm octaves. */
  readonly octaves: number;
  /** Frequency multiplier per octave. */
  readonly lacunarity: number;
  /** Amplitude multiplier per octave. */
  readonly gain: number;
  /** Domain offset, so two bodies with the same shape parameters differ. */
  readonly offset: readonly [number, number, number];
}

export interface Body {
  /** Stable string id, derived from the seed. For cache keys and logging. */
  readonly id: string;
  /** The seed this body was generated from. */
  readonly seed: Seed;
  /** Seed of the surface field, derived from `seed`. */
  readonly surfaceSeed: Seed;
  readonly class: BodyClass;
  /** Mean radius, metres. */
  readonly radius: number;
  /** Mass, kilograms. */
  readonly mass: number;
  /** Sidereal rotation period, seconds. Negative means retrograde. */
  readonly rotationPeriod: number;
  /** Axial tilt, radians. */
  readonly axialTilt: number;
  readonly terrain: TerrainParams;
}

/** Parameter ranges per class. Data, not code. */
const CLASS_RANGES: Record<
  BodyClass,
  {
    radius: readonly [number, number];
    density: readonly [number, number];
    reliefFraction: readonly [number, number];
  }
> = {
  rocky: { radius: [2.0e6, 8.0e6], density: [3800, 6000], reliefFraction: [8e-4, 2.5e-3] },
  ocean: { radius: [3.0e6, 9.0e6], density: [3200, 5200], reliefFraction: [4e-4, 1.4e-3] },
  ice: { radius: [1.0e6, 3.0e6], density: [1200, 2600], reliefFraction: [6e-4, 2.0e-3] },
  desert: { radius: [2.0e6, 7.0e6], density: [3600, 5600], reliefFraction: [1.0e-3, 3.0e-3] },
  gasGiant: { radius: [2.5e7, 7.5e7], density: [600, 1600], reliefFraction: [0, 0] },
  moon: { radius: [3.0e5, 2.0e6], density: [1800, 3600], reliefFraction: [1.5e-3, 5.0e-3] },
};

/** Stable id from a seed: eight lowercase hex digits. */
export function bodyId(seed: Seed): string {
  return `b${(seed >>> 0).toString(16).padStart(8, '0')}`;
}

export interface MakeBodyOptions {
  /** Force a class instead of drawing one. */
  readonly bodyClass?: BodyClass;
  /** Override any generated field. Applied last. */
  readonly overrides?: Partial<Omit<Body, 'id' | 'seed' | 'surfaceSeed'>>;
}

/**
 * Generate a body from a seed. Pure: same seed and options in, same record out,
 * on every platform. This is what the golden tests pin down.
 */
export function makeBody(seed: Seed, options: MakeBodyOptions = {}): Body {
  const rng = Pcg32.from(seed);

  const bodyClass = options.bodyClass ?? (BODY_CLASSES[rng.nextInt(0, BODY_CLASSES.length - 1)] as BodyClass);
  const range = CLASS_RANGES[bodyClass];

  const radius = rng.nextRange(range.radius[0], range.radius[1]);
  const density = rng.nextRange(range.density[0], range.density[1]);
  const volume = (4 / 3) * Math.PI * radius ** 3;
  const mass = density * volume;

  const rotationPeriod = rng.nextRange(6 * 3600, 90 * 3600) * (rng.nextFloat() < 0.12 ? -1 : 1);
  const axialTilt = rng.nextRange(0, 0.6);

  const relief = rng.nextRange(range.reliefFraction[0], range.reliefFraction[1]);
  const terrain: TerrainParams = {
    amplitude: radius * relief,
    frequency: rng.nextRange(1.2, 3.4),
    octaves: rng.nextInt(4, 9),
    lacunarity: rng.nextRange(1.9, 2.3),
    gain: rng.nextRange(0.42, 0.56),
    offset: [rng.nextRange(-512, 512), rng.nextRange(-512, 512), rng.nextRange(-512, 512)],
  };

  const body: Body = {
    id: bodyId(seed),
    seed,
    surfaceSeed: surfaceSeed(seed),
    class: bodyClass,
    radius,
    mass,
    rotationPeriod,
    axialTilt,
    terrain,
    ...options.overrides,
  };

  return Object.freeze(body);
}

/**
 * The reference body for stage 01: Earth-sized, and flat.
 *
 * `terrain.amplitude` is 0 on purpose. Acceptance criterion 3 asks for a sphere
 * of radius 6.371e6 m, and a sphere is what this is — the height node still
 * runs in the vertex stage, it just contributes nothing. The explorer can raise
 * the amplitude at runtime to show the field is live.
 */
export function referenceBody(seed: Seed = 1): Body {
  return Object.freeze({
    id: 'earth-reference',
    seed,
    surfaceSeed: surfaceSeed(seed),
    class: 'rocky' as const,
    radius: EARTH_RADIUS,
    mass: EARTH_MASS,
    rotationPeriod: 86164.0905,
    axialTilt: 0.40910518,
    terrain: Object.freeze({
      amplitude: 0,
      frequency: 2.0,
      octaves: 6,
      lacunarity: 2.0,
      gain: 0.5,
      offset: [0, 0, 0] as readonly [number, number, number],
    }),
  });
}

/** Standard gravitational parameter, m^3 s^-2. */
export function gravitationalParameter(body: Body): number {
  return G * body.mass;
}

/** Surface gravity at the mean radius, m s^-2. */
export function surfaceGravity(body: Body): number {
  return gravitationalParameter(body) / (body.radius * body.radius);
}

/** Escape velocity at the mean radius, m s^-1. */
export function escapeVelocity(body: Body): number {
  return Math.sqrt((2 * gravitationalParameter(body)) / body.radius);
}

/** Mean density, kg m^-3. */
export function meanDensity(body: Body): number {
  return body.mass / ((4 / 3) * Math.PI * body.radius ** 3);
}

/** Highest point the height field can reach, metres from the centre. */
export function maxSurfaceRadius(body: Body): number {
  return body.radius + body.terrain.amplitude;
}

/** Lowest point the height field can reach, metres from the centre. */
export function minSurfaceRadius(body: Body): number {
  return body.radius - body.terrain.amplitude;
}
