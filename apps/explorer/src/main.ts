/**
 * The explorer: one grey sphere at Earth's radius, and a camera that flies from
 * 1e9 m down to 1e3 m above it.
 *
 * Vanilla TypeScript, no framework. The whole app is a renderer, a planet, a
 * camera and a frame loop, and it exposes `window.__planet` so the acceptance
 * script can step it deterministically instead of racing a real-time loop.
 */

import { AmbientLight, DirectionalLight, Scene } from 'three/webgpu';
import { Vec3d, referenceBody, type Body } from '@planet/core';
import {
  DEFAULT_LOD_CONFIG,
  Planet,
  PlanetCamera,
  createPlanetRenderer,
  createPostPipeline,
  describeDepth,
  type DepthConfiguration,
  type PlanetStats,
} from '@planet/render';
import { Flight } from './flight.ts';
import { Overlay } from './overlay.ts';

/** How much relief the `H` key dials in. Zero is the acceptance configuration. */
const TERRAIN_PREVIEW_AMPLITUDE = 12_000;

const BODY_CENTRE = new Vec3d(0, 0, 0);

interface HarnessStats extends PlanetStats {
  altitude: number;
  frameMs: number;
  progress: number;
  peakBuildsPerFrame: number;
  budget: number;
  everExceededBudget: boolean;
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  pixelRatio: number;
}

/** The surface the acceptance harness drives. Also handy from a dev console. */
export interface PlanetHarness {
  readonly ready: boolean;
  readonly body: Body;
  readonly depth: DepthConfiguration;
  /**
   * Render exactly one frame, advancing the flight by `deltaSeconds`.
   *
   * Synchronous on purpose: a caller that wants to read the canvas back has to
   * do it in the same task, before the compositor presents and the drawing
   * buffer stops being readable.
   */
  renderFrame(deltaSeconds?: number): void;
  /** Let queued tile builds run. Await between frames to mimic a real loop. */
  pump(): Promise<void>;
  /** Jump the flight to an exact altitude. */
  setAltitude(altitude: number): void;
  /** Nudge the camera sideways along the surface, metres. For jitter probing. */
  nudgeAlong(metres: number): void;
  setTilt(tilt: number): void;
  setFlightRunning(running: boolean): void;
  setLodDebug(amount: number): void;
  setHeightScale(scale: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  /**
   * Negative control for the precision rules.
   *
   * With `'f32'` the camera's world position is rounded through float32 before
   * anything is drawn — which is what happens the moment a renderer keeps world
   * coordinates in a Vector3. At Earth's radius that quantises the camera to
   * about half a metre, so the picture snaps instead of moving.
   *
   * It exists so the acceptance run can show its jitter test actually detects
   * jitter, rather than asserting a property it has no power to falsify.
   */
  setCameraPrecision(mode: 'f64' | 'f32'): void;
  stats(): HarnessStats;
  resetMetrics(): void;
}

declare global {
  interface Window {
    __planet?: PlanetHarness;
    __planetError?: string;
  }
}

const canvas = document.getElementById('view') as HTMLCanvasElement;
const statsElement = document.getElementById('stats') as HTMLElement;
const fatalElement = document.getElementById('fatal') as HTMLElement;

function fatal(error: unknown): void {
  const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error);
  window.__planetError = message;
  fatalElement.textContent = `Start fehlgeschlagen.\n\n${message}`;
  fatalElement.classList.add('shown');
  console.error(error);
}

async function boot(): Promise<void> {
  const body = referenceBody();

  const renderer = await createPlanetRenderer({
    canvas,
    antialias: true,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const depth = describeDepth(renderer);

  const scene = new Scene();
  const sun = new DirectionalLight(0xffffff, 3.0);
  sun.position.set(0.6, 0.45, 0.65).normalize();
  scene.add(sun);
  scene.add(new AmbientLight(0x223044, 1.2));

  const camera = new PlanetCamera({
    fovY: (50 * Math.PI) / 180,
    near: 0.05,
    far: 1e12,
    rebaseThreshold: 4096,
  });

  const errorThreshold = DEFAULT_LOD_CONFIG.errorThresholdPixels;
  const budget = DEFAULT_LOD_CONFIG.buildBudgetPerFrame;

  const planet = new Planet(body, {
    center: BODY_CENTRE,
    lod: { errorThresholdPixels: errorThreshold, buildBudgetPerFrame: budget },
    onBuildError: (error, key) => {
      console.error('tile build failed', key, error);
    },
  });
  scene.add(planet.group);
  await planet.init();

  // Stage 01 renders through the node stack even though it has no effects, so
  // the seam is exercised rather than merely planned for.
  const post = createPostPipeline(renderer, scene, camera);

  const flight = new Flight();
  const overlay = new Overlay(statsElement);

  let heightScale = 0;
  let lodDebug = 0;
  let lastFrameMs = 0;
  let alongTrack = 0;
  let cameraPrecision: 'f64' | 'f32' = 'f64';
  const narrowing = new Float32Array(3);

  planet.materialHandle.setHeightScale(heightScale);

  function resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height, false);
    camera.setViewport(width, height);
  }

  function drawingBuffer(): { width: number; height: number } {
    const ratio = renderer.getPixelRatio();
    return {
      width: Math.round(canvas.clientWidth * ratio),
      height: Math.round(canvas.clientHeight * ratio),
    };
  }

  function frame(deltaSeconds: number): void {
    const started = performance.now();

    flight.advance(deltaSeconds);
    flight.applyTo(camera, BODY_CENTRE, body.radius);
    if (alongTrack !== 0) {
      // A pure translation along the surface, applied in float64 after the
      // scripted placement. This is what the jitter probe walks the camera with.
      const up = camera.position.clone().sub(BODY_CENTRE).normalize();
      const east = new Vec3d(0, 1, 0).cross(up);
      if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
      camera.position.addScaled(east.normalize(), alongTrack);
    }
    if (cameraPrecision === 'f32') {
      narrowing[0] = camera.position.x;
      narrowing[1] = camera.position.y;
      narrowing[2] = camera.position.z;
      camera.position.set(narrowing[0] as number, narrowing[1] as number, narrowing[2] as number);
    }
    camera.update();

    const buffer = drawingBuffer();
    planet.update(camera, buffer.width, buffer.height);
    post.render();

    lastFrameMs = performance.now() - started;

    overlay.update({
      body,
      bodyCenter: BODY_CENTRE,
      camera,
      stats: planet.stats,
      depth,
      budget,
      errorThreshold,
      altitude: camera.altitudeAbove(BODY_CENTRE, body.radius),
      frameMs: lastFrameMs,
      pixelRatio: renderer.getPixelRatio(),
      drawingBufferHeight: buffer.height,
      flightRunning: flight.running,
      heightScale,
    });
  }

  // ---- interactive loop ---------------------------------------------------

  let previous = performance.now();
  let looping = true;

  function tick(now: number): void {
    if (!looping) return;
    // Clamp, so a background tab does not teleport the flight on return.
    const delta = Math.min(0.1, (now - previous) / 1000);
    previous = now;
    frame(delta);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.addEventListener('resize', resize);
  resize();

  // ---- input --------------------------------------------------------------

  window.addEventListener('keydown', (event) => {
    switch (event.key) {
      case ' ':
        flight.running = !flight.running;
        event.preventDefault();
        break;
      case 'r':
      case 'R':
        flight.restart();
        overlay.reset();
        break;
      case '[':
        flight.progress = Math.max(0, flight.progress - 0.02);
        break;
      case ']':
        flight.progress = Math.min(1, flight.progress + 0.02);
        break;
      case 't':
      case 'T':
        flight.tilt = flight.tilt > 0 ? 0 : 0.85;
        break;
      case 'l':
      case 'L':
        lodDebug = lodDebug > 0 ? 0 : 1;
        planet.materialHandle.setLodDebug(lodDebug);
        break;
      case 'h':
      case 'H':
        heightScale = heightScale > 0 ? 0 : 1;
        planet.materialHandle.setBody({
          ...body,
          terrain: {
            ...body.terrain,
            amplitude: heightScale > 0 ? TERRAIN_PREVIEW_AMPLITUDE : 0,
          },
        });
        planet.materialHandle.setHeightScale(1);
        break;
      default:
        break;
    }
  });

  let dragging = false;
  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointerup', (event) => {
    dragging = false;
    canvas.releasePointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    flight.yaw += event.movementX * 0.002;
    flight.pitch = Math.max(-1.2, Math.min(1.2, flight.pitch - event.movementY * 0.002));
  });

  // ---- harness ------------------------------------------------------------

  const harness: PlanetHarness = {
    ready: true,
    body,
    depth,
    renderFrame(deltaSeconds = 0): void {
      looping = false;
      frame(deltaSeconds);
    },
    async pump(): Promise<void> {
      // Lets the builder's queued task run, so a stepped run makes the same
      // progress a real-time run would.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    setAltitude(altitude: number): void {
      flight.setAltitude(altitude);
    },
    nudgeAlong(metres: number): void {
      alongTrack = metres;
    },
    setTilt(tilt: number): void {
      flight.tilt = tilt;
    },
    setFlightRunning(running: boolean): void {
      flight.running = running;
    },
    setLodDebug(amount: number): void {
      lodDebug = amount;
      planet.materialHandle.setLodDebug(amount);
    },
    setHeightScale(scale: number): void {
      heightScale = scale;
      planet.materialHandle.setBody({
        ...body,
        terrain: { ...body.terrain, amplitude: scale > 0 ? TERRAIN_PREVIEW_AMPLITUDE : 0 },
      });
      planet.materialHandle.setHeightScale(scale > 0 ? 1 : 0);
    },
    setCameraPrecision(mode: 'f64' | 'f32'): void {
      cameraPrecision = mode;
    },
    setSize(width: number, height: number, pixelRatio: number): void {
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, false);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      camera.setViewport(width, height);
    },
    stats(): HarnessStats {
      const buffer = drawingBuffer();
      return {
        ...planet.stats,
        altitude: camera.altitudeAbove(BODY_CENTRE, body.radius),
        frameMs: lastFrameMs,
        progress: flight.progress,
        peakBuildsPerFrame: overlay.peakBuildsPerFrame,
        budget,
        everExceededBudget: overlay.everExceededBudget,
        drawingBufferWidth: buffer.width,
        drawingBufferHeight: buffer.height,
        pixelRatio: renderer.getPixelRatio(),
      };
    },
    resetMetrics(): void {
      overlay.reset();
    },
  };

  window.__planet = harness;
}

boot().catch(fatal);
