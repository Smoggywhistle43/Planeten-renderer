/**
 * End-to-end render smoke test against a real WebGPU device.
 *
 * The Node tests cover the quadtree, the tile maths and the camera. What they
 * cannot cover is whether the TSL graph actually compiles and draws — a broken
 * node graph type-checks perfectly and fails at pipeline creation. This catches
 * that in `pnpm test`, without building the explorer.
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
import { Vec3d, referenceBody, type Body } from '@planet/core';
import { Planet } from '../src/planet.ts';
import { PlanetCamera } from '../src/planet-camera.ts';
import { assertReversedDepth, describeDepth } from '../src/renderer.ts';
import { createPostPipeline } from '../src/post.ts';

const SIZE = 96;
const CENTRE = new Vec3d(0, 0, 0);
const EARTH: Body = referenceBody();

let renderer: WebGPURenderer;
let canvas: HTMLCanvasElement;

beforeAll(async () => {
  canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  renderer = new WebGPURenderer({ canvas, antialias: false, reversedDepthBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 1);
  await renderer.init();
}, 180_000);

afterAll(() => {
  renderer?.dispose();
});

/** Render into an offscreen target and read the pixels back. */
async function renderToPixels(scene: Scene, camera: PlanetCamera): Promise<Float32Array> {
  const target = new RenderTarget(SIZE, SIZE, { type: FloatType, depthBuffer: true });
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera.three);
  renderer.setRenderTarget(previous);
  const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE);
  target.dispose();
  return pixels as Float32Array;
}

function litFraction(pixels: Float32Array): number {
  let lit = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if ((pixels[i] as number) > 0.02) lit++;
  }
  return lit / (pixels.length / 4);
}

describe('the render path on a real device', () => {
  it('runs on WebGPU with reversed-Z, and says so', () => {
    expect(() => assertReversedDepth(renderer)).not.toThrow();
    const depth = describeDepth(renderer);
    expect(depth.backend).toBe('webgpu');
    expect(depth.reversedDepth).toBe(true);
    // The three things the handoff names: 0..1 range with near at 1, a
    // 'greater' comparison, and a clear value of 0.
    expect(depth.clearDepth).toBe(0);
    expect(depth.depthCompare).toBe('greater-equal');
  });

  it('compiles the tile material and draws the sphere', async () => {
    const scene = new Scene();
    const sun = new DirectionalLight(0xffffff, 3);
    sun.position.set(0.6, 0.45, 0.65).normalize();
    scene.add(sun);
    scene.add(new AmbientLight(0x223044, 1.2));

    const camera = new PlanetCamera({ fovY: (50 * Math.PI) / 180, aspect: 1 });
    const planet = new Planet(EARTH, { center: CENTRE });
    scene.add(planet.group);
    await planet.init();

    // Far enough out that the whole disk is in frame.
    camera.placeAtAltitude(CENTRE, new Vec3d(1, 0.2, 0.3), 2e7, EARTH.radius);
    camera.update();
    planet.update(camera, SIZE, SIZE);

    const pixels = await renderToPixels(scene, camera);
    const lit = litFraction(pixels);

    // A sphere of radius 6.371e6 at 2e7 m fills a good part of a square frame,
    // and nothing at all would mean the material failed to compile.
    expect(lit).toBeGreaterThan(0.05);
    expect(lit).toBeLessThan(0.95);
    for (const v of pixels) expect(Number.isNaN(v)).toBe(false);

    planet.dispose();
  }, 180_000);

  it('draws nothing but sky when the planet is behind the camera', async () => {
    const scene = new Scene();
    scene.add(new AmbientLight(0xffffff, 1));
    const camera = new PlanetCamera({ fovY: (50 * Math.PI) / 180, aspect: 1 });
    const planet = new Planet(EARTH, { center: CENTRE });
    scene.add(planet.group);
    await planet.init();

    camera.placeAtAltitude(CENTRE, new Vec3d(1, 0, 0), 2e7, EARTH.radius);
    // Look away from the body.
    camera.lookAt(new Vec3d(1e12, 0, 0));
    camera.update();
    planet.update(camera, SIZE, SIZE);

    expect(litFraction(await renderToPixels(scene, camera))).toBe(0);
    planet.dispose();
  }, 180_000);

  it('holds the build budget while the camera descends', async () => {
    const scene = new Scene();
    scene.add(new AmbientLight(0xffffff, 1));
    const camera = new PlanetCamera({ fovY: (50 * Math.PI) / 180, aspect: 1 });
    const planet = new Planet(EARTH, {
      center: CENTRE,
      lod: { buildBudgetPerFrame: 2, maxDepth: 12 },
    });
    scene.add(planet.group);
    await planet.init();

    let peak = 0;
    for (let i = 0; i <= 120; i++) {
      const altitude = 1e9 * (1e3 / 1e9) ** (i / 120);
      camera.placeAtAltitude(CENTRE, new Vec3d(0.69, 0.33, 0.64), altitude, EARTH.radius);
      camera.update();
      planet.update(camera, SIZE, SIZE);
      peak = Math.max(peak, planet.stats.buildsStartedThisFrame);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(peak).toBeLessThanOrEqual(2);
    expect(planet.stats.maxSelectedDepth).toBeGreaterThan(0);
    planet.dispose();
  }, 180_000);

  it('renders through the TSL node stack without an EffectComposer', async () => {
    const scene = new Scene();
    scene.add(new AmbientLight(0xffffff, 1));
    const camera = new PlanetCamera({ fovY: (50 * Math.PI) / 180, aspect: 1 });
    const planet = new Planet(EARTH, { center: CENTRE });
    scene.add(planet.group);
    await planet.init();

    camera.placeAtAltitude(CENTRE, new Vec3d(1, 0, 0), 2e7, EARTH.radius);
    camera.update();
    planet.update(camera, SIZE, SIZE);

    const post = createPostPipeline(renderer, scene, camera, { exposure: 1 });
    expect(() => post.render()).not.toThrow();
    post.setExposure(0.5);
    expect(() => post.render()).not.toThrow();

    post.dispose();
    planet.dispose();
  }, 180_000);

  it('keeps the tile geometry small and camera-relative all the way down', async () => {
    const camera = new PlanetCamera({ fovY: (50 * Math.PI) / 180, aspect: 1 });
    const planet = new Planet(EARTH, {
      center: CENTRE,
      lod: { buildBudgetPerFrame: 64, maxDepth: 14 },
    });
    await planet.init();

    camera.placeAtAltitude(CENTRE, new Vec3d(0.69, 0.33, 0.64), 1e3, EARTH.radius);
    for (let i = 0; i < 300; i++) {
      camera.update();
      planet.update(camera, SIZE, SIZE);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Precision rules 1 and 2, checked on what the GPU would actually receive.
    for (const node of planet.scheduler.selected) {
      const tile = node.tile;
      if (!tile) continue;
      for (const value of tile.data.positions) {
        expect(Math.abs(value)).toBeLessThan(1e7);
      }
      const translation = tile.mesh.matrixWorld.elements;
      // The object matrix is a pure camera-relative translation.
      expect(translation[0]).toBe(1);
      expect(translation[5]).toBe(1);
      expect(translation[10]).toBe(1);
      expect(Number.isFinite(translation[12] as number)).toBe(true);
    }
    planet.dispose();
  }, 180_000);
});
