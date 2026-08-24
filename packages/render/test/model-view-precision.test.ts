/**
 * Which arithmetic forms the model-view matrix, and what the alternative costs.
 *
 * three offers two paths and defaults to the cheaper one:
 *
 *   gpu-float32   `cameraViewMatrix.mul(modelWorldMatrix)` — the view and world
 *                 matrices are each narrowed to float32 and multiplied in the
 *                 shader. The error scales with whichever operand is larger.
 *   cpu-float64   the product is formed in JS, where `Matrix4.elements` is a
 *                 plain array and therefore float64, and narrowed once.
 *
 * The engine asks for the second (`renderer.highPrecision = true`). These tests
 * emulate both in float32 and put a number on the difference, so the choice is
 * not a matter of opinion the next time somebody reads the code.
 *
 * They also pin down *why* the default looks harmless here: this renderer keeps
 * the camera matrix a pure rotation and the object matrix already
 * camera-relative, so neither operand is ever large. That is an invariant of
 * the design, not of three — and it is exactly the kind of thing that stops
 * holding without anyone noticing.
 */

import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three/webgpu';

const f32 = (x: number): number => Math.fround(x);

/** Column-major 4x4 multiply, with every intermediate rounded by `round`. */
function multiply(a: number[], b: number[], round: (x: number) => number): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let acc = 0;
      for (let k = 0; k < 4; k++) {
        acc = round(acc + round((a[k * 4 + r] as number) * (b[c * 4 + k] as number)));
      }
      out[c * 4 + r] = acc;
    }
  }
  return out;
}

/** Transform a point by a column-major matrix, rounding every step. */
function transform(m: number[], p: number[], round: (x: number) => number): number[] {
  const out = [0, 0, 0];
  for (let r = 0; r < 3; r++) {
    let acc = 0;
    for (let k = 0; k < 3; k++) {
      acc = round(acc + round((m[k * 4 + r] as number) * (p[k] as number)));
    }
    out[r] = round(acc + (m[12 + r] as number));
  }
  return out;
}

const exact = (x: number): number => x;

/** A camera at the origin: the view matrix is the inverse of a pure rotation. */
function viewMatrixFor(yaw: number, pitch: number): number[] {
  const rotation = new Matrix4()
    .makeRotationY(yaw)
    .multiply(new Matrix4().makeRotationX(pitch));
  // The camera sits at the origin, so the world matrix is the rotation alone
  // and the view matrix is its inverse — which is what `PlanetCamera` produces.
  return [...rotation.invert().elements];
}

/** A tile: a pure translation by its camera-relative origin. */
function worldMatrixFor(distance: number): number[] {
  const dir = new Vector3(0.6898, 0.3335, 0.6426).normalize().multiplyScalar(distance);
  return [...new Matrix4().makeTranslation(dir.x, dir.y, dir.z).elements];
}

interface Comparison {
  reference: number[];
  cpuFloat64: number[];
  gpuFloat32: number[];
  cpuErrorMetres: number;
  gpuErrorMetres: number;
}

function compare(distance: number, vertex: number[], yaw = 0.7351, pitch = -0.4127): Comparison {
  const view = viewMatrixFor(yaw, pitch);
  const world = worldMatrixFor(distance);

  const reference = transform(multiply(view, world, exact), vertex, exact);

  // cpu-float64: product in float64, narrowed once, then applied in float32.
  const cpuMatrix = multiply(view, world, exact).map(f32);
  const cpuFloat64 = transform(cpuMatrix, vertex.map(f32), f32);

  // gpu-float32: each matrix narrowed, product formed in the shader.
  const gpuMatrix = multiply(view.map(f32), world.map(f32), f32);
  const gpuFloat32 = transform(gpuMatrix, vertex.map(f32), f32);

  const error = (a: number[]): number =>
    Math.hypot(
      (a[0] as number) - (reference[0] as number),
      (a[1] as number) - (reference[1] as number),
      (a[2] as number) - (reference[2] as number),
    );

  return {
    reference,
    cpuFloat64,
    gpuFloat32,
    cpuErrorMetres: error(cpuFloat64),
    gpuErrorMetres: error(gpuFloat32),
  };
}

const VERTEX = [4.317, -2.885, 6.041];

/** A spread of camera orientations: the gap between the paths depends on them. */
const ORIENTATIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.7351, -0.4127],
  [1.9, 0.3],
  [-2.6, -0.9],
  [4.1, 1.1],
];

function acrossOrientations(distance: number): Comparison[] {
  return ORIENTATIONS.map(([yaw, pitch]) => compare(distance, VERTEX, yaw, pitch));
}

describe('model-view precision', () => {
  it('forms the product in float64: Matrix4 stores plain numbers, not Float32Array', () => {
    const m = new Matrix4();
    expect(Array.isArray(m.elements)).toBe(true);
    m.elements[0] = 1 + 1e-15;
    // Only float64 can hold this; a Float32Array would round it back to 1.
    expect(m.elements[0]).not.toBe(1);
  });

  it('is indistinguishable from the shader-side product while both operands are small', () => {
    // The honest result, and the one worth writing down: with a rotation-only
    // view matrix and a camera-relative object matrix, the two paths agree to
    // within rounding noise. For some attitudes the CPU path is even a hair
    // worse. Anyone claiming the flag buys accuracy *here* is overselling it.
    for (const c of acrossOrientations(1e3)) {
      expect(c.cpuErrorMetres).toBeLessThan(1e-4);
      expect(c.gpuErrorMetres).toBeLessThan(1e-4);
      expect(Math.abs(c.cpuErrorMetres - c.gpuErrorMetres)).toBeLessThan(1e-4);
    }
  });

  it('pulls decisively ahead once an operand stops being small', () => {
    // This is the whole reason for the flag. Put the tile at an absolute world
    // position — 6371 km, what the object matrix would hold without the
    // camera-relative placement — and the shader-side product is worse at every
    // attitude, by a factor of roughly two to eight.
    const cases = acrossOrientations(6.371e6);
    const ratios = cases.map((c) => c.gpuErrorMetres / Math.max(c.cpuErrorMetres, 1e-30));
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    expect(mean).toBeGreaterThan(2);
    // Never worse; equal only for the degenerate identity attitude, where the
    // multiply has nothing to round.
    for (const c of cases) expect(c.cpuErrorMetres).toBeLessThanOrEqual(c.gpuErrorMetres);
  });

  it('keeps both paths sub-millimetre while the operands stay small', () => {
    // This is why the default looks harmless in this renderer: the camera
    // matrix is a rotation and the object matrix is camera-relative, so the
    // shader-side product never multiplies anything large. It is an invariant
    // of this design, not a guarantee three makes.
    for (const c of acrossOrientations(1e3)) {
      expect(c.gpuErrorMetres).toBeLessThan(1e-3);
    }
  });

  it('shows the shader-side product falling behind once an operand is not small', () => {
    // What the default would cost if a tile were ever placed at an absolute
    // world position instead of a camera-relative one — the failure this
    // engine's design prevents and the flag makes structurally impossible.
    const cases = acrossOrientations(6.371e6);
    const worst = Math.max(...cases.map((c) => c.gpuErrorMetres));
    const bestCpu = Math.max(...cases.map((c) => c.cpuErrorMetres));
    expect(worst).toBeGreaterThan(0.05);
    expect(worst).toBeGreaterThan(bestCpu);
  });

  it('agrees with the exact result to well under a pixel at 1 km', () => {
    // 1080 px over a 50 degree field is about 1240 px per radian.
    for (const c of acrossOrientations(1e3)) {
      expect((c.cpuErrorMetres / 1e3) * 1240).toBeLessThan(1e-3);
    }
  });
});
