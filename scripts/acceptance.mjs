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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  ARTIFACTS,
  CHROMIUM_ARGS,
  DIST,
  SWIZZLE_SHIM,
  buildExplorer,
  captureCanvas,
  findChromium,
  serveDist,
  setChromeVisible,
  stepFrames,
} from './lib/explorer-page.mjs';

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


/** Mirrors DEFAULT_LOD_CONFIG.errorThresholdPixels in @planet/render. */
const DEFAULT_ERROR_THRESHOLD_PX = 2;

function log(message) {
  process.stdout.write(`${message}\n`);
}

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
    // The lower edge as well as the upper one. The horizon test only ever wants
    // the top, but fitting an ellipse to the top arc alone is under-determined:
    // five unknowns, and half the outline missing. On a 29-pixel disc that read
    // the flattening as 0.051 instead of 0.0034 — the fit was free to lean the
    // conic any way it liked.
    const lowerRows = new Array(w).fill(-1);
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
      for (let y = h - 1; y >= 0; y--) {
        if (lumaAt(x, y) <= SKY) continue;
        let frac = 0;
        if (y - 1 >= 0) {
          const full = lumaAt(x, y - 1);
          if (full > SKY) frac = 1 - Math.min(1, lumaAt(x, y) / full);
        }
        lowerRows[x] = y - frac;
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
      // Only if the two edges are actually distinct: near the flanks the top
      // and bottom collapse onto the same pixel and would be counted twice.
      if (lowerRows[x] >= 0 && lowerRows[x] < h - 1.5 && lowerRows[x] - rows[x] > 1.5) {
        points.push([x, lowerRows[x]]);
      }
    }
    if (points.length < 24) {
      return { mode: 'none', reason: 'too few usable boundary points', columns: points.length };
    }

    // A rotating body is an ellipsoid, so its outline is an ellipse, not a
    // circle. A circle fit would report the flattening itself as error — on
    // Earth 0.34 % of the radius, which is larger than the tolerance this test
    // is trying to hold. So: fit the general conic
    //
    //     A x^2 + B xy + C y^2 + D x + E y = 1
    //
    // which is linear in its five unknowns. Points are centred and scaled
    // first, or the normal equations are hopeless at pixel coordinates in the
    // hundreds.
    const n = points.length;
    let mx = 0;
    let my = 0;
    for (const [x, y] of points) { mx += x; my += y; }
    mx /= n;
    my /= n;
    let scale = 0;
    for (const [x, y] of points) scale += (x - mx) ** 2 + (y - my) ** 2;
    scale = Math.sqrt(scale / n) || 1;

    const normal = [];
    for (let r = 0; r < 5; r++) normal.push([0, 0, 0, 0, 0, 0]);
    for (const [x, y] of points) {
      const u = (x - mx) / scale;
      const v = (y - my) / scale;
      const basis = [u * u, u * v, v * v, u, v];
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) normal[r][c] += basis[r] * basis[c];
        normal[r][5] += basis[r];
      }
    }
    const conic = solveN(normal, 5);
    if (!conic) return { mode: 'none', reason: 'ellipse fit is singular', columns: n };

    const [A, B, C, D, E] = conic;
    // Centre: where both partial derivatives vanish.
    const det = 4 * A * C - B * B;
    if (!(det > 0)) {
      return { mode: 'none', reason: 'fitted conic is not an ellipse', columns: n };
    }
    const ux = (B * E - 2 * C * D) / det;
    const uy = (B * D - 2 * A * E) / det;
    // Value of the quadratic part on the outline, once the centre is the
    // origin. Shifting the conic to its own centre kills the linear terms and
    // leaves q(w) = -Q(centre); at the centre the gradient vanishes, which
    // collapses that to 1 - (D cx + E cy) / 2.
    const k = 1 - (D * ux + E * uy) / 2;
    if (!(k > 0)) return { mode: 'none', reason: 'degenerate ellipse fit', columns: n };

    // Semi-axes from the eigenvalues of [[A, B/2], [B/2, C]] scaled by k.
    const trace = A + C;
    const gap = Math.sqrt(Math.max(0, (A - C) * (A - C) + B * B));
    const bigEigen = (trace + gap) / 2;
    const smallEigen = (trace - gap) / 2;
    if (!(smallEigen > 0)) return { mode: 'none', reason: 'degenerate ellipse fit', columns: n };
    const semiMinor = Math.sqrt(k / bigEigen) * scale;
    const semiMajor = Math.sqrt(k / smallEigen) * scale;
    const tiltRad = 0.5 * Math.atan2(B, A - C);

    // Residual: how far each boundary point sits from the fitted outline,
    // measured along the ray from the ellipse's centre. Same units and same
    // meaning as the circle version it replaces.
    let maxResidual = 0;
    let sumSq = 0;
    for (const [x, y] of points) {
      const wx = (x - mx) / scale - ux;
      const wy = (y - my) / scale - uy;
      const q = A * wx * wx + B * wx * wy + C * wy * wy;
      if (!(q > 0)) continue;
      const reach = Math.hypot(wx, wy);
      const d = Math.abs(reach * (1 - Math.sqrt(k / q))) * scale;
      sumSq += d * d;
      if (d > maxResidual) maxResidual = d;
    }

    return {
      mode: 'disk',
      columns: n,
      fitCentreX: ux * scale + mx,
      fitCentreY: uy * scale + my,
      semiMajorPx: semiMajor,
      semiMinorPx: semiMinor,
      // What the picture says the body's flattening is. Compare with the body's.
      fitFlattening: semiMajor > 0 ? (semiMajor - semiMinor) / semiMajor : 0,
      tiltDegrees: (tiltRad * 180) / Math.PI,
      // Kept under the old name so the report and its thresholds still read the
      // same field; it is now the distance to an ellipse rather than a circle.
      fitRadiusPx: semiMajor,
      maxRadialResidualPx: maxResidual,
      rmsRadialResidualPx: Math.sqrt(sumSq / n),
    };
  };

  /** Gauss-Jordan on an n by (n+1) augmented matrix. Null if singular. */
  function solveN(rows, n) {
    const m = rows.map((r) => r.slice());
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
      }
      if (Math.abs(m[pivot][col]) < 1e-12) return null;
      const tmp = m[col]; m[col] = m[pivot]; m[pivot] = tmp;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = m[r][col] / m[col][col];
        for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
      }
    }
    const out = [];
    for (let r = 0; r < n; r++) out.push(m[r][n] / m[r][r]);
    return out;
  }

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

/** Expected silhouette radius in pixels for a sphere seen from `distance`. */
function expectedRadiusPx(radius, distance, fovY, heightPx) {
  if (distance <= radius) return Number.POSITIVE_INFINITY;
  const halfAngle = Math.asin(radius / distance);
  const focal = heightPx / 2 / Math.tan(fovY / 2);
  return focal * Math.tan(halfAngle);
}

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

  buildExplorer(log);
  const { server, port } = await serveDist();
  log(`serving ${DIST} on 127.0.0.1:${port}`);

  const executablePath = findChromium();
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
    // The plain reference body: no relief, one reflectance everywhere.
    // Criterion 3 asks for an exact shape, and 9 km of mountains is 0.14 % of
    // the radius standing between the measurement and the answer; a coastline
    // is a large, legitimate jump between neighbouring pixels, which the
    // speckle test cannot tell from depth flicker. The interesting body lives
    // in `pnpm portrait`, where nothing is counted.
    await page.goto(`http://127.0.0.1:${port}/?relief=0&surface=0`, { waitUntil: 'load' });
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
    const body = await page.evaluate(() => {
      const b = window.__planet.body;
      const polar = b.equatorialRadius * (1 - b.flattening);
      return {
        id: b.id,
        equatorialRadius: b.equatorialRadius,
        polarRadius: polar,
        meanRadius: (2 * b.equatorialRadius + polar) / 3,
        flattening: b.flattening,
        rotationPeriod: b.rotationPeriod,
        axialTilt: b.axialTilt,
        amplitude: b.terrain.amplitude,
      };
    });
    report.depth = depth;
    report.body = body;

    if (depth.backend !== 'webgpu') report.failures.push(`backend is ${depth.backend}, not webgpu`);
    if (depth.reversedDepth !== true) report.failures.push('reversed-Z is not active');
    if (depth.clearDepth !== 0) report.failures.push(`clear depth is ${depth.clearDepth}, not 0`);
    if (depth.depthCompare !== 'greater-equal') {
      report.failures.push(`depth compare is ${depth.depthCompare}, not greater-equal`);
    }
    // The reference body is Earth-shaped: mean radius 6371.0 km, flattening
    // 1/298. It stopped being a sphere in Stufe 2.3, so the old "radius is
    // 6.371e6" check would now read an undefined field and quietly pass.
    if (!Number.isFinite(body.meanRadius) || Math.abs(body.meanRadius - 6.371e6) > 20) {
      report.failures.push(`mean radius is ${body.meanRadius}, not 6.371e6`);
    }
    if (Math.abs(1 / body.flattening - 298.257223563) > 0.001) {
      report.failures.push(`flattening is 1/${1 / body.flattening}, not 1/298.257`);
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
      // Light the whole disc. Every measurement below counts pixels, and a
      // terminator in frame would turn "how big is the body" into "how much of
      // it is in daylight" and the night side into a hole between tiles. The
      // interesting lighting lives in `pnpm portrait`, where nothing is
      // counted.
      await page.evaluate(() => {
        window.__planet.renderFrame(0);
        window.__planet.setSunBehindCamera();
      });

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

      const distance = stats.distanceFromCentre;
      // Against the equatorial radius: whatever direction an oblate body is
      // seen from, the widest its outline ever gets is the equatorial diameter.
      const expected = expectedRadiusPx(
        body.equatorialRadius,
        distance,
        (50 * Math.PI) / 180,
        VIEWPORT.height * PIXEL_RATIO,
      );
      // Area-equivalent radius of the full ellipse, for the coverage metric.
      const expectedArea = expectedRadiusPx(
        Math.sqrt(body.equatorialRadius * body.polarRadius),
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
        expectedAreaRadiusPx: Number.isFinite(expectedArea) ? expectedArea : null,
      };

      // The disk metrics only mean something when the whole silhouette is in
      // frame and big enough to have an interior. A two-pixel disk is all edge,
      // and a clipped one has sky inside its "radius" by construction.
      const measurable = !probe.empty && !probe.clipped && probe.radiusPx >= 24;
      entry.measurable = measurable;

      if (!probe.empty && !probe.clipped && Number.isFinite(expectedArea)) {
        entry.radiusErrorFraction = Math.abs(probe.radiusPx - expectedArea) / expectedArea;
        // One pixel of rasterisation slack, on top of two percent.
        const tolerance = Math.max(0.02, 1 / expectedArea);
        if (entry.radiusErrorFraction > tolerance) {
          report.failures.push(
            `at ${altitude.toExponential(1)} m the disk covers ${probe.radiusPx.toFixed(1)} px ` +
              `of area-equivalent radius, expected ${expectedArea.toFixed(1)} px`,
          );
        }
      }

      // Criterion 3 as a shape, not just a size: the outline of a body flattened
      // by 1/298 is an ellipse, and the fit says which one.
      if (silhouette?.mode === 'disk' && Number.isFinite(expected)) {
        entry.semiMajorErrorFraction = Math.abs(silhouette.semiMajorPx - expected) / expected;
        const tolerance = Math.max(0.02, 1 / expected);
        if (entry.semiMajorErrorFraction > tolerance) {
          report.failures.push(
            `at ${altitude.toExponential(1)} m the outline is ${silhouette.semiMajorPx.toFixed(1)} px ` +
              `across its long axis, expected ${expected.toFixed(1)} px for a ` +
              `${body.equatorialRadius.toFixed(0)} m equatorial radius`,
          );
        }
        // Seen edge-on the outline shows the full flattening; seen over a pole
        // it shows none. Anything outside that range is a shape error. One
        // pixel of slack, because at these sizes 1/298 is barely a pixel.
        const slack = 1.5 / Math.max(1, silhouette.semiMajorPx);
        if (silhouette.fitFlattening < -slack || silhouette.fitFlattening > body.flattening + slack) {
          report.failures.push(
            `at ${altitude.toExponential(1)} m the outline reads as flattened by ` +
              `${silhouette.fitFlattening.toFixed(5)}, outside 0..${body.flattening.toFixed(5)}`,
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
      // The overlay is DOM, so this one has to go through the page screenshot;
      // `captureCanvas` would return the canvas without it. The canvas
      // underneath may be a frame stale — the overlay text is the point here.
      await page.screenshot({ path: join(ARTIFACTS, `hud-${tag}.png`) });
      await setChromeVisible(page, false);
      await stepFrames(page, 1, 0);
      await captureCanvas(page, join(ARTIFACTS, `altitude-${tag}.png`));

      // And once more with per-tile colouring, which is the only way to see
      // the quadtree actually subdividing in a still image.
      await page.evaluate(() => window.__planet.setLodDebug(1));
      await stepFrames(page, 1, 0);
      await captureCanvas(page, join(ARTIFACTS, `lod-${tag}.png`));
      await page.evaluate(() => window.__planet.setLodDebug(0));
      await setChromeVisible(page, true);
      await stepFrames(page, 1, 0);
    }

    // ---- criterion 4: the jitter measurement lives in the test suite -------
    //
    // It used to run here, reading the canvas back. That meant measuring
    // sub-pixel motion through tone mapping and an 8-bit quantiser: a five
    // centimetre step changed three pixels out of four hundred thousand, and a
    // deliberately broken pipeline scored the same as the real one. Both were
    // on the instrument's noise floor rather than the renderer's.
    //
    // `packages/render/test/jitter.gpu.test.ts` does it against a float render
    // target instead, where a difference of 1e-6 registers, and it carries the
    // same float32 negative control. What stays here is the part a picture can
    // actually answer: the silhouette, cracks and speckle, above.
    report.jitterNote =
      'Gemessen in packages/render/test/jitter.gpu.test.ts gegen ein ' +
      'Float-Rendertarget statt gegen den 8-Bit-Canvas.';

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
    return (
      `Ellipse ${s.semiMajorPx.toFixed(1)}x${s.semiMinorPx.toFixed(1)} px, ` +
      `Abplattung ${s.fitFlattening.toFixed(4)}, ` +
      `max ${s.maxRadialResidualPx.toFixed(2)} px, RMS ${s.rmsRadialResidualPx.toFixed(3)} px`
    );
  }
  return `— (${s.reason ?? 'nicht messbar'})`;
}

function renderSummary(report) {
  const lines = [];
  lines.push(`# Abnahme Stufe 02 — ${report.passed ? 'BESTANDEN' : 'FEHLGESCHLAGEN'}`);
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
  if (report.body) {
    const b = report.body;
    lines.push('## Körper');
    lines.push('');
    lines.push(`- \`${b.id}\``);
    lines.push(
      `- Äquatorradius ${b.equatorialRadius.toFixed(0)} m, Polradius ${b.polarRadius.toFixed(0)} m, ` +
        `Mittel ${b.meanRadius.toFixed(1)} m`,
    );
    lines.push(
      `- Abplattung 1/${(1 / b.flattening).toFixed(3)} — ${(b.equatorialRadius - b.polarRadius).toFixed(0)} m Unterschied`,
    );
    lines.push(
      `- Rotationsdauer ${(Math.abs(b.rotationPeriod) / 3600).toFixed(4)} h${b.rotationPeriod < 0 ? ' (rückläufig)' : ''}, ` +
        `Achsneigung ${((b.axialTilt * 180) / Math.PI).toFixed(2)}°`,
    );
    lines.push(`- Reliefamplitude ${b.amplitude.toFixed(0)} m`);
    lines.push('');
  }
  lines.push('## Kameraflug');
  lines.push('');
  lines.push('| Höhe (m) | Radius ist/soll (px) | Abw. | Tiles | Tiefe | Fehler (px) | Builds/Frame | Einschwingen | Löcher | Speckle | Silhouette | ms |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of report.checkpoints) {
    const r = c.probe?.empty
      ? 'leer'
      : `${c.probe.radiusPx.toFixed(1)} / ${c.expectedAreaRadiusPx ? c.expectedAreaRadiusPx.toFixed(1) : '—'}${c.probe.clipped ? ' (beschnitten)' : ''}`;
    lines.push(
      `| ${c.altitude.toExponential(2)} | ${r} | ${
        c.radiusErrorFraction === undefined ? '—' : `${(c.radiusErrorFraction * 100).toFixed(2)}%`
      } | ${c.selectedNodes} | ${c.maxSelectedDepth} | ${c.maxSelectedErrorPixels.toFixed(2)} | ${
        c.peakBuildsPerFrame
      }/${c.budget} | ${c.settled ? `${c.settleFrames} Frames` : 'NICHT ERREICHT'} | ${
        c.measurable ? (c.probe?.holes ?? '—') : '—'
      } | ${
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
    'Wird nicht mehr hier gemessen. Ein 8-Bit-Canvas nach Tonemapping ist das ' +
      'falsche Messgerät für Bewegungen unterhalb eines Pixels — die Messung lag ' +
      'auf ihrer eigenen Rauschgrenze und konnte eine absichtlich kaputte Pipeline ' +
      'nicht mehr von der echten unterscheiden. Sie läuft jetzt in ' +
      '`packages/render/test/jitter.gpu.test.ts` gegen ein Float-Rendertarget, ' +
      'mit derselben float32-Negativkontrolle.',
  );
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
