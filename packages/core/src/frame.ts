/**
 * Floating origin.
 *
 * World coordinates are float64 and can run to 1e12 m. The GPU only ever sees
 * float32. `Frame` is the seam between the two: it holds an origin in world
 * space, hands out small offsets relative to it, and moves the origin once the
 * observer has drifted past a threshold.
 *
 * The renderer never uploads a world position — see `toCameraRelative32`, which
 * is the single float32 narrowing in the whole pipeline. Everything upstream of
 * it stays in float64.
 */

import { Vec3d } from './vec3d.ts';

/** Float32 has 24 bits of mantissa. */
const F32_MANTISSA_BITS = 24;

export interface FrameOptions {
  /** World-space origin to start from. Defaults to (0, 0, 0). */
  readonly origin?: Vec3d;
  /**
   * How far the observer may drift from the origin before the origin follows.
   * Default 4096 m: small enough that anything expressed in frame space keeps
   * sub-millimetre float32 resolution, large enough that rebasing is rare.
   */
  readonly threshold?: number;
}

export class Frame {
  /** Current origin in world space. Read-only from outside; use `rebaseTo`. */
  readonly origin: Vec3d;

  /** Drift distance that triggers a rebase, in metres. */
  threshold: number;

  /** Bumped on every rebase, so caches keyed on frame space can invalidate. */
  version = 0;

  /** How often the origin has moved. Diagnostics only. */
  rebaseCount = 0;

  /** Scratch, to keep `update` allocation-free on the hot path. */
  private readonly scratch = new Vec3d();

  constructor(options: FrameOptions = {}) {
    this.origin = options.origin ? options.origin.clone() : Vec3d.zero();
    this.threshold = options.threshold ?? 4096;
    if (!(this.threshold > 0)) {
      throw new RangeError(`Frame: threshold must be positive, got ${this.threshold}`);
    }
  }

  /** World -> frame space, float64. Small as long as the caller is near the origin. */
  toFrame(world: Vec3d, out: Vec3d = new Vec3d()): Vec3d {
    return out.subVectors(world, this.origin);
  }

  /** Frame space -> world, float64. */
  toWorld(local: Vec3d, out: Vec3d = new Vec3d()): Vec3d {
    return out.addVectors(local, this.origin);
  }

  /** Distance of a world point from the current origin. */
  distanceFromOrigin(world: Vec3d): number {
    return world.distanceTo(this.origin);
  }

  /** True if the observer has drifted past the threshold. */
  needsRebase(observerWorld: Vec3d): boolean {
    return observerWorld.distanceToSq(this.origin) > this.threshold * this.threshold;
  }

  /** Move the origin unconditionally. */
  rebaseTo(world: Vec3d): void {
    this.origin.copy(world);
    this.version++;
    this.rebaseCount++;
  }

  /**
   * Call once per frame with the observer position. Rebases if the observer
   * has drifted past the threshold. Returns true if the origin moved.
   */
  update(observerWorld: Vec3d): boolean {
    if (!this.needsRebase(observerWorld)) return false;
    this.rebaseTo(observerWorld);
    return true;
  }

  /**
   * World -> camera-relative float32. This is the only place a float64 world
   * coordinate becomes float32 in the render path.
   *
   * The subtraction happens in float64 first, so the float32 value it produces
   * carries the full precision of a *small* number rather than the truncation
   * of a large one. A tile origin 10 km away lands with ~0.6 mm of error; the
   * same tile origin uploaded absolutely would land with ~0.5 m of error.
   */
  toCameraRelative32(
    world: Vec3d,
    cameraWorld: Vec3d,
    out: Float32Array,
    offset = 0,
  ): Float32Array {
    const s = this.scratch.subVectors(world, cameraWorld);
    out[offset] = s.x;
    out[offset + 1] = s.y;
    out[offset + 2] = s.z;
    return out;
  }

  /** Same as `toCameraRelative32`, but returning float64 for further CPU work. */
  toCameraRelative(world: Vec3d, cameraWorld: Vec3d, out: Vec3d = new Vec3d()): Vec3d {
    return out.subVectors(world, cameraWorld);
  }
}

/**
 * Absolute float32 resolution at a given magnitude, in the same unit.
 *
 * `float32PrecisionAt(6.371e6)` is ~0.5 m — that is the number the whole
 * camera-relative design exists to avoid. The overlay shows it so the headroom
 * stays visible instead of theoretical.
 */
export function float32PrecisionAt(magnitude: number): number {
  const m = Math.abs(magnitude);
  if (m === 0) return 2 ** -149;
  return 2 ** (Math.floor(Math.log2(m)) - (F32_MANTISSA_BITS - 1));
}
