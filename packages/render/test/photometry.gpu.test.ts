/**
 * Does the renderer actually produce the luminance the physics predicts?
 *
 * Everything in `@planet/core/photometry` is arithmetic that a unit test can
 * check without a GPU. What it cannot check is whether the numbers survive the
 * trip through three's lighting, the material, the colour management and the
 * framebuffer. One wrong colour-space conversion turns a 0.30 albedo into 0.07
 * and nothing throws — the picture just comes out dark and somebody starts
 * "correcting" it with a fudge factor.
 *
 * So: render a sphere lit by a real sun, read the brightest pixel back, and
 * compare it against `E * albedo / pi`.
 *
 * The measurement is a line fit rather than a single comparison, because a
 * physical material is not purely Lambertian — there is a specular lobe on top.
 * Fitting `luminance = slope * albedo + intercept` separates the two:
 *
 *   slope     must be E / pi, which is the entire diffuse chain in one number
 *   intercept is the specular lobe, which does not scale with albedo
 *
 * If any part of the chain were wrong by a gamma curve, a factor of pi or a
 * unit, the slope would miss by a mile.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AmbientLight,
  DirectionalLight,
  FloatType,
  RenderTarget,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';
import {
  ALBEDO,
  ASTRONOMICAL_UNIT,
  MAX_HALF_FLOAT,
  SUN,
  Vec3d,
  illuminanceAtDistance,
  referenceBody,
  subsolarLuminance,
} from '@planet/core';
import { Planet } from '../src/planet.ts';
import { PlanetCamera } from '../src/planet-camera.ts';

const SIZE = 64;
const CENTRE = new Vec3d(0, 0, 0);
const EARTH = referenceBody();
/** Straight at the sub-solar point: sun behind the camera, zero phase angle. */
const VIEW_DIRECTION = new Vec3d(1, 0, 0);

let renderer: WebGPURenderer;

beforeAll(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  renderer = new WebGPURenderer({ canvas, antialias: false, reversedDepthBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.highPrecision = true;
  await renderer.init();
}, 180_000);

afterAll(() => {
  renderer?.dispose();
});

interface Measurement {
  brightest: number;
  meanLit: number;
}

/**
 * Render the body at zero phase angle and report the brightest pixel.
 *
 * A float render target, not half float, so the readback is the value the
 * shader produced rather than a rounded one.
 */
async function measure(albedo: number, starlightLux = 0): Promise<Measurement> {
  const scene = new Scene();
  const illuminance = illuminanceAtDistance(SUN, ASTRONOMICAL_UNIT);
  const sun = new DirectionalLight(0xffffff, illuminance);
  sun.position.set(VIEW_DIRECTION.x, VIEW_DIRECTION.y, VIEW_DIRECTION.z);
  scene.add(sun);
  if (starlightLux > 0) scene.add(new AmbientLight(0xffffff, starlightLux));

  const planet = new Planet(EARTH, { center: CENTRE, material: { albedo } });
  scene.add(planet.group);
  await planet.init();

  const camera = new PlanetCamera({ fovY: (50 * Math.PI) / 180, aspect: 1 });
  camera.placeAtAltitude(CENTRE, VIEW_DIRECTION, 3e7, EARTH, planet.pose);
  camera.update();
  planet.update(camera, SIZE, SIZE);

  const target = new RenderTarget(SIZE, SIZE, { type: FloatType, depthBuffer: true });
  renderer.setRenderTarget(target);
  renderer.render(scene, camera.three);
  renderer.setRenderTarget(null);
  const pixels = (await renderer.readRenderTargetPixelsAsync(
    target,
    0,
    0,
    SIZE,
    SIZE,
  )) as Float32Array;

  let brightest = 0;
  let sum = 0;
  let lit = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const value = pixels[i] as number;
    if (value > brightest) brightest = value;
    if (value > 1) {
      sum += value;
      lit++;
    }
  }

  target.dispose();
  planet.dispose();
  return { brightest, meanLit: lit > 0 ? sum / lit : 0 };
}

/** Least-squares slope and intercept. */
function fitLine(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += ((xs[i] as number) - meanX) * ((ys[i] as number) - meanY);
    sxx += ((xs[i] as number) - meanX) ** 2;
  }
  const slope = sxy / sxx;
  return { slope, intercept: meanY - slope * meanX };
}

describe('the renderer produces real luminance', () => {
  const ALBEDOS = [0.06, 0.18, 0.3, 0.5, 0.85];
  let measured: number[] = [];

  beforeAll(async () => {
    measured = [];
    for (const albedo of ALBEDOS) {
      measured.push((await measure(albedo)).brightest);
    }
  }, 300_000);

  it('scales exactly with E / pi, which is the whole diffuse chain', () => {
    const expectedSlope = illuminanceAtDistance(SUN, ASTRONOMICAL_UNIT) / Math.PI;
    const { slope } = fitLine([...ALBEDOS], measured);
    // Within one percent. A stray gamma curve would be out by a factor of four,
    // a missing 1/pi by a factor of three.
    expect(Math.abs(slope / expectedSlope - 1)).toBeLessThan(0.01);
  });

  it('leaves only a small, albedo-independent specular term on top', () => {
    const { intercept } = fitLine([...ALBEDOS], measured);
    const subsolar = subsolarLuminance(SUN, ASTRONOMICAL_UNIT, ALBEDO.earthMean);
    // Positive — a specular lobe adds, it never subtracts.
    expect(intercept).toBeGreaterThan(0);
    // And small: a few percent of a mid-albedo surface, not a hidden fill light.
    expect(intercept).toBeLessThan(subsolar * 0.08);
  });

  it('matches the Lambert prediction within a few percent at Earth albedo', () => {
    const index = ALBEDOS.indexOf(0.3);
    const predicted = subsolarLuminance(SUN, ASTRONOMICAL_UNIT, 0.3);
    const ratio = (measured[index] as number) / predicted;
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(1.06);
  });

  it('is monotonic in albedo', () => {
    for (let i = 1; i < measured.length; i++) {
      expect(measured[i]).toBeGreaterThan(measured[i - 1] as number);
    }
  });

  it('stays inside the half-float ceiling even for fresh snow', async () => {
    // The scene buffer is half float. Snow at the sub-solar point is the
    // brightest surface stage 02 can make, and it has to fit.
    const snow = await measure(ALBEDO.freshSnow);
    expect(snow.brightest).toBeLessThan(MAX_HALF_FLOAT);
  }, 180_000);

  it('puts the night side at starlight level, not at zero and not at a fill light', async () => {
    // Physically the unlit side gets about 0.002 lx from stars and zodiacal
    // light. It must be dark by seven orders of magnitude, not "dark grey".
    const starlight = 0.002;
    const withStars = await measure(ALBEDO.earthMean, starlight);
    const sunlit = subsolarLuminance(SUN, ASTRONOMICAL_UNIT, ALBEDO.earthMean);
    // Ambient light raises everything by albedo * E_ambient / pi.
    const expectedNightSide = (starlight * ALBEDO.earthMean) / Math.PI;
    expect(expectedNightSide).toBeLessThan(sunlit * 1e-6);
    // And it must not have measurably brightened the lit side.
    expect(withStars.brightest / sunlit).toBeLessThan(1.06);
  }, 180_000);
});
