/**
 * Does the picture move smoothly when the camera moves by less than float32
 * can represent at Earth's radius?
 *
 * This is acceptance criterion 4, measured on the right instrument. The
 * acceptance script used to do it by reading the canvas back, which meant
 * measuring sub-pixel motion through tone mapping and an 8-bit quantiser: a
 * five-centimetre step changed three pixels out of four hundred thousand, and
 * the real pipeline became indistinguishable from a deliberately broken one.
 * Both were sitting on the noise floor of the instrument, not of the renderer.
 *
 * Here the scene renders into a float target and the pixels come back as
 * floats. A difference of 1e-6 registers. That is the whole point.
 *
 * Every test runs twice: once as built, and once with the camera position
 * forced through float32 before drawing — which is what happens the moment
 * world coordinates stop being camera-relative anywhere. The control has to
 * fail, or the test proves nothing.
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
  SUN,
  Vec3d,
  illuminanceAtDistance,
  referenceBody,
} from '@planet/core';
import { Planet } from '../src/planet.ts';
import { PlanetCamera } from '../src/planet-camera.ts';

const SIZE = 96;
const CENTRE = new Vec3d(0, 0, 0);
const EARTH = referenceBody();

/**
 * float32 resolves about this much at Earth's radius. Any camera step below it
 * is invisible to a pipeline that keeps world coordinates in float32.
 */
const FLOAT32_RESOLUTION_AT_EARTH_RADIUS = 0.5;

let renderer: WebGPURenderer;
let target: RenderTarget;

beforeAll(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  renderer = new WebGPURenderer({ canvas, antialias: false, reversedDepthBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.highPrecision = true;
  await renderer.init();
  target = new RenderTarget(SIZE, SIZE, { type: FloatType, depthBuffer: true });
}, 180_000);

afterAll(() => {
  target?.dispose();
  renderer?.dispose();
});

export interface WalkResult {
  /** How many of the steps changed at least one pixel. */
  stepsThatMoved: number;
  stepsCompared: number;
  /** Mean absolute change per pixel, per step. */
  meanDelta: number[];
  /** Luminance-weighted image centroid at each step, in pixels. */
  centroids: Array<{ x: number; y: number }>;
}

/**
 * Slide the camera sideways along the surface and record what the image does.
 *
 * `precision` of `'f32'` rounds the camera's world position through float32
 * before drawing — the negative control.
 */
async function walkSideways(
  altitude: number,
  stepMetres: number,
  steps: number,
  precision: 'f64' | 'f32',
): Promise<WalkResult> {
  const scene = new Scene();
  const sun = new DirectionalLight(0xffffff, illuminanceAtDistance(SUN, ASTRONOMICAL_UNIT));
  sun.position.set(0.6, 0.45, 0.65).normalize();
  scene.add(sun);
  scene.add(new AmbientLight(0xffffff, 0.002));

  const planet = new Planet(EARTH, {
    center: CENTRE,
    material: { albedo: ALBEDO.earthMean },
    lod: { buildBudgetPerFrame: 64, maxDepth: 16 },
  });
  scene.add(planet.group);
  await planet.init();

  const up = new Vec3d(0.69, 0.33, 0.64).normalize();
  const east = new Vec3d(0, 1, 0).cross(up).normalize();
  const camera = new PlanetCamera({ fovY: (50 * Math.PI) / 180, aspect: 1 });

  // Settle the tree first, so a tile arriving mid-walk cannot be mistaken for
  // camera motion.
  camera.placeAtAltitude(CENTRE, up, altitude, EARTH, planet.pose);
  for (let i = 0; i < 400; i++) {
    camera.update();
    planet.update(camera, SIZE, SIZE);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(planet.stats.buildsStartedThisFrame).toBe(0);

  const narrowing = new Float32Array(3);
  let previous: Float32Array | null = null;
  const result: WalkResult = {
    stepsThatMoved: 0,
    stepsCompared: 0,
    meanDelta: [],
    centroids: [],
  };

  for (let i = 0; i < steps; i++) {
    camera.placeAtAltitude(CENTRE, up, altitude, EARTH, planet.pose);
    camera.position.addScaled(east, i * stepMetres);
    if (precision === 'f32') {
      narrowing[0] = camera.position.x;
      narrowing[1] = camera.position.y;
      narrowing[2] = camera.position.z;
      camera.position.set(narrowing[0] as number, narrowing[1] as number, narrowing[2] as number);
    }
    camera.update();
    planet.update(camera, SIZE, SIZE);

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

    let sumX = 0;
    let sumY = 0;
    let weight = 0;
    for (let p = 0; p < pixels.length; p += 4) {
      const value = pixels[p] as number;
      if (value <= 0) continue;
      const pixel = p / 4;
      sumX += (pixel % SIZE) * value;
      sumY += Math.floor(pixel / SIZE) * value;
      weight += value;
    }
    result.centroids.push({ x: weight > 0 ? sumX / weight : 0, y: weight > 0 ? sumY / weight : 0 });

    if (previous) {
      let changed = 0;
      let absSum = 0;
      for (let p = 0; p < pixels.length; p += 4) {
        const delta = Math.abs((pixels[p] as number) - (previous[p] as number));
        if (delta > 0) changed++;
        absSum += delta;
      }
      result.stepsCompared++;
      if (changed > 0) result.stepsThatMoved++;
      result.meanDelta.push(absSum / (pixels.length / 4));
    }
    previous = pixels.slice();
  }

  planet.dispose();
  return result;
}

describe('sub-float32 camera motion', () => {
  // A tenth of what float32 can hold at Earth's radius.
  const STEP = FLOAT32_RESOLUTION_AT_EARTH_RADIUS / 10;
  const STEPS = 12;
  const ALTITUDE = 1e3;

  let live: WalkResult;
  let control: WalkResult;

  beforeAll(async () => {
    live = await walkSideways(ALTITUDE, STEP, STEPS, 'f64');
    control = await walkSideways(ALTITUDE, STEP, STEPS, 'f32');
  }, 600_000);

  it('uses a step float32 could not represent at this radius', () => {
    expect(STEP).toBeLessThan(FLOAT32_RESOLUTION_AT_EARTH_RADIUS);
  });

  it('moves the image on every single step', () => {
    expect(live.stepsThatMoved).toBe(live.stepsCompared);
    expect(live.stepsCompared).toBe(STEPS - 1);
  });

  it('moves it by a similar amount each time, with no staircase', () => {
    // A quantising pipeline gives a run of zeros followed by a jump. A correct
    // one gives roughly the same small change every step.
    const deltas = live.meanDelta;
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    expect(mean).toBeGreaterThan(0);
    for (const d of deltas) {
      expect(d).toBeGreaterThan(mean * 0.1);
      expect(d).toBeLessThan(mean * 10);
    }
  });

  it('tracks a straight line, sub-pixel', () => {
    const first = live.centroids[0];
    const last = live.centroids[live.centroids.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    // It moved, and by far less than a pixel over the whole walk.
    const travel = Math.hypot(
      (last as { x: number }).x - (first as { x: number }).x,
      (last as { y: number }).y - (first as { y: number }).y,
    );
    expect(travel).toBeGreaterThan(0);
    expect(travel).toBeLessThan(1);
  });

  describe('the negative control', () => {
    it('freezes, because float32 cannot hold the step', () => {
      // This is the failure the design exists to prevent. If it ever stops
      // failing, the test above has lost its power and means nothing.
      expect(control.stepsThatMoved).toBeLessThan(control.stepsCompared);
    });

    it('moves the image on fewer steps than the real pipeline', () => {
      expect(control.stepsThatMoved).toBeLessThan(live.stepsThatMoved);
    });
  });
});

describe('camera motion above float32 resolution', () => {
  it('moves the image in both pipelines, so the control is not simply broken', async () => {
    // Ten times float32's resolution: both must move. A control that never
    // renders anything would pass the test above for the wrong reason.
    const step = FLOAT32_RESOLUTION_AT_EARTH_RADIUS * 10;
    const live = await walkSideways(1e3, step, 5, 'f64');
    const control = await walkSideways(1e3, step, 5, 'f32');
    expect(live.stepsThatMoved).toBe(live.stepsCompared);
    expect(control.stepsThatMoved).toBe(control.stepsCompared);
  }, 600_000);
});
