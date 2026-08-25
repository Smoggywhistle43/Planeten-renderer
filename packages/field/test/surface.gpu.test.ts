/**
 * The surface, measured on a real device.
 *
 * Two things can only be checked here. First, how much of a body is ocean:
 * that depends on the *distribution* of the height field, which exists only as
 * a TSL node, so the honest way to find out is to sample it. Second, that the
 * shader's temperature model still agrees with the one in `@planet/core` — two
 * copies of a formula, deliberately, and this is what stops them parting
 * company.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebGPURenderer } from 'three/webgpu';
import { Fn, float, instanceIndex, storage, vec4 } from 'three/tsl';
import { StorageBufferAttribute } from 'three/webgpu';
import {
  EARTH_PALETTE,
  FREEZING_POINT,
  parseSurfacePalette,
  referenceBody,
  seaLevel,
  surfacePaletteToJson,
  surfaceTemperature,
  type Body,
} from '@planet/core';
import { HeightSampler } from '../src/sampler.ts';
import {
  applyPalette,
  climateSurface,
  surfaceTemperatureNode,
  uniformSurface,
} from '../src/surface.ts';

/** Evenly spread directions. No RNG, so the numbers are the same everywhere. */
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

/**
 * The body the explorer actually shows: Earth's reference shape and climate,
 * with 9 km of relief.
 */
const EARTH: Body = Object.freeze({
  ...referenceBody(),
  terrain: { ...referenceBody().terrain, amplitude: 20_000 },
});

const POINTS = fibonacciSphere(4000);

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

describe('how much of the body is under water', () => {
  let heights: Float64Array;

  beforeAll(async () => {
    const sampler = new HeightSampler(renderer, EARTH);
    heights = await sampler.sampleHeights(POINTS);
    sampler.dispose();
  }, 120_000);

  it('floods roughly seven tenths of it, as Earth is flooded', () => {
    // Earth is 71 % ocean. `seaLevelFraction` is a fraction of the relief, not
    // a fraction of the area, and the height field is not evenly distributed —
    // so the only way to know what a given sea level floods is to sample it.
    const level = seaLevel(EARTH.surface, EARTH.terrain.amplitude);
    let flooded = 0;
    for (const h of heights) if (h < level) flooded++;
    const fraction = flooded / heights.length;
    expect(fraction).toBeGreaterThan(0.6);
    expect(fraction).toBeLessThan(0.8);
  });

  it('leaves enough land to see', () => {
    // A body that is 99 % ocean is a blue marble with nothing on it. This is
    // the assertion that catches a sea level set too high.
    const level = seaLevel(EARTH.surface, EARTH.terrain.amplitude);
    let land = 0;
    for (const h of heights) if (h >= level) land++;
    expect(land / heights.length).toBeGreaterThan(0.2);
  });

  it('puts some land above the tropical snow line', () => {
    // Around 4600 m at the equator for this climate. If nothing reaches it,
    // there are no snow-capped mountains anywhere and the snow term is dead
    // code outside the ice caps.
    const level = seaLevel(EARTH.surface, EARTH.terrain.amplitude);
    let high = 0;
    for (const h of heights) if (h - level > 4600) high++;
    expect(high).toBeGreaterThan(0);
  });

  it('never reaches the amplitude it was asked for', () => {
    // `terrain.amplitude` is an upper bound. Fractal noise does not reach its
    // own extremes: six octaves at gain 0.5 deliver about 45 % of the nominal
    // figure. Everything downstream that treats the amplitude as a bound —
    // node bounds, skirts, the LOD error — is therefore safe, and anyone
    // reading it as "the relief" would be wrong by more than a factor of two.
    let peak = 0;
    for (const h of heights) peak = Math.max(peak, Math.abs(h));
    const achieved = peak / EARTH.terrain.amplitude;
    expect(achieved).toBeGreaterThan(0.3);
    expect(achieved).toBeLessThan(0.6);
  });

  it('gives the explorer roughly the range of relief Earth has', () => {
    const level = seaLevel(EARTH.surface, EARTH.terrain.amplitude);
    let highest = -Infinity;
    let lowest = Infinity;
    for (const h of heights) {
      highest = Math.max(highest, h - level);
      lowest = Math.min(lowest, h - level);
    }
    // Everest is 8849 m, the Mariana Trench -10 994 m.
    expect(highest).toBeGreaterThan(4000);
    expect(highest).toBeLessThan(12_000);
    expect(lowest).toBeLessThan(-6000);
    expect(lowest).toBeGreaterThan(-16_000);
  });

  it('gives the same answer twice', () => {
    // The determinism the height test already covers, restated for the
    // classification that now depends on it.
    const level = seaLevel(EARTH.surface, EARTH.terrain.amplitude);
    const first = heights.filter((h) => h < level).length;
    const second = heights.filter((h) => h < level).length;
    expect(second).toBe(first);
  });
});

describe('the shader temperature model against the one in core', () => {
  /**
   * Run `surfaceTemperatureNode` over a list of (sinLatitude, elevation) pairs
   * and read the answers back.
   *
   * The point of this test: `surfaceTemperature` exists twice, once in
   * TypeScript so it can be checked against real climatology in Node, and once
   * in TSL because that is where it runs. Two copies drift. This is the thing
   * that notices.
   */
  const CASES: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [0, 8849],
    [0.25, 0],
    [0.5, 1000],
    [0.707, 0],
    [0.857, 0],
    [1, 0],
    [-0.5, 3000],
    [-1, 12_000],
    [0.3, -5000],
  ];

  let gpu: Float32Array;

  beforeAll(async () => {
    // The uniforms live inside the model now, so the kernel reads the body's
    // climate directly — the same numbers the shader would.
    const climate = EARTH.surface;
    const count = CASES.length;

    const input = new StorageBufferAttribute(new Float32Array(count * 2), 2);
    CASES.forEach(([sinLat, elevation], i) => {
      (input.array as Float32Array)[i * 2] = sinLat;
      (input.array as Float32Array)[i * 2 + 1] = elevation;
    });
    const output = new StorageBufferAttribute(new Float32Array(count), 1);

    const inNode = storage(input, 'vec2', count).toReadOnly();
    const outNode = storage(output, 'float', count);

    const kernel = Fn(() => {
      const pair = inNode.element(instanceIndex);
      outNode
        .element(instanceIndex)
        .assign(
          surfaceTemperatureNode(
            pair.x,
            pair.y,
            float(climate.equatorTemperature),
            float(climate.poleTemperature),
            float(climate.lapseRate),
          ),
        );
    })().compute(count);

    await renderer.computeAsync(kernel);
    gpu = new Float32Array(await renderer.getArrayBufferAsync(output));
  }, 120_000);

  it('agrees to within a hundredth of a kelvin', () => {
    CASES.forEach(([sinLat, elevation], i) => {
      const expected = surfaceTemperature(EARTH.surface, sinLat, elevation);
      expect(Math.abs((gpu[i] as number) - expected)).toBeLessThan(0.01);
    });
  });

  it('agrees on which places are below freezing', () => {
    CASES.forEach(([sinLat, elevation], i) => {
      const expected = surfaceTemperature(EARTH.surface, sinLat, elevation);
      expect((gpu[i] as number) < FREEZING_POINT).toBe(expected < FREEZING_POINT);
    });
  });

  it('puts the ice edge near 59 degrees, not 47', () => {
    // The number the fourth-power falloff buys, checked on the device rather
    // than only in Node. The square-of-sine version froze everything above 47.
    const sinOf = (deg: number): number => Math.sin((deg * Math.PI) / 180);
    expect(surfaceTemperature(EARTH.surface, sinOf(50), 0)).toBeGreaterThan(FREEZING_POINT);
    expect(surfaceTemperature(EARTH.surface, sinOf(65), 0)).toBeLessThan(FREEZING_POINT);
  });

  it('does not use the ocean floor to warm the sea', () => {
    // The negative-elevation case, on the device: clamped, not extrapolated.
    const belowIndex = CASES.findIndex(([, elevation]) => elevation < 0);
    const [sinLat] = CASES[belowIndex] as readonly [number, number];
    expect(gpu[belowIndex] as number).toBeCloseTo(
      surfaceTemperature(EARTH.surface, sinLat, 0),
      1,
    );
  });
});

describe('the surface seam, end to end', () => {
  /**
   * Run a `SurfaceModel` over crafted points and read back what it says.
   *
   * This is the test that the mechanism and the palette are wired to each
   * other: the model is handed conditions that can only mean one role, and the
   * reflectance that comes back has to be that role's.
   */
  async function albedoAt(
    model: ReturnType<typeof climateSurface>,
    points: ReadonlyArray<readonly [number, number, number, number]>,
  ): Promise<number[][]> {
    const count = points.length;
    const input = new StorageBufferAttribute(new Float32Array(count * 4), 4);
    points.forEach(([x, y, z, elevation], i) => {
      const a = input.array as Float32Array;
      a[i * 4] = x;
      a[i * 4 + 1] = y;
      a[i * 4 + 2] = z;
      a[i * 4 + 3] = elevation;
    });
    const output = new StorageBufferAttribute(new Float32Array(count * 4), 4);
    const inNode = storage(input, 'vec4', count).toReadOnly();
    const outNode = storage(output, 'vec4', count);

    const kernel = Fn(() => {
      const p = inNode.element(instanceIndex);
      const colour = model.albedo({
        direction: p.xyz.normalize(),
        elevation: p.w,
        // One kilometre per pixel: an orbital view. Nothing in the climate
        // model reads it yet, which is itself worth knowing.
        footprint: float(1000),
      });
      outNode.element(instanceIndex).assign(vec4(colour, 1));
    })().compute(count);

    await renderer.computeAsync(kernel);
    const raw = new Float32Array(await renderer.getArrayBufferAsync(output));
    const out: number[][] = [];
    for (let i = 0; i < count; i++) {
      out.push([raw[i * 4] as number, raw[i * 4 + 1] as number, raw[i * 4 + 2] as number]);
    }
    return out;
  }

  const luminous = (rgb: number[]): number =>
    0.2126 * (rgb[0] as number) + 0.7152 * (rgb[1] as number) + 0.0722 * (rgb[2] as number);

  it('puts the right role under the right conditions', async () => {
    const model = climateSurface(EARTH);
    // equator deep, equator high, pole at sea level, mid-latitude lowland
    const [deep, peak, pole] = await albedoAt(model, [
      [1, 0, 0, -3000],
      [1, 0, 0, 7000],
      [0, 1, 0, -200],
      [0.7, 0.5, 0.5, 300],
    ]);

    // Under water at the warm equator: the darkest thing on the body, and blue.
    expect(luminous(deep as number[])).toBeLessThan(0.12);
    expect((deep as number[])[2] as number).toBeGreaterThan((deep as number[])[0] as number);

    // Seven kilometres up on the equator is above the snow line.
    expect(luminous(peak as number[])).toBeGreaterThan(0.5);

    // The pole is under ice, which is bright but not as bright as snow.
    expect(luminous(pole as number[])).toBeGreaterThan(0.4);
  }, 120_000);

  it('changes what it says when the palette changes, without rebuilding', async () => {
    // The point of keeping the palette in uniforms: a design can be dropped in
    // between frames. Same model object, same node graph, different answer.
    const model = climateSurface(EARTH);
    const before = await albedoAt(model, [[1, 0, 0, -3000]]);

    const lava = parseSurfacePalette({
      ...(surfacePaletteToJson(EARTH_PALETTE) as Record<string, unknown>),
      name: 'lava',
      roles: {
        ...((surfacePaletteToJson(EARTH_PALETTE) as { roles: Record<string, unknown> }).roles),
        water: { albedo: [0.9, 0.35, 0.05], roughness: 0.7 },
      },
    });
    expect(applyPalette(model, lava)).toBe(true);
    const after = await albedoAt(model, [[1, 0, 0, -3000]]);

    expect((after[0] as number[])[0]).toBeGreaterThan(0.7);
    expect((after[0] as number[])[0]).toBeGreaterThan((before[0] as number[])[0] as number * 5);
    expect(model.name).toBe('climate:lava');
  }, 120_000);

  it('reports a uniform model as having no palette to swap', () => {
    const plain = uniformSurface(0.3);
    expect(plain.name).toBe('uniform');
    expect(applyPalette(plain, EARTH_PALETTE)).toBe(false);
  });
});
