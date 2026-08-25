/**
 * The explorer: one grey sphere at Earth's radius, and a camera that flies from
 * 1e9 m down to 1e3 m above it.
 *
 * Vanilla TypeScript, no framework. The whole app is a renderer, a planet, a
 * camera and a frame loop, and it exposes `window.__planet` so the acceptance
 * script can step it deterministically instead of racing a real-time loop.
 */

import { AmbientLight, DirectionalLight, Scene } from 'three/webgpu';
import {
  ALBEDO,
  ASTRONOMICAL_UNIT,
  SUN,
  Vec3d,
  rotateAbout,
  ev100FromLuminance,
  illuminanceAtDistance,
  parseSurfacePalette,
  referenceBody,
  subsolarLuminance,
  type Body,
} from '@planet/core';
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
import { applyPalette } from '@planet/field';
import { Flight } from './flight.ts';
import { Overlay } from './overlay.ts';

/** How much relief the `H` key dials in. Zero is the acceptance configuration. */
/**
 * How much relief the explorer's body has, metres.
 *
 * Earth runs about 20 km from the Mariana Trench to Everest. This is the
 * *nominal* amplitude, which the noise never fully reaches — the achieved relief
 * is about 45 % of it, so 20 km asked for gives roughly +/- 9 km, which is
 * Earth's range. See `TerrainParams.amplitude`.
 *
 * It is a real part of the body — the LOD scheduler, the tile bounds and the
 * skirts all know about it — and not a preview switched on afterwards, which is
 * what a display-only amplitude used to be and why LOD seams could crack.
 *
 * `?relief=0` builds the flat reference body instead. The acceptance run uses
 * that: criterion 3 asks for an exact shape, and 9 km of mountains is 0.14 %
 * of the radius standing between the measurement and the answer.
 */
const DEFAULT_RELIEF_METRES = 20_000;

const BODY_CENTRE = new Vec3d(0, 0, 0);

/** Where the body sits relative to its star. Earth's orbit, for now. */
const ORBIT_RADIUS = ASTRONOMICAL_UNIT;

/**
 * Starlight and zodiacal light on the night side, lux.
 *
 * Not a fill light chosen to make the picture readable — it is the real
 * illuminance of a moonless night sky, about seven orders of magnitude below
 * sunlight. It keeps the night side from being an absolute void without
 * pretending anything is lighting it that is not.
 */
const STARLIGHT_ILLUMINANCE = 0.002;

interface HarnessStats extends PlanetStats {
  altitude: number;
  /** Distance from the body's centre, metres. Not altitude plus one radius. */
  distanceFromCentre: number;
  frameMs: number;
  progress: number;
  peakBuildsPerFrame: number;
  budget: number;
  everExceededBudget: boolean;
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  pixelRatio: number;
  ev100: number;
  exposure: number;
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
  /** Move the camera's track to a latitude, radians. PI/2 is over the pole. */
  setLatitude(radians: number): void;
  setFlightRunning(running: boolean): void;
  /**
   * Put the body where it is at `seconds` past the epoch.
   *
   * The picture depends on the absolute time, not on how many frames have been
   * drawn, so the same second always gives the same planet.
   */
  setTime(seconds: number): void;
  /** How many simulated seconds pass per real second. 1 is real time. */
  setTimeScale(scale: number): void;
  setLodDebug(amount: number): void;
  /**
   * How much of the ground's own reflectance to show. 1 is the real surface,
   * 0 is one flat albedo over the whole body — which is what the acceptance
   * run measures geometry against.
   */
  setSurfaceMix(amount: number): void;
  /**
   * Swap the look, live.
   *
   * Takes the JSON form of a palette — see `paletten/README.md`. The palette
   * lives in uniforms, so this changes the next frame without recompiling a
   * shader. Throws with a list of everything wrong if the palette is not
   * usable, rather than rendering half of it.
   */
  setPalette(palette: unknown): void;
  /** What the surface currently is, for the overlay and for reports. */
  surfaceName(): string;
  setHeightScale(scale: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  /** Exposure value at ISO 100. Lower is brighter. */
  setEv100(ev100: number): void;
  meteredEv100(): number;
  /**
   * Point the sun somewhere else. The direction is where the light comes
   * *from*, in world axes; it gets normalised.
   *
   * Sun behind the camera gives a flat, fully lit disc. Sun off to the side
   * gives a terminator, which is where a planet renderer is actually judged.
   */
  setSunDirection(x: number, y: number, z: number): void;
  /**
   * Put the sun directly behind the camera, so the whole disc is lit.
   *
   * The least interesting picture a planet renderer can make, and exactly the
   * right one for measuring geometry: with a terminator in frame, "how many
   * pixels are lit" stops being "how big is the body", and the unlit half reads
   * as a hole between tiles. Every shape and crack measurement wants this;
   * every picture worth looking at does not.
   */
  setSunBehindCamera(): void;
  /**
   * Put the sun a given angle away from the camera's own line of sight.
   *
   * 0 is the sun directly behind the camera — a flat, fully lit disc. Past 60
   * the terminator is in frame, which is where a planet renderer is actually
   * judged; past 120 it is a crescent.
   *
   * Measured from where the camera *is*, not from an assumed position. A caller
   * that hard-codes "the camera sits on +X" gets a night-side picture the
   * moment the flight path changes, which is exactly what happened once.
   */
  setSunAtPhaseAngle(degrees: number, tiltDegrees?: number): void;
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
  // `?relief=<metres>` and `?surface=0|1`, so a caller can ask for the plain
  // reference body without the explorer needing a mode switch at runtime.
  const query = new URLSearchParams(window.location.search);
  const reliefParam = Number(query.get('relief'));
  const relief = Number.isFinite(reliefParam) && query.has('relief')
    ? Math.max(0, reliefParam)
    : DEFAULT_RELIEF_METRES;
  const paletteUrl = query.get('palette');
  const surfaceParam = Number(query.get('surface'));
  const initialSurfaceMix =
    Number.isFinite(surfaceParam) && query.has('surface') ? Math.min(1, Math.max(0, surfaceParam)) : 1;

  const reference = referenceBody();
  const body: Body =
    relief > 0
      ? Object.freeze({ ...reference, terrain: { ...reference.terrain, amplitude: relief } })
      : reference;

  const renderer = await createPlanetRenderer({
    canvas,
    antialias: true,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const depth = describeDepth(renderer);

  const scene = new Scene();

  // Real sunlight: the intensity is an illuminance in lux, so what lands in
  // the framebuffer is a luminance in cd/m^2. At 1 AU that is 128000 lx, and a
  // surface of Earth's mean albedo facing the sun comes out near 1.2e4 cd/m^2.
  const sunIlluminance = illuminanceAtDistance(SUN, ORBIT_RADIUS);
  const sun = new DirectionalLight(0xffffff, sunIlluminance);
  sun.position.set(0.6, 0.45, 0.65).normalize();
  scene.add(sun);
  scene.add(new AmbientLight(0xffffff, STARLIGHT_ILLUMINANCE));

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
    // No `albedo`: the ground decides its own reflectance, place by place.
    // Passing one would paint the whole body a single grey.
    material: {},
    lod: { errorThresholdPixels: errorThreshold, buildBudgetPerFrame: budget },
    onBuildError: (error, key) => {
      console.error('tile build failed', key, error);
    },
  });
  scene.add(planet.group);
  await planet.init();

  // `?palette=<url>` loads an authored look before the first frame. A bad one
  // is fatal on purpose: rendering half a palette and letting someone wonder
  // which half is worse than not starting.
  if (paletteUrl !== null) {
    const response = await fetch(paletteUrl);
    if (!response.ok) {
      throw new Error(`palette ${paletteUrl}: HTTP ${response.status}`);
    }
    const parsed = parseSurfacePalette(await response.json());
    if (!applyPalette(planet.materialHandle.surface, parsed)) {
      throw new Error(`surface "${planet.materialHandle.surface.name}" has no palette to swap`);
    }
  }

  // Expose for the sunlit surface, the way a photographer would meter it.
  // Nothing measures the frame yet — that is the next piece — so this is the
  // analytic prediction rather than a reading.
  const meteredEv100 = ev100FromLuminance(
    subsolarLuminance(SUN, ORBIT_RADIUS, ALBEDO.earthMean),
  );
  const post = createPostPipeline(renderer, scene, camera, { ev100: meteredEv100 });

  const flight = new Flight();
  const overlay = new Overlay(statsElement);

  // The body carries its relief for real, so the scale starts at 1 and this is
  // an exaggeration dial rather than an on switch.
  let heightScale = 1;
  let lodDebug = 0;
  let surfaceMix = initialSurfaceMix;
  let lastFrameMs = 0;
  let alongTrack = 0;
  let cameraPrecision: 'f64' | 'f32' = 'f64';
  let simSeconds = 0;
  // Real time by default. Earth turns 15 degrees an hour, so nothing visibly
  // moves at 1x — the `,` and `.` keys wind the clock forward faster.
  let timeScale = 1;
  const narrowing = new Float32Array(3);

  planet.materialHandle.setHeightScale(heightScale);
  planet.materialHandle.setSurfaceMix(surfaceMix);

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

    simSeconds += deltaSeconds * timeScale;
    planet.setTime(simSeconds);

    flight.advance(deltaSeconds);
    flight.applyTo(camera, BODY_CENTRE, body, planet.pose);
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
      altitude: camera.altitudeAbove(BODY_CENTRE, body, planet.pose),
      frameMs: lastFrameMs,
      pixelRatio: renderer.getPixelRatio(),
      drawingBufferHeight: buffer.height,
      flightRunning: flight.running,
      simSeconds,
      timeScale,
      spinAngle: planet.pose.spinAngle,
      heightScale,
      ev100: post.ev100,
      exposure: post.exposure,
      toneMapper: post.toneMapper,
      sunIlluminance,
      subsolarLuminance: subsolarLuminance(SUN, ORBIT_RADIUS, ALBEDO.earthMean),
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
      // Wind the clock. At 1x Earth turns 15 degrees an hour; at 3600x a day
      // takes 24 seconds, which is where the rotation becomes something you can
      // watch rather than something you have to take on trust.
      case ',':
        timeScale = Math.max(1, timeScale / 10);
        break;
      case '.':
        timeScale = Math.min(1e6, timeScale * 10);
        break;
      case ';':
        simSeconds = 0;
        timeScale = 1;
        planet.setTime(0);
        break;
      // One stop darker / brighter, the way an exposure compensation dial works.
      case '-':
        post.setEv100(post.ev100 + 1);
        break;
      case '+':
      case '=':
        post.setEv100(post.ev100 - 1);
        break;
      case '0':
        post.setEv100(meteredEv100);
        break;
      case 'l':
      case 'L':
        lodDebug = lodDebug > 0 ? 0 : 1;
        planet.materialHandle.setLodDebug(lodDebug);
        break;
      // The plain body, for comparison: one reflectance everywhere.
      case 'g':
      case 'G':
        surfaceMix = surfaceMix > 0 ? 0 : 1;
        planet.materialHandle.setSurfaceMix(surfaceMix);
        break;
      case 'h':
      case 'H':
        // Flat, true scale, or ten times over.
        heightScale = heightScale === 0 ? 1 : heightScale === 1 ? 10 : 0;
        planet.materialHandle.setHeightScale(heightScale);
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
    setLatitude(radians: number): void {
      const limit = Math.PI / 2 - 1e-3;
      flight.latitude = Math.min(limit, Math.max(-limit, radians));
    },
    setFlightRunning(running: boolean): void {
      flight.running = running;
    },
    setTime(seconds: number): void {
      simSeconds = seconds;
      planet.setTime(seconds);
    },
    setTimeScale(scale: number): void {
      timeScale = scale;
    },
    setLodDebug(amount: number): void {
      lodDebug = amount;
      planet.materialHandle.setLodDebug(amount);
    },
    setSurfaceMix(amount: number): void {
      surfaceMix = amount;
      planet.materialHandle.setSurfaceMix(amount);
    },
    setPalette(next: unknown): void {
      const parsed = parseSurfacePalette(next);
      if (!applyPalette(planet.materialHandle.surface, parsed)) {
        throw new Error(
          `surface "${planet.materialHandle.surface.name}" has no palette to swap`,
        );
      }
    },
    surfaceName(): string {
      return planet.materialHandle.surface.name;
    },
    setHeightScale(scale: number): void {
      // Multiplies the body's own relief. 1 is true scale; the portrait's
      // rotation series winds it up so that a smooth grey body has something
      // to show. It only moves the vertices, not the tile bounds or the
      // skirts, so anything much past a few times true scale will start to
      // open seams at LOD boundaries.
      heightScale = scale;
      planet.materialHandle.setHeightScale(scale);
    },
    setCameraPrecision(mode: 'f64' | 'f32'): void {
      cameraPrecision = mode;
    },
    setEv100(next: number): void {
      post.setEv100(next);
    },
    setSunDirection(x: number, y: number, z: number): void {
      sun.position.set(x, y, z).normalize();
    },
    setSunBehindCamera(): void {
      // three reads a directional light's `position` as the direction the light
      // comes *from*, so pointing it along the camera's outward radial lights
      // the face the camera is looking at.
      const outward = camera.position.clone().sub(BODY_CENTRE).normalize();
      if (!outward.isFinite() || outward.lengthSq() < 0.5) return;
      sun.position.set(outward.x, outward.y, outward.z);
    },
    setSunAtPhaseAngle(degrees: number, tiltDegrees = 12): void {
      const outward = camera.position.clone().sub(BODY_CENTRE).normalize();
      if (!outward.isFinite() || outward.lengthSq() < 0.5) return;

      // Two axes across the line of sight: one that swings the sun sideways
      // (giving a terminator that runs roughly pole to pole) and one that
      // raises it, so the light is not perfectly equatorial.
      const east = new Vec3d(0, 1, 0).cross(outward);
      if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
      east.normalize();
      const north = outward.clone().cross(east).normalize();

      let direction = rotateAbout(outward, north, (degrees * Math.PI) / 180);
      direction = rotateAbout(direction, east, (tiltDegrees * Math.PI) / 180);
      sun.position.set(direction.x, direction.y, direction.z);
    },
    meteredEv100(): number {
      return meteredEv100;
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
        altitude: camera.altitudeAbove(BODY_CENTRE, body, planet.pose),
        distanceFromCentre: camera.distanceFromCentre(BODY_CENTRE),
        frameMs: lastFrameMs,
        progress: flight.progress,
        peakBuildsPerFrame: overlay.peakBuildsPerFrame,
        budget,
        everExceededBudget: overlay.everExceededBudget,
        drawingBufferWidth: buffer.width,
        drawingBufferHeight: buffer.height,
        pixelRatio: renderer.getPixelRatio(),
        ev100: post.ev100,
        exposure: post.exposure,
      };
    },
    resetMetrics(): void {
      overlay.reset();
    },
  };

  window.__planet = harness;
}

boot().catch(fatal);
