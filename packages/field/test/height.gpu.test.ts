/**
 * The determinism test the handoff asks for: 1000 fixed points, sampled twice,
 * identical results. Runs against a real WebGPU device in Vitest browser mode,
 * because the noise exists only as a TSL node — there is nothing to sample on
 * the CPU, by design.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebGPURenderer } from 'three/webgpu';
import { makeBody, referenceBody, type Body } from '@planet/core';
import { HeightSampler } from '../src/sampler.ts';

/** 1000 fixed directions on the unit sphere. No RNG, no platform dependence. */
function fibonacciSphere(count: number): Float64Array {
  const out = new Float64Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out[i * 3] = Math.cos(theta) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(theta) * r;
  }
  return out;
}

const POINTS = fibonacciSphere(1000);

/** A body with real relief, so the test is about numbers and not about zeros. */
const ROUGH: Body = makeBody(20250824, {
  bodyClass: 'rocky',
  overrides: {
    radius: 6.371e6,
    terrain: {
      amplitude: 9000,
      frequency: 2.5,
      octaves: 6,
      lacunarity: 2.0,
      gain: 0.5,
      offset: [17, -42, 5],
    },
  },
});

let renderer: WebGPURenderer;

beforeAll(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  renderer = new WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
}, 120_000);

afterAll(() => {
  renderer?.dispose();
});

describe('HeightSampler on a real device', () => {
  it('reports a WebGPU backend, not a WebGL fallback', () => {
    const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean };
    expect(backend.isWebGPUBackend).toBe(true);
  });

  it('returns bit-identical results for 1000 fixed points sampled twice', async () => {
    const sampler = new HeightSampler(renderer, ROUGH, { capacity: 1024 });
    const first = await sampler.sampleHeights(POINTS);
    const second = await sampler.sampleHeights(POINTS);

    expect(first.length).toBe(1000);
    expect(second.length).toBe(1000);
    for (let i = 0; i < first.length; i++) {
      expect(second[i]).toBe(first[i]);
    }
    sampler.dispose();
  });

  it('returns the same results from a second, independently compiled sampler', async () => {
    const a = new HeightSampler(renderer, ROUGH, { capacity: 1024 });
    const b = new HeightSampler(renderer, ROUGH, { capacity: 1024 });
    const first = await a.sampleHeights(POINTS);
    const second = await b.sampleHeights(POINTS);
    for (let i = 0; i < first.length; i++) {
      expect(second[i]).toBe(first[i]);
    }
    a.dispose();
    b.dispose();
  });

  it('produces relief inside the declared amplitude, and not a flat field', async () => {
    const sampler = new HeightSampler(renderer, ROUGH, { capacity: 1024 });
    const h = await sampler.sampleHeights(POINTS);

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const v of h) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(ROUGH.terrain.amplitude * 1.001);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    // A field that returned a constant would pass every check above.
    expect(max - min).toBeGreaterThan(ROUGH.terrain.amplitude * 0.2);
    sampler.dispose();
  });

  it('is exactly zero for the stage-01 reference body', async () => {
    const sampler = new HeightSampler(renderer, referenceBody(), { capacity: 1024 });
    const h = await sampler.sampleHeights(POINTS);
    // `=== 0` rather than `toBe(0)`: negative noise times zero amplitude is -0,
    // which is the same displacement and a different value under Object.is.
    for (const v of h) expect(v === 0).toBe(true);
    sampler.dispose();
  });

  it('reacts to the seed-derived domain offset', async () => {
    const shifted: Body = { ...ROUGH, terrain: { ...ROUGH.terrain, offset: [900, 900, 900] } };
    const a = new HeightSampler(renderer, ROUGH, { capacity: 1024 });
    const b = new HeightSampler(renderer, shifted, { capacity: 1024 });
    const first = await a.sampleHeights(POINTS);
    const second = await b.sampleHeights(POINTS);

    let differing = 0;
    for (let i = 0; i < first.length; i++) if (first[i] !== second[i]) differing++;
    expect(differing).toBeGreaterThan(900);
    a.dispose();
    b.dispose();
  });

  it('follows setBody without recompiling into a different answer', async () => {
    const sampler = new HeightSampler(renderer, referenceBody(), { capacity: 1024 });
    const flat = await sampler.sampleHeights(POINTS);
    expect(flat.every((v) => v === 0)).toBe(true);

    sampler.setBody(ROUGH);
    const rough = await sampler.sampleHeights(POINTS);

    const reference = new HeightSampler(renderer, ROUGH, { capacity: 1024 });
    const expected = await reference.sampleHeights(POINTS);
    for (let i = 0; i < rough.length; i++) expect(rough[i]).toBe(expected[i]);

    sampler.dispose();
    reference.dispose();
  });

  describe('sampleHeightCached', () => {
    it('answers for a resolved point and refuses an unresolved one', async () => {
      const sampler = new HeightSampler(renderer, ROUGH, { capacity: 1024 });
      const x = POINTS[0] as number;
      const y = POINTS[1] as number;
      const z = POINTS[2] as number;

      expect(sampler.hasCached(x, y, z)).toBe(false);
      expect(() => sampler.sampleHeightCached(x, y, z)).toThrow(/no cached height/);

      const h = await sampler.sampleHeights(POINTS);
      expect(sampler.cacheSize).toBe(1000);
      expect(sampler.hasCached(x, y, z)).toBe(true);
      expect(sampler.sampleHeightCached(x, y, z)).toBe(h[0]);

      // A direction that was never in the batch stays unresolved.
      expect(() => sampler.sampleHeightCached(0.5, 0.5, Math.SQRT1_2)).toThrow(/no cached height/);
      sampler.dispose();
    });

    it('drops the cache when the body changes', async () => {
      const sampler = new HeightSampler(renderer, ROUGH, { capacity: 1024 });
      await sampler.sampleHeights(POINTS);
      expect(sampler.cacheSize).toBe(1000);
      sampler.setBody(referenceBody());
      expect(sampler.cacheSize).toBe(0);
      sampler.dispose();
    });
  });

  describe('input handling', () => {
    it('accepts an empty batch', async () => {
      const sampler = new HeightSampler(renderer, ROUGH, { capacity: 128 });
      expect((await sampler.sampleHeights([])).length).toBe(0);
      sampler.dispose();
    });

    it('rounds capacity up to a workgroup multiple', () => {
      const sampler = new HeightSampler(renderer, ROUGH, { capacity: 100 });
      expect(sampler.capacity).toBe(128);
      sampler.dispose();
    });

    it('refuses a batch larger than its capacity', async () => {
      const sampler = new HeightSampler(renderer, ROUGH, { capacity: 128 });
      await expect(sampler.sampleHeights(POINTS)).rejects.toThrow(/exceeds capacity/);
      sampler.dispose();
    });

    it('refuses use after dispose', async () => {
      const sampler = new HeightSampler(renderer, ROUGH, { capacity: 128 });
      sampler.dispose();
      await expect(sampler.sampleHeights([1, 0, 0])).rejects.toThrow(/disposed/);
    });
  });
});
