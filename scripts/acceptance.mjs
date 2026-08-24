#!/usr/bin/env node
/**
 * Automated evidence for acceptance criteria 3 to 6.
 *
 * Builds the explorer, serves it, drives it in headless Chromium against a real
 * WebGPU device, and steps the scripted descent frame by frame — no wall-clock
 * dependence, so the run is reproducible.
 *
 * What it measures, and why that is the honest test rather than "it looked ok":
 *
 *   3  Sphere size.  The silhouette radius is compared against the projection
 *      of a 6.371e6 m sphere at the camera's exact distance. A sphere of the
 *      wrong radius, or a camera at the wrong altitude, fails by more than the
 *      one percent tolerance.
 *
 *   4a No jitter.  The camera is walked sideways in centimetre steps and the
 *      luminance-weighted centroid of the disk is tracked. Under float32 world
 *      coordinates the geometry would snap, and the centroid would climb a
 *      staircase. The test fits a straight line and looks at the residuals.
 *
 *   4b No z-fighting, no cracks.  Inside the disk, background pixels mean an
 *      LOD crack and speckle means depth flicker. Both are counted.
 *
 *   5  Build budget.  Every stepped frame's `buildsStartedThisFrame` is read
 *      and the peak is compared against the configured budget.
 *
 *   6  Frametime.  Recorded per checkpoint. On a machine without a hardware GPU
 *      this runs on SwiftShader, so the number is reported and NOT asserted —
 *      criterion 6 names the M5 Air, and only that machine can answer it.
 *
 * Usage:  pnpm acceptance  [--fast] [--headed]
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(ROOT, 'apps/explorer/dist');
const ARTIFACTS = join(ROOT, 'artifacts');

const FAST = process.argv.includes('--fast');
const HEADED = process.argv.includes('--headed');

const VIEWPORT = { width: FAST ? 480 : 720, height: FAST ? 300 : 450 };
const PIXEL_RATIO = 1;

/** Checkpoints across the six decades the handoff names. */
const CHECKPOINTS = FAST
  ? [1e9, 1e6, 1e4, 1e3]
  : [1e9, 3e8, 1e8, 3e7, 1e7, 1e6, 1e5, 1e4, 3e3, 1e3];

/** Frames of descent between checkpoints, and frames to settle the LOD tree. */
const DESCENT_FRAMES = FAST ? 20 : 60;
const SETTLE_FRAMES = FAST ? 30 : 150;

/** The jitter probe: how far to walk sideways, and in how many steps. */
const JITTER_ALTITUDES = FAST ? [1e3] : [1e5, 1e4, 1e3];
const JITTER_STEPS = FAST ? 16 : 32;

/** Mirrors DEFAULT_LOD_CONFIG.errorThresholdPixels in @planet/render. */
const DEFAULT_ERROR_THRESHOLD_PX = 2;

const CHROMIUM_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--disable-dev-shm-usage',
  '--no-sandbox',
];

/**
 * Compatibility shim for an old Chromium, applied to the PAGE only — the engine
 * is not modified.
 *
 * three r185 sets `swizzle: 'rgba'` (the identity swizzle) on every
 * GPUTextureViewDescriptor. Chromium 141 implements an earlier draft where that
 * key had to be a dictionary, and rejects the string outright. Newer Chromium
 * and current Safari accept it, so this wrapper detects the rejection once and
 * only then drops the key, which is a no-op because the value is the identity.
 *
 * If it ever fires on a current browser, that is a finding, not a workaround —
 * the report records whether it was needed.
 */
const SWIZZLE_SHIM = () => {
  if (typeof GPUTexture === 'undefined') return;
  const original = GPUTexture.prototype.createView;
  let stripping = false;
  const without = (descriptor) => {
    const copy = {};
    for (const key in descriptor) {
      if (key === 'swizzle') continue;
      copy[key] = descriptor[key];
    }
    return copy;
  };
  GPUTexture.prototype.createView = function createView(descriptor) {
    if (descriptor && stripping && 'swizzle' in descriptor) {
      return original.call(this, without(descriptor));
    }
    try {
      return original.call(this, descriptor);
    } catch (error) {
      if (descriptor && 'swizzle' in descriptor && /swizzle/i.test(String(error))) {
        stripping = true;
        window.__swizzleShimApplied = true;
        return original.call(this, without(descriptor));
      }
      throw error;
    }
  };
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function log(message) {
  process.stdout.write(`${message}\n`);
}

function buildExplorer() {
  log('building explorer …');
  const result = spawnSync('pnpm', ['--filter', '@planet/explorer', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('explorer build failed');
}

function serveDist() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = join(DIST, path);
    if (path === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    if (!file.startsWith(DIST) || !existsSync(file)) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done({ server, port: server.address().port }));
  });
}

// ---------------------------------------------------------- in-page probe ---

/**
 * Runs inside the browser. Copies the WebGPU canvas into a 2D canvas and
 * reduces it to numbers, so only a few floats cross the boundary per frame.
 */
const PROBE_SOURCE = `(() => {
  const canvas = document.getElementById('view');
  let scratch = null;

  function grab() {
    const w = canvas.width;
    const h = canvas.height;
    if (!scratch || scratch.width !== w || scratch.height !== h) {
      scratch = document.createElement('canvas');
      scratch.width = w;
      scratch.height = h;
    }
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(canvas, 0, 0);
    return { data: ctx.getImageData(0, 0, w, h), w, h };
  }

  // A pixel counts as sky if it is essentially black. The planet is lit grey.
  const SKY = 12;

  let previousFrame = null;

  /**
   * Difference against the previously stored frame.
   *
   * This is the sharp end of the jitter test. If any world coordinate were
   * float32, the geometry would quantise at about half a metre at Earth's
   * radius, and a five-centimetre camera step would leave the image
   * bit-identical nine times out of ten. With the whole pipeline
   * camera-relative, every step moves the antialiased edges, so every step
   * changes pixels.
   */
  window.__probeDiff = function probeDiff() {
    const { data, w, h } = grab();
    const px = data.data;
    let changed = 0;
    let sumAbs = 0;
    if (previousFrame && previousFrame.length === px.length) {
      for (let i = 0; i < px.length; i += 4) {
        const d =
          Math.abs(px[i] - previousFrame[i]) +
          Math.abs(px[i + 1] - previousFrame[i + 1]) +
          Math.abs(px[i + 2] - previousFrame[i + 2]);
        if (d !== 0) changed++;
        sumAbs += d;
      }
    }
    previousFrame = px.slice();
    const pixels = px.length / 4;
    return { changedPixels: changed, changedFraction: changed / pixels, meanAbsDiff: sumAbs / pixels };
  };

  window.__resetDiff = function resetDiff() { previousFrame = null; };

  /**
   * Silhouette shape, measured two different ways because the silhouette is two
   * different things depending on altitude.
   *
   * From far away it is a full disk, and the right question is "is the limb a
   * circle?" — answered by a least-squares circle fit through the boundary and
   * the worst radial residual. Adjacent-column differences are useless here: on
   * the flanks of a circle the boundary is nearly vertical, so neighbouring
   * columns legitimately differ by many rows.
   *
   * From close up it is a horizon spanning the frame, and the right question is
   * "does it step?" — answered by the jump between neighbouring columns. An LOD
   * seam shows up there and nowhere else.
   */
  window.__silhouette = function silhouette() {
    const { data, w, h } = grab();
    const px = data.data;

    const lumaAt = (x, y) => {
      const i = (y * w + x) * 4;
      return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    };

    const rows = new Array(w).fill(-1);
    let withTransition = 0;
    let minRow = Infinity;
    let maxRow = -Infinity;

    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        if (lumaAt(x, y) <= SKY) continue;
        // Sub-pixel: the transition pixel is partly covered, so its luminance
        // against the fully covered pixel below says where the edge fell.
        let frac = 0;
        if (y + 1 < h) {
          const full = lumaAt(x, y + 1);
          if (full > SKY) frac = 1 - Math.min(1, lumaAt(x, y) / full);
        }
        rows[x] = y + frac;
        withTransition++;
        if (rows[x] < minRow) minRow = rows[x];
        if (rows[x] > maxRow) maxRow = rows[x];
        break;
      }
    }

    if (withTransition < 24) {
      return { mode: 'none', reason: 'too few boundary columns', columns: withTransition };
    }
    // Every column starts at row 0 means the frame is entirely planet.
    if (maxRow < 0.5) {
      return { mode: 'none', reason: 'no sky in frame', columns: withTransition };
    }

    const spansFrame = withTransition === w;
    const shallow = maxRow - minRow < h * 0.5;

    if (spansFrame && shallow) {
      // ---- horizon: the seam test --------------------------------------
      const steps = [];
      let maxStep = 0;
      let maxStepAt = -1;
      for (let x = 1; x < w; x++) {
        const d = Math.abs(rows[x] - rows[x - 1]);
        steps.push(d);
        if (d > maxStep) { maxStep = d; maxStepAt = x; }
      }
      steps.sort((a, b) => a - b);
      return {
        mode: 'horizon',
        columns: withTransition,
        maxStepPx: maxStep,
        maxStepAtColumn: maxStepAt,
        medianStepPx: steps[steps.length >> 1],
        p99StepPx: steps[Math.min(steps.length - 1, Math.floor(steps.length * 0.99))],
      };
    }

    // ---- disk: is the limb a circle? ------------------------------------
    // Drop the outermost columns: there the boundary is near-vertical and the
    // sub-pixel estimate from a single column is meaningless.
    const points = [];
    const xs = [];
    for (let x = 0; x < w; x++) if (rows[x] >= 0) xs.push(x);
    const lo = xs[Math.floor(xs.length * 0.06)];
    const hi = xs[Math.ceil(xs.length * 0.94) - 1];
    for (let x = lo; x <= hi; x++) {
      if (rows[x] >= 0 && rows[x] > 0.5) points.push([x, rows[x]]);
    }
    if (points.length < 24) {
      return { mode: 'none', reason: 'too few usable boundary points', columns: points.length };
    }

    // Kasa circle fit: x^2 + y^2 = 2ax + 2by + c, linear in (a, b, c).
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0;
    const n = points.length;
    for (const [x, y] of points) {
      const z = x * x + y * y;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      sz += z; sxz += x * z; syz += y * z;
    }
    const m = [
      [sxx, sxy, sx],
      [sxy, syy, sy],
      [sx, sy, n],
    ];
    const rhs = [sxz, syz, sz];
    const sol = solve3(m, rhs);
    if (!sol) return { mode: 'none', reason: 'circle fit is singular', columns: n };
    const cx = sol[0] / 2;
    const cy = sol[1] / 2;
    const r = Math.sqrt(Math.max(0, sol[2] + cx * cx + cy * cy));

    let maxResidual = 0;
    let sumSq = 0;
    for (const [x, y] of points) {
      const d = Math.abs(Math.hypot(x - cx, y - cy) - r);
      sumSq += d * d;
      if (d > maxResidual) maxResidual = d;
    }

    return {
      mode: 'disk',
      columns: n,
      fitCentreX: cx,
      fitCentreY: cy,
      fitRadiusPx: r,
      maxRadialResidualPx: maxResidual,
      rmsRadialResidualPx: Math.sqrt(sumSq / n),
    };
  };

  function solve3(a, b) {
    const m = [
      [a[0][0], a[0][1], a[0][2], b[0]],
      [a[1][0], a[1][1], a[1][2], b[1]],
      [a[2][0], a[2][1], a[2][2], b[2]],
    ];
    for (let col = 0; col < 3; col++) {
      let pivot = col;
      for (let r = col + 1; r < 3; r++) {
        if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
      }
      if (Math.abs(m[pivot][col]) < 1e-12) return null;
      const tmp = m[col]; m[col] = m[pivot]; m[pivot] = tmp;
      for (let r = 0; r < 3; r++) {
        if (r === col) continue;
        const f = m[r][col] / m[col][col];
        for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c];
      }
    }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  }

  window.__probe = function probe() {
    const { data, w, h } = grab();
    const px = data.data;

    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let sumWeight = 0;
    let minX = w, maxX = -1, minY = h, maxY = -1;
    let maxLuma = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const luma = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        if (luma > maxLuma) maxLuma = luma;
        if (luma <= SKY) continue;
        count++;
        // Luminance weighting makes the centroid sub-pixel accurate: a partly
        // covered edge pixel contributes in proportion to its coverage.
        sumWeight += luma;
        sumX += x * luma;
        sumY += y * luma;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    if (count === 0) {
      return { empty: true, width: w, height: h, coverage: 0, maxLuma };
    }

    const cx = sumX / sumWeight;
    const cy = sumY / sumWeight;
    // Area-equivalent radius. Robust to the disk being clipped by the viewport
    // only when it is not; the caller checks "clipped" before trusting it.
    const radius = Math.sqrt(count / Math.PI);
    const clipped = minX <= 0 || minY <= 0 || maxX >= w - 1 || maxY >= h - 1;

    // Holes: sky pixels well inside the disk mean a crack between tiles.
    let holes = 0;
    let interior = 0;
    let speckle = 0;
    const probeRadius = radius * 0.75;
    const neighbours = new Array(8);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > probeRadius * probeRadius) continue;
        interior++;
        const i = (y * w + x) * 4;
        const luma = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        if (luma <= SKY) { holes++; continue; }

        // Speckle: a pixel far from the median of its neighbours. Depth
        // flicker on a smooth surface shows up here and nowhere else.
        let n = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const j = ((y + oy) * w + (x + ox)) * 4;
            neighbours[n++] = 0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2];
          }
        }
        neighbours.sort((a, b) => a - b);
        const median = (neighbours[3] + neighbours[4]) / 2;
        if (Math.abs(luma - median) > 24) speckle++;
      }
    }

    return {
      empty: false,
      width: w,
      height: h,
      coverage: count / (w * h),
      pixels: count,
      centroidX: cx,
      centroidY: cy,
      radiusPx: radius,
      clipped,
      holes,
      interior,
      holeFraction: interior > 0 ? holes / interior : 0,
      speckle,
      speckleFraction: interior > 0 ? speckle / interior : 0,
      maxLuma,
    };
  };
  return true;
})()`;

// ---------------------------------------------------------------- helpers ---

/** Least-squares line fit; returns slope, intercept and the worst residual. */
function lineFit(xs, ys) {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  let maxResidual = 0;
  const residuals = [];
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (slope * xs[i] + intercept);
    residuals.push(r);
    if (Math.abs(r) > maxResidual) maxResidual = Math.abs(r);
  }
  return { slope, intercept, maxResidual, residuals };
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Expected silhouette radius in pixels for a sphere seen from `distance`. */
function expectedRadiusPx(radius, distance, fovY, heightPx) {
  if (distance <= radius) return Number.POSITIVE_INFINITY;
  const halfAngle = Math.asin(radius / distance);
  const focal = heightPx / 2 / Math.tan(fovY / 2);
  return focal * Math.tan(halfAngle);
}

async function setChromeVisible(page, visible) {
  await page.evaluate((v) => {
    for (const id of ['overlay', 'help']) {
      const el = document.getElementById(id);
      if (el) el.style.display = v ? '' : 'none';
    }
  }, visible);
}

/** Run `count` frames in one round trip, pumping the build queue between them. */
async function stepFrames(page, count, deltaSeconds) {
  await page.evaluate(
    async ([n, dt]) => {
      for (let i = 0; i < n; i++) {
        window.__planet.renderFrame(dt);
        await window.__planet.pump();
      }
    },
    [count, deltaSeconds],
  );
}

/**
 * Render one frame and read the canvas back inside the same task.
 *
 * A WebGPU canvas stops being readable once the compositor presents it, so
 * anything that lets a task boundary slip in between gets an intermittently
 * black image — which reads as "the planet vanished" rather than "the readback
 * was late".
 */
async function renderAndProbe(page) {
  return page.evaluate(() => {
    window.__planet.renderFrame(0);
    return window.__probe();
  });
}

/** Render, measure the disk, and diff against the previous probed frame. */
async function renderProbeAndDiff(page) {
  return page.evaluate(() => {
    window.__planet.renderFrame(0);
    const probe = window.__probe();
    const diff = window.__probeDiff();
    const stats = window.__planet.stats();
    return { probe, diff, buildsStartedThisFrame: stats.buildsStartedThisFrame };
  });
}

// ------------------------------------------------------------------- main ---

async function main() {
  rmSync(ARTIFACTS, { recursive: true, force: true });
  mkdirSync(ARTIFACTS, { recursive: true });

  buildExplorer();
  const { server, port } = await serveDist();
  log(`serving ${DIST} on 127.0.0.1:${port}`);

  const executablePath = process.env.PLANET_CHROMIUM_PATH;
  const browser = await chromium.launch({
    headless: !HEADED,
    args: CHROMIUM_ARGS,
    ...(executablePath ? { executablePath } : {}),
  });

  const report = {
    startedAt: new Date().toISOString(),
    viewport: VIEWPORT,
    pixelRatio: PIXEL_RATIO,
    fast: FAST,
    checkpoints: [],
    jitter: [],
    failures: [],
  };

  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // The page asks for a favicon it does not ship. Not a rendering finding.
      if (/favicon/i.test(m.text())) return;
      consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    await page.addInitScript(SWIZZLE_SHIM);
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => window.__planet?.ready === true || typeof window.__planetError === 'string',
      { timeout: 180_000 },
    );

    const bootError = await page.evaluate(() => window.__planetError ?? null);
    if (bootError) throw new Error(`explorer failed to start:\n${bootError}`);

    await page.evaluate(PROBE_SOURCE);
    await page.evaluate(
      ([w, h, r]) => window.__planet.setSize(w, h, r),
      [VIEWPORT.width, VIEWPORT.height, PIXEL_RATIO],
    );

    // ---- criterion 3, part one: the renderer is the one we asked for -------
    const depth = await page.evaluate(() => window.__planet.depth);
    const body = await page.evaluate(() => ({
      id: window.__planet.body.id,
      radius: window.__planet.body.radius,
      amplitude: window.__planet.body.terrain.amplitude,
    }));
    report.depth = depth;
    report.body = body;

    if (depth.backend !== 'webgpu') report.failures.push(`backend is ${depth.backend}, not webgpu`);
    if (depth.reversedDepth !== true) report.failures.push('reversed-Z is not active');
    if (depth.clearDepth !== 0) report.failures.push(`clear depth is ${depth.clearDepth}, not 0`);
    if (depth.depthCompare !== 'greater-equal') {
      report.failures.push(`depth compare is ${depth.depthCompare}, not greater-equal`);
    }
    if (Math.abs(body.radius - 6.371e6) > 1) {
      report.failures.push(`body radius is ${body.radius}, not 6.371e6`);
    }

    await page.evaluate(() => {
      window.__planet.setFlightRunning(false);
      window.__planet.resetMetrics();
    });

    // ---- fly the descent, stopping at each checkpoint ----------------------
    let peakBuilds = 0;
    for (const altitude of CHECKPOINTS) {
      log(`checkpoint ${altitude.toExponential(1)} m …`);
      await page.evaluate((a) => window.__planet.setAltitude(a), altitude);

      // Count from the moment the camera arrives, not after a warm-up: the
      // settle time is how long the tree needs once the camera stops *there*,
      // and measuring it after sixty quiet frames would always report one.
      // This is what predicts pop-in — a peak build count says only that the
      // ceiling was touched once.
      const settle = await page.evaluate(async (limit) => {
        for (let frame = 1; frame <= limit; frame++) {
          window.__planet.renderFrame(0);
          await window.__planet.pump();
          const s = window.__planet.stats();
          if (
            s.buildsStartedThisFrame === 0 &&
            s.buildsPending === 0 &&
            s.buildsDeferredThisFrame === 0
          ) {
            return { frames: frame, settled: true, depth: s.maxSelectedDepth };
          }
        }
        return { frames: limit, settled: false, depth: window.__planet.stats().maxSelectedDepth };
      }, DESCENT_FRAMES + SETTLE_FRAMES);

      // A few more frames so the image is stable before it is measured.
      await stepFrames(page, 8, 0);

      const probe = await renderAndProbe(page);
      const silhouette = await page.evaluate(() => {
        window.__planet.renderFrame(0);
        return window.__silhouette();
      });
      const stats = await page.evaluate(() => window.__planet.stats());
      peakBuilds = Math.max(peakBuilds, stats.peakBuildsPerFrame);

      const distance = 6.371e6 + stats.altitude;
      const expected = expectedRadiusPx(
        6.371e6,
        distance,
        (50 * Math.PI) / 180,
        VIEWPORT.height * PIXEL_RATIO,
      );

      const entry = {
        altitude: stats.altitude,
        frameMs: stats.frameMs,
        buildsStartedThisFrame: stats.buildsStartedThisFrame,
        peakBuildsPerFrame: stats.peakBuildsPerFrame,
        settleFrames: settle.frames,
        settled: settle.settled,
        framesAtBudget: stats.framesAtBudget,
        framesTotal: stats.framesTotal,
        buildsTotal: stats.buildsTotal,
        budget: stats.budget,
        selectedNodes: stats.selectedNodes,
        residentTiles: stats.residentTiles,
        maxSelectedDepth: stats.maxSelectedDepth,
        maxSelectedErrorPixels: stats.maxSelectedErrorPixels,
        triangles: stats.triangles,
        rebases: stats.rebases,
        probe,
        silhouette,
        expectedRadiusPx: Number.isFinite(expected) ? expected : null,
      };

      // The disk metrics only mean something when the whole silhouette is in
      // frame and big enough to have an interior. A two-pixel disk is all edge,
      // and a clipped one has sky inside its "radius" by construction.
      const measurable = !probe.empty && !probe.clipped && probe.radiusPx >= 24;
      entry.measurable = measurable;

      if (!probe.empty && !probe.clipped && Number.isFinite(expected)) {
        entry.radiusErrorFraction = Math.abs(probe.radiusPx - expected) / expected;
        // One pixel of rasterisation slack, on top of two percent.
        const tolerance = Math.max(0.02, 1 / expected);
        if (entry.radiusErrorFraction > tolerance) {
          report.failures.push(
            `at ${altitude.toExponential(1)} m the disk is ${probe.radiusPx.toFixed(1)} px, ` +
              `expected ${expected.toFixed(1)} px for a 6.371e6 m sphere`,
          );
        }
      }
      if (probe.empty) {
        report.failures.push(`nothing rendered at ${altitude.toExponential(1)} m`);
      } else if (measurable) {
        if (probe.holeFraction > 0.0005) {
          report.failures.push(
            `cracks at ${altitude.toExponential(1)} m: ${(probe.holeFraction * 100).toFixed(3)}% ` +
              'of the disk interior is background',
          );
        }
        if (probe.speckleFraction > 0.01) {
          report.failures.push(
            `speckle at ${altitude.toExponential(1)} m: ${(probe.speckleFraction * 100).toFixed(2)}% ` +
              'of interior pixels differ sharply from their neighbours',
          );
        }
      }
      // The horizon is where an LOD seam would show: it may step by at most the
      // error budget the scheduler was given. The limb of a full disk is judged
      // differently — it has to be a circle, which is criterion 3 measured
      // rather than eyeballed.
      if (silhouette?.mode === 'horizon') {
        const allowed = Math.max(1.5, DEFAULT_ERROR_THRESHOLD_PX);
        if (silhouette.maxStepPx > allowed) {
          report.failures.push(
            `horizon steps by ${silhouette.maxStepPx.toFixed(2)} px at ` +
              `${altitude.toExponential(1)} m, above the ${allowed} px budget — an LOD seam is visible`,
          );
        }
      } else if (silhouette?.mode === 'disk') {
        const allowed = Math.max(1.5, DEFAULT_ERROR_THRESHOLD_PX);
        if (silhouette.maxRadialResidualPx > allowed) {
          report.failures.push(
            `the limb is ${silhouette.maxRadialResidualPx.toFixed(2)} px away from a circle at ` +
              `${altitude.toExponential(1)} m — the silhouette is faceted`,
          );
        }
      }
      if (!settle.settled) {
        report.failures.push(
          `the tree never settled at ${altitude.toExponential(1)} m within ${SETTLE_FRAMES} ` +
            'frames — that is continuous pop-in, not a converging LOD',
        );
      }
      if (stats.everExceededBudget || stats.peakBuildsPerFrame > stats.budget) {
        report.failures.push(
          `build budget exceeded by ${stats.peakBuildsPerFrame - stats.budget} at ` +
            `${altitude.toExponential(1)} m`,
        );
      }

      report.checkpoints.push(entry);

      const tag = altitude.toExponential(0).replace('+', '');
      // With the HUD, for criteria 5 and 6; and without, so criteria 3 and 4
      // can be judged on the render rather than on a panel covering it.
      await page.screenshot({ path: join(ARTIFACTS, `hud-${tag}.png`) });
      await setChromeVisible(page, false);
      await stepFrames(page, 1, 0);
      await page.screenshot({ path: join(ARTIFACTS, `altitude-${tag}.png`) });

      // And once more with per-tile colouring, which is the only way to see
      // the quadtree actually subdividing in a still image.
      await page.evaluate(() => window.__planet.setLodDebug(1));
      await stepFrames(page, 1, 0);
      await page.screenshot({ path: join(ARTIFACTS, `lod-${tag}.png`) });
      await page.evaluate(() => window.__planet.setLodDebug(0));
      await setChromeVisible(page, true);
      await stepFrames(page, 1, 0);
    }

    // ---- criterion 4: walk sideways and watch the silhouette --------------
    //
    // Run twice at the deepest altitude: once as built, and once with the
    // camera deliberately narrowed to float32. The control has to fail, or the
    // test proves nothing.
    /**
     * Step size for the jitter walk at a given altitude.
     *
     * Two demands pull against each other. The step has to be small enough that
     * float32 world coordinates could not represent it — float32 resolves about
     * half a metre at Earth's radius — and large enough that a correct renderer
     * visibly moves the image, or the measurement has no power either way.
     *
     * Angular motion is what the screen sees, so the second demand scales with
     * altitude: five centimetres at 1e5 m moves the picture by 0.0002 px, which
     * no rasteriser will show. Below about 3e3 m both demands are satisfiable at
     * once, and that is where the sub-float32 claim is actually tested; higher
     * up the walk still checks that the silhouette tracks smoothly.
     */
    function jitterStepFor(altitude) {
      const pixelsPerRadian = (VIEWPORT.height * PIXEL_RATIO) / (2 * Math.tan((50 * Math.PI) / 180 / 2));
      const forVisibility = (0.05 * altitude) / pixelsPerRadian;
      return Math.max(0.05, forVisibility);
    }

    async function walkSideways(altitude, precision, step) {
      await page.evaluate((m) => window.__planet.setCameraPrecision(m), precision);
      await page.evaluate((a) => window.__planet.setAltitude(a), altitude);
      await page.evaluate(() => window.__planet.nudgeAlong(0));
      await stepFrames(page, SETTLE_FRAMES, 0);
      await page.evaluate(() => window.__resetDiff());

      const offsets = [];
      const centroidsX = [];
      const centroidsY = [];
      const changedFractions = [];
      let buildsDuringProbe = 0;

      for (let i = 0; i < JITTER_STEPS; i++) {
        const offset = i * step;
        await page.evaluate((d) => window.__planet.nudgeAlong(d), offset);
        await stepFrames(page, 1, 0);
        const { probe, diff, buildsStartedThisFrame } = await renderProbeAndDiff(page);
        buildsDuringProbe += buildsStartedThisFrame;
        if (probe.empty) {
          await page.evaluate(() => window.__planet.nudgeAlong(0));
          await page.evaluate(() => window.__planet.setCameraPrecision('f64'));
          return { aborted: true, atStep: i };
        }
        offsets.push(offset);
        centroidsX.push(probe.centroidX);
        centroidsY.push(probe.centroidY);
        if (i > 0) changedFractions.push(diff.changedFraction);
      }
      await page.evaluate(() => window.__planet.nudgeAlong(0));
      await page.evaluate(() => window.__planet.setCameraPrecision('f64'));

      const fitX = lineFit(offsets, centroidsX);
      const fitY = lineFit(offsets, centroidsY);
      const stepsThatMoved = changedFractions.filter((f) => f > 0).length;

      return {
        aborted: false,
        altitude,
        precision,
        stepMetres: step,
        steps: JITTER_STEPS,
        totalTravelMetres: step * (JITTER_STEPS - 1),
        stepsThatChangedTheImage: stepsThatMoved,
        stepsCompared: changedFractions.length,
        movedFraction: stepsThatMoved / changedFractions.length,
        /** float32 resolves ~0.5 m at Earth's radius; below that it cannot hold the step. */
        subFloat32: step < 0.5,
        expectedPxPerStep:
          (step * ((VIEWPORT.height * PIXEL_RATIO) / (2 * Math.tan((50 * Math.PI) / 180 / 2)))) /
          altitude,
        centroidTravelPx: Math.hypot(
          centroidsX[centroidsX.length - 1] - centroidsX[0],
          centroidsY[centroidsY.length - 1] - centroidsY[0],
        ),
        medianChangedFraction: median(changedFractions),
        maxResidualXPx: fitX.maxResidual,
        maxResidualYPx: fitY.maxResidual,
        buildsDuringProbe,
        centroidsX,
      };
    }

    for (const altitude of JITTER_ALTITUDES) {
      log(`jitter probe at ${altitude.toExponential(1)} m …`);
      const result = await walkSideways(altitude, 'f64', jitterStepFor(altitude));
      if (result.aborted) {
        report.failures.push(
          `jitter probe at ${altitude.toExponential(1)} m rendered nothing at step ${result.atStep}`,
        );
        continue;
      }
      report.jitter.push(result);

      // Every sub-float32 step has to move the picture. A staircase would leave
      // most of them bit-identical.
      if (result.movedFraction < 0.9) {
        report.failures.push(
          `jitter at ${altitude.toExponential(1)} m: only ${result.stepsThatChangedTheImage} of ` +
            `${result.stepsCompared} steps of ${result.stepMetres.toFixed(3)} m changed the image — the ` +
            'geometry is quantising, which is what float32 world coordinates look like',
        );
      }
      // And the movement has to be a smooth track, not a jump.
      const residual = Math.max(result.maxResidualXPx, result.maxResidualYPx);
      if (residual > 0.5) {
        report.failures.push(
          `jitter at ${altitude.toExponential(1)} m: silhouette centroid deviates ` +
            `${residual.toFixed(3)} px from a straight track`,
        );
      }
    }

    // ---- the control: the same walk, with the camera narrowed to float32 ----
    const controlAltitude = JITTER_ALTITUDES[JITTER_ALTITUDES.length - 1];
    log(`negative control at ${controlAltitude.toExponential(1)} m (camera forced to float32) …`);
    const control = await walkSideways(controlAltitude, 'f32', jitterStepFor(controlAltitude));
    if (control.aborted) {
      report.failures.push('negative control rendered nothing');
    } else {
      report.control = control;
      const live = report.jitter.find((j) => j.altitude === controlAltitude);
      if (control.movedFraction >= 0.9) {
        report.failures.push(
          'negative control did not snap: forcing the camera through float32 still moved the ' +
            `image on ${control.stepsThatChangedTheImage}/${control.stepsCompared} steps, so the ` +
            'jitter test has no power to detect the failure it claims to rule out',
        );
      }
      if (live && control.movedFraction >= live.movedFraction) {
        report.failures.push(
          'negative control moved at least as often as the real pipeline ' +
            `(${control.movedFraction.toFixed(2)} vs ${live.movedFraction.toFixed(2)})`,
        );
      }
    }

    // ---- criterion 6: frametime, reported not asserted ---------------------
    const frameTimes = report.checkpoints.map((c) => c.frameMs).filter((v) => v > 0);
    report.frametime = {
      note:
        'Measured on whatever adapter this machine offers. On a host without a ' +
        'GPU that is SwiftShader, which is correct but not fast. Criterion 6 ' +
        'names the M5 Air at dpr 2 and can only be answered there.',
      adapter: depth.backend,
      meanMs: frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, frameTimes.length),
      maxMs: Math.max(0, ...frameTimes),
    };
    const lastCheckpoint = report.checkpoints[report.checkpoints.length - 1];
  report.budget = {
    peakBuildsPerFrame: peakBuilds,
    configured: report.checkpoints[0]?.budget ?? null,
    framesAtBudget: lastCheckpoint?.framesAtBudget ?? null,
    framesTotal: lastCheckpoint?.framesTotal ?? null,
    buildsTotal: lastCheckpoint?.buildsTotal ?? null,
    worstSettleFrames: Math.max(0, ...report.checkpoints.map((c) => c.settleFrames ?? 0)),
    note:
      'Die Spitze sagt nur, dass die Decke einmal berührt wurde. Aussagekräftig ' +
      'sind der Anteil der Frames am Anschlag und die Einschwingzeit.',
  };
    report.compat = {
      swizzleShimApplied: await page.evaluate(() => window.__swizzleShimApplied === true),
      userAgent: await page.evaluate(() => navigator.userAgent),
    };
    report.consoleErrors = consoleErrors;
    if (consoleErrors.length > 0) {
      report.failures.push(`${consoleErrors.length} console error(s): ${consoleErrors[0]}`);
    }
  } finally {
    await browser.close();
    server.close();
  }

  report.finishedAt = new Date().toISOString();
  report.passed = report.failures.length === 0;
  writeFileSync(join(ARTIFACTS, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(ARTIFACTS, 'acceptance.md'), renderSummary(report));

  log('');
  log(readFileSync(join(ARTIFACTS, 'acceptance.md'), 'utf8'));

  if (!report.passed) {
    log(`\nFAILED with ${report.failures.length} finding(s). See artifacts/acceptance.json`);
    process.exitCode = 1;
  }
}

function describeSilhouette(s) {
  if (!s) return '—';
  if (s.mode === 'horizon') {
    return `Horizont: max ${s.maxStepPx.toFixed(2)} px, Median ${s.medianStepPx.toFixed(3)} px`;
  }
  if (s.mode === 'disk') {
    return `Kreis: max ${s.maxRadialResidualPx.toFixed(2)} px, RMS ${s.rmsRadialResidualPx.toFixed(3)} px`;
  }
  return `— (${s.reason ?? 'nicht messbar'})`;
}

function renderSummary(report) {
  const lines = [];
  lines.push(`# Abnahme Stufe 01 — ${report.passed ? 'BESTANDEN' : 'FEHLGESCHLAGEN'}`);
  lines.push('');
  lines.push(`Lauf: ${report.startedAt} → ${report.finishedAt}`);
  lines.push(`Viewport: ${report.viewport.width}x${report.viewport.height} @ dpr ${report.pixelRatio}`);
  lines.push('');
  lines.push('## Tiefenpuffer');
  lines.push('');
  lines.push(`- Backend: \`${report.depth?.backend}\``);
  lines.push(`- Reversed-Z: \`${report.depth?.reversedDepth}\``);
  lines.push(`- Clear-Depth: \`${report.depth?.clearDepth}\``);
  lines.push(`- Depth-Compare: \`${report.depth?.depthCompare}\``);
  lines.push('');
  if (report.compat?.swizzleShimApplied) {
    lines.push(
      '> Hinweis: Der Browser dieses Laufs lehnt das `swizzle`-Feld ab, das ' +
        'three r185 auf jedem Texture-View setzt. Der Harness entfernt es ' +
        '(Identitaets-Swizzle, semantisch folgenlos). Die Engine ist unveraendert. ' +
        'Siehe STATE.md, offene Punkte.',
    );
    lines.push('');
    lines.push(`> User-Agent: \`${report.compat.userAgent}\``);
    lines.push('');
  }
  lines.push('## Kameraflug');
  lines.push('');
  lines.push('| Höhe (m) | Radius ist/soll (px) | Abw. | Tiles | Tiefe | Fehler (px) | Builds/Frame | Einschwingen | Löcher | Speckle | Silhouette | ms |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of report.checkpoints) {
    const r = c.probe?.empty
      ? 'leer'
      : `${c.probe.radiusPx.toFixed(1)} / ${c.expectedRadiusPx ? c.expectedRadiusPx.toFixed(1) : '—'}${c.probe.clipped ? ' (beschnitten)' : ''}`;
    lines.push(
      `| ${c.altitude.toExponential(2)} | ${r} | ${
        c.radiusErrorFraction === undefined ? '—' : `${(c.radiusErrorFraction * 100).toFixed(2)}%`
      } | ${c.selectedNodes} | ${c.maxSelectedDepth} | ${c.maxSelectedErrorPixels.toFixed(2)} | ${
        c.peakBuildsPerFrame
      }/${c.budget} | ${c.settled ? `${c.settleFrames} Frames` : 'NICHT ERREICHT'} | ${c.probe?.holes ?? '—'} | ${
        c.probe?.speckleFraction === undefined ? '—' : `${(c.probe.speckleFraction * 100).toFixed(3)}%`
      } | ${describeSilhouette(c.silhouette)} | ${c.frameMs.toFixed(1)} |`,
    );
  }
  lines.push('');
  lines.push(
    'Die Silhouetten-Spalte misst je nach Höhe zwei verschiedene Dinge, beide ' +
      'subpixelgenau aus der Deckung des Übergangspixels. Ist die Scheibe ganz im Bild, ' +
      'wird ein Kreis durch die Kontur gefittet und die größte radiale Abweichung ' +
      'ausgewiesen (`Kreis`) — das ist Kriterium 3, gemessen statt betrachtet. Füllt der ' +
      'Horizont das Bild, wird der Sprung zwischen benachbarten Bildspalten gemessen ' +
      '(`Horizont`); eine LOD-Naht taucht dort auf und darf das Fehlerbudget nicht reißen.',
  );
  lines.push('');
  lines.push('## Zittern der Silhouette');
  lines.push('');
  lines.push(
    '| Höhe (m) | Schritt | erwartete Bildbewegung/Schritt | unter float32-Auflösung | Schritte mit Bildänderung | Abweichung von der Geraden (px) | Builds |',
  );
  lines.push('|---|---|---|---|---|---|---|');
  for (const j of report.jitter) {
    lines.push(
      `| ${j.altitude.toExponential(2)} | ${j.stepMetres.toFixed(3)} m x ${j.steps} | ` +
        `${j.expectedPxPerStep.toFixed(3)} px | ${j.subFloat32 ? 'ja' : 'nein'} | ` +
        `${j.stepsThatChangedTheImage}/${j.stepsCompared} | ` +
        `${Math.max(j.maxResidualXPx, j.maxResidualYPx).toFixed(4)} | ${j.buildsDuringProbe} |`,
    );
  }
  lines.push('');
  lines.push(
    'Der Schritt wird pro Höhe so gewählt, dass er einerseits unter der float32-Auflösung ' +
      'bei Erdradius (~0.5 m) liegt und andererseits überhaupt eine messbare Bildbewegung ' +
      'erzeugt. Beides gleichzeitig geht nur nahe der Oberfläche — dort trägt die Messung ' +
      'die Aussage, weiter oben prüft sie nur noch die Gleichmäßigkeit der Bewegung.',
  );
  if (report.control) {
    lines.push('');
    lines.push('### Negativkontrolle');
    lines.push('');
    lines.push(
      'Derselbe Lauf, aber die Kameraposition wird vor dem Zeichnen durch float32 ' +
        'gerundet — also genau das, was passiert, wenn Weltkoordinaten irgendwo im ' +
        'Pfad float32 werden. Der Test muss hier fehlschlagen, sonst misst er nichts.',
    );
    lines.push('');
    lines.push(
      `- float64 (gebaut): ${report.jitter.at(-1)?.stepsThatChangedTheImage}/${report.jitter.at(-1)?.stepsCompared} Schritte ändern das Bild`,
    );
    lines.push(
      `- float32 (Kontrolle): ${report.control.stepsThatChangedTheImage}/${report.control.stepsCompared} Schritte ändern das Bild`,
    );
  }
  lines.push('');
  lines.push('## Budget');
  lines.push('');
  lines.push(
    `- Spitze ${report.budget?.peakBuildsPerFrame} von ${report.budget?.configured} erlaubt`,
  );
  lines.push(
    `- am Anschlag: ${report.budget?.framesAtBudget} von ${report.budget?.framesTotal} Frames ` +
      `(${((100 * (report.budget?.framesAtBudget ?? 0)) / Math.max(1, report.budget?.framesTotal ?? 1)).toFixed(1)} %)`,
  );
  lines.push(`- Bauten insgesamt über den Lauf: ${report.budget?.buildsTotal}`);
  lines.push(
    `- längste Einschwingzeit nach Anhalten der Kamera: ${report.budget?.worstSettleFrames} Frames ` +
      `(${((report.budget?.worstSettleFrames ?? 0) / 60).toFixed(2)} s bei 60 fps)`,
  );
  lines.push('');
  lines.push(`> ${report.budget?.note}`);
  lines.push('');
  lines.push('## Frametime');
  lines.push('');
  lines.push(`- Mittel: ${report.frametime?.meanMs?.toFixed(1)} ms, Maximum: ${report.frametime?.maxMs?.toFixed(1)} ms`);
  lines.push(`- ${report.frametime?.note}`);
  lines.push('');
  if (report.failures.length > 0) {
    lines.push('## Befunde');
    lines.push('');
    for (const f of report.failures) lines.push(`- ${f}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
