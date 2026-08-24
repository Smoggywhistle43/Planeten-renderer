/**
 * The CPU's way into the height field.
 *
 * The handoff asks for `sampleHeight(dirOnUnitSphere, bodyParams) -> number`,
 * and also insists the CPU value comes from the compute path. WebGPU readback
 * is asynchronous, so those two cannot both hold literally. The resolution
 * agreed for stage 01:
 *
 *   - `sampleHeights(dirs)` is the real call. One dispatch, N points, one
 *     readback. Asynchronous, because it has to be.
 *   - `sampleHeightCached(dir)` is the synchronous accessor from the handoff's
 *     signature. It answers from the results of a previous batch and throws if
 *     the point was never sampled, rather than quietly returning a wrong number
 *     from a second implementation.
 *
 * Either way there is exactly one implementation of the noise, and it is the
 * TSL node in `height.ts`.
 */

import { Fn, instanceIndex, storage } from 'three/tsl';
import { StorageBufferAttribute } from 'three/webgpu';
import type { Body, Vec3d } from '@planet/core';
import {
  createHeightUniforms,
  heightNode,
  updateHeightUniforms,
  type HeightUniforms,
  type Vec3Node,
} from './height.ts';

/** WGSL workgroup size. Capacity is rounded up to a multiple of this. */
const WORKGROUP_SIZE = 64;

const DEFAULT_CAPACITY = 4096;

/** Enough of a renderer for this class. Keeps the import surface honest. */
export interface ComputeCapableRenderer {
  computeAsync(computeNodes: never, dispatchSize?: number): Promise<void>;
  getArrayBufferAsync(attribute: never): Promise<ArrayBuffer>;
}

export interface HeightSamplerOptions {
  /** Maximum points per dispatch. Rounded up to a multiple of 64. */
  readonly capacity?: number;
}

/** Directions accepted by `sampleHeights`: flat xyz triples, or `Vec3d`s. */
export type DirectionInput = ArrayLike<number> | readonly Vec3d[];

function isVec3dArray(input: DirectionInput): input is readonly Vec3d[] {
  return input.length > 0 && typeof (input as readonly Vec3d[])[0] === 'object';
}

export class HeightSampler {
  /** Maximum number of points in one `sampleHeights` call. */
  readonly capacity: number;

  private readonly renderer: ComputeCapableRenderer;
  private readonly uniforms: HeightUniforms;
  private readonly input: StorageBufferAttribute;
  private readonly output: StorageBufferAttribute;
  private readonly kernel: unknown;
  private readonly cache = new Map<string, number>();
  private readonly keyScratch = new Float32Array(3);
  private currentBody: Body;
  private disposed = false;

  constructor(renderer: ComputeCapableRenderer, body: Body, options: HeightSamplerOptions = {}) {
    const requested = options.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(requested) || requested <= 0) {
      throw new RangeError(`HeightSampler: capacity must be a positive integer, got ${requested}`);
    }
    this.capacity = Math.ceil(requested / WORKGROUP_SIZE) * WORKGROUP_SIZE;
    this.renderer = renderer;
    this.currentBody = body;
    this.uniforms = createHeightUniforms(body);

    // vec4 rather than vec3: a storage array of vec3 has a 16-byte stride in
    // WGSL anyway, so packing it as vec4 keeps the CPU and GPU views identical.
    this.input = new StorageBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.output = new StorageBufferAttribute(new Float32Array(this.capacity), 1);

    const directions = storage(this.input, 'vec4', this.capacity).toReadOnly();
    const heights = storage(this.output, 'float', this.capacity);

    this.kernel = Fn(() => {
      const dir = directions.element(instanceIndex).xyz as Vec3Node;
      heights.element(instanceIndex).assign(heightNode(dir, this.uniforms));
    })().compute(this.capacity, [WORKGROUP_SIZE]);
  }

  /** The body this sampler is currently configured for. */
  get body(): Body {
    return this.currentBody;
  }

  /**
   * Retarget at a different body. Drops the cache, because the cached heights
   * belong to the old body.
   */
  setBody(body: Body): void {
    this.assertLive();
    updateHeightUniforms(this.uniforms, body);
    this.currentBody = body;
    this.cache.clear();
  }

  /**
   * Sample N directions in one dispatch.
   *
   * Directions must be unit vectors; nothing normalizes them for you, because
   * silently normalizing would hide a caller bug that only shows up much later
   * as a terrain seam.
   *
   * Returns metres of displacement above the mean radius, widened to float64 —
   * the GPU computed them in float32, so the extra digits are zeros, but every
   * consumer downstream works in float64 and this keeps the seam in one place.
   */
  async sampleHeights(dirs: DirectionInput): Promise<Float64Array> {
    this.assertLive();
    const count = isVec3dArray(dirs) ? dirs.length : Math.floor(dirs.length / 3);
    if (count === 0) return new Float64Array(0);
    if (count > this.capacity) {
      throw new RangeError(
        `HeightSampler: ${count} points exceeds capacity ${this.capacity}. ` +
          'Construct with a larger capacity or split the batch.',
      );
    }

    const packed = this.input.array as Float32Array;
    packed.fill(0);
    if (isVec3dArray(dirs)) {
      for (let i = 0; i < count; i++) {
        const d = dirs[i] as Vec3d;
        packed[i * 4] = d.x;
        packed[i * 4 + 1] = d.y;
        packed[i * 4 + 2] = d.z;
      }
    } else {
      const flat = dirs as ArrayLike<number>;
      for (let i = 0; i < count; i++) {
        packed[i * 4] = flat[i * 3] as number;
        packed[i * 4 + 1] = flat[i * 3 + 1] as number;
        packed[i * 4 + 2] = flat[i * 3 + 2] as number;
      }
    }
    this.input.needsUpdate = true;

    await this.renderer.computeAsync(this.kernel as never, count);
    const buffer = await this.renderer.getArrayBufferAsync(this.output as never);
    const raw = new Float32Array(buffer, 0, this.capacity);

    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const h = raw[i] as number;
      out[i] = h;
      this.cache.set(
        this.keyOf(
          packed[i * 4] as number,
          packed[i * 4 + 1] as number,
          packed[i * 4 + 2] as number,
        ),
        h,
      );
    }
    return out;
  }

  /**
   * The synchronous accessor from the handoff signature.
   *
   * Answers from a previous `sampleHeights` batch. Throws for a point that was
   * never sampled — the alternative would be a second, CPU-side implementation
   * of the noise, which is exactly what this design exists to prevent.
   */
  sampleHeightCached(x: number, y: number, z: number): number {
    this.assertLive();
    const value = this.cache.get(this.keyOf(x, y, z));
    if (value === undefined) {
      throw new Error(
        `HeightSampler: no cached height for direction (${x}, ${y}, ${z}). ` +
          'Await sampleHeights() for this point first.',
      );
    }
    return value;
  }

  /** True if `sampleHeightCached` would answer rather than throw. */
  hasCached(x: number, y: number, z: number): boolean {
    return this.cache.has(this.keyOf(x, y, z));
  }

  /** Number of resolved points currently held. */
  get cacheSize(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cache.clear();
  }

  /**
   * Cache key. Rounds through float32 first, so a caller that passes the
   * float64 direction it started from gets the same key as the value the GPU
   * actually saw.
   */
  private keyOf(x: number, y: number, z: number): string {
    const s = this.keyScratch;
    s[0] = x;
    s[1] = y;
    s[2] = z;
    return `${s[0]},${s[1]},${s[2]}`;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('HeightSampler: already disposed');
  }
}
