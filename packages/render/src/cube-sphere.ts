/**
 * Cube-sphere addressing: a quadtree per cube face, and the mapping from a node
 * to directions on the unit sphere.
 *
 * Pure geometry — no `three`, no GPU. It runs in Node so the quadtree can be
 * tested without a device, and so a headless simulation can locate a surface
 * patch the same way the renderer does.
 *
 * The face parameterisation is tangent-warped: `tan(s * pi/4)` before
 * projection. Without it a face's corner cells cover about four times the solid
 * angle of its centre cells, which makes the LOD error estimate lie by the same
 * factor. With it, cells across a face are within a few percent of each other.
 */

import { Vec3d, type Body } from '@planet/core';

/** 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z */
export type FaceIndex = 0 | 1 | 2 | 3 | 4 | 5;

export const FACE_COUNT = 6;

export interface FaceBasis {
  readonly index: FaceIndex;
  readonly name: string;
  /** Outward normal of the cube face. */
  readonly normal: Vec3d;
  /** Axis the face's `u` coordinate runs along. */
  readonly u: Vec3d;
  /** Axis the face's `v` coordinate runs along. */
  readonly v: Vec3d;
}

function basis(index: FaceIndex, name: string, n: number[], u: number[], v: number[]): FaceBasis {
  return {
    index,
    name,
    normal: new Vec3d(n[0], n[1], n[2]),
    u: new Vec3d(u[0], u[1], u[2]),
    v: new Vec3d(v[0], v[1], v[2]),
  };
}

/**
 * The six faces. `u` and `v` are chosen so that every face is right-handed when
 * viewed from outside, which keeps triangle winding consistent without a
 * per-face flip.
 */
export const CUBE_FACES: readonly FaceBasis[] = Object.freeze([
  basis(0, '+X', [1, 0, 0], [0, 0, -1], [0, 1, 0]),
  basis(1, '-X', [-1, 0, 0], [0, 0, 1], [0, 1, 0]),
  basis(2, '+Y', [0, 1, 0], [0, 0, 1], [1, 0, 0]),
  basis(3, '-Y', [0, -1, 0], [0, 0, -1], [1, 0, 0]),
  basis(4, '+Z', [0, 0, 1], [1, 0, 0], [0, 1, 0]),
  basis(5, '-Z', [0, 0, -1], [-1, 0, 0], [0, 1, 0]),
]);

// ------------------------------------------------------------ node keys -----

/**
 * A quadtree node. `x` and `y` index the node within its depth level, so a node
 * at depth `d` covers `[x, x+1] / 2^d` of the face in each axis.
 */
export interface NodeKey {
  readonly face: FaceIndex;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
}

const NODE_ID_RE = /^f([0-5])d(\d+)x(\d+)y(\d+)$/;

/**
 * Stable string id for cache lookups and logs. `f2d5x13y7` reads as
 * "face 2, depth 5, cell (13, 7)".
 */
export function nodeId(key: NodeKey): string {
  return `f${key.face}d${key.depth}x${key.x}y${key.y}`;
}

/** Inverse of `nodeId`. Throws on anything it did not produce. */
export function parseNodeId(id: string): NodeKey {
  const m = NODE_ID_RE.exec(id);
  if (!m) throw new Error(`parseNodeId: not a node id: ${JSON.stringify(id)}`);
  const key: NodeKey = {
    face: Number(m[1]) as FaceIndex,
    depth: Number(m[2]),
    x: Number(m[3]),
    y: Number(m[4]),
  };
  assertValidKey(key);
  return key;
}

export function assertValidKey(key: NodeKey): void {
  const span = 2 ** key.depth;
  if (!Number.isInteger(key.depth) || key.depth < 0) {
    throw new RangeError(`node key: bad depth ${key.depth}`);
  }
  if (key.face < 0 || key.face > 5 || !Number.isInteger(key.face)) {
    throw new RangeError(`node key: bad face ${key.face}`);
  }
  if (!Number.isInteger(key.x) || key.x < 0 || key.x >= span) {
    throw new RangeError(`node key: x ${key.x} outside [0, ${span}) at depth ${key.depth}`);
  }
  if (!Number.isInteger(key.y) || key.y < 0 || key.y >= span) {
    throw new RangeError(`node key: y ${key.y} outside [0, ${span}) at depth ${key.depth}`);
  }
}

/** The six depth-0 nodes, one per face. */
export function rootKeys(): NodeKey[] {
  return CUBE_FACES.map((f) => ({ face: f.index, depth: 0, x: 0, y: 0 }));
}

/** Child `index` in 0..3, ordered (0,0) (1,0) (0,1) (1,1). */
export function childKey(key: NodeKey, index: number): NodeKey {
  if (index < 0 || index > 3 || !Number.isInteger(index)) {
    throw new RangeError(`childKey: index must be 0..3, got ${index}`);
  }
  return {
    face: key.face,
    depth: key.depth + 1,
    x: key.x * 2 + (index & 1),
    y: key.y * 2 + ((index >> 1) & 1),
  };
}

/** Null at depth 0. */
export function parentKey(key: NodeKey): NodeKey | null {
  if (key.depth === 0) return null;
  return { face: key.face, depth: key.depth - 1, x: key.x >> 1, y: key.y >> 1 };
}

export function keysEqual(a: NodeKey, b: NodeKey): boolean {
  return a.face === b.face && a.depth === b.depth && a.x === b.x && a.y === b.y;
}

// ------------------------------------------------------------- mapping ------

const QUARTER_PI = Math.PI / 4;

/** Tangent warp on [-1, 1]. Equalises angular spacing across a face. */
export function warp(s: number): number {
  return Math.tan(s * QUARTER_PI);
}

/** Inverse of `warp`. */
export function unwarp(t: number): number {
  return Math.atan(t) / QUARTER_PI;
}

/**
 * Face-local `(u, v)` in [0, 1] to a unit direction.
 *
 * This is *the* mapping. Tile geometry, node bounds, LOD error and the
 * direction attribute the shader samples the height field with all go through
 * it, so there is one definition of where a node sits on the sphere.
 */
export function faceUvToDirection(
  face: FaceIndex,
  u: number,
  v: number,
  out: Vec3d = new Vec3d(),
): Vec3d {
  const f = CUBE_FACES[face] as FaceBasis;
  const s = warp(u * 2 - 1);
  const t = warp(v * 2 - 1);
  out.set(
    f.normal.x + f.u.x * s + f.v.x * t,
    f.normal.y + f.u.y * s + f.v.y * t,
    f.normal.z + f.u.z * s + f.v.z * t,
  );
  return out.normalize();
}

export interface FaceUv {
  readonly face: FaceIndex;
  readonly u: number;
  readonly v: number;
}

/** Inverse of `faceUvToDirection`. The direction need not be normalised. */
export function directionToFaceUv(dir: Vec3d): FaceUv {
  const ax = Math.abs(dir.x);
  const ay = Math.abs(dir.y);
  const az = Math.abs(dir.z);

  let face: FaceIndex;
  let major: number;
  if (ax >= ay && ax >= az) {
    face = dir.x >= 0 ? 0 : 1;
    major = ax;
  } else if (ay >= az) {
    face = dir.y >= 0 ? 2 : 3;
    major = ay;
  } else {
    face = dir.z >= 0 ? 4 : 5;
    major = az;
  }
  if (major === 0) return { face: 0, u: 0.5, v: 0.5 };

  const f = CUBE_FACES[face] as FaceBasis;
  const s = (dir.x * f.u.x + dir.y * f.u.y + dir.z * f.u.z) / major;
  const t = (dir.x * f.v.x + dir.y * f.v.y + dir.z * f.v.z) / major;
  return { face, u: (unwarp(s) + 1) / 2, v: (unwarp(t) + 1) / 2 };
}

/** The `(u, v)` rectangle a node covers on its face. */
export function nodeUvBounds(key: NodeKey): { u0: number; v0: number; u1: number; v1: number } {
  const span = 1 / 2 ** key.depth;
  return { u0: key.x * span, v0: key.y * span, u1: (key.x + 1) * span, v1: (key.y + 1) * span };
}

/** Direction through the node's centre. */
export function nodeCenterDirection(key: NodeKey, out: Vec3d = new Vec3d()): Vec3d {
  const b = nodeUvBounds(key);
  return faceUvToDirection(key.face, (b.u0 + b.u1) / 2, (b.v0 + b.v1) / 2, out);
}

/** The four corner directions, in the same order as `childKey`. */
export function nodeCornerDirections(key: NodeKey): Vec3d[] {
  const b = nodeUvBounds(key);
  return [
    faceUvToDirection(key.face, b.u0, b.v0),
    faceUvToDirection(key.face, b.u1, b.v0),
    faceUvToDirection(key.face, b.u0, b.v1),
    faceUvToDirection(key.face, b.u1, b.v1),
  ];
}

/**
 * Great-circle length of the node's longer edge, in metres on a sphere of the
 * given radius. The basis for the LOD error estimate.
 */
export function nodeArcLength(key: NodeKey, radius: number): number {
  const b = nodeUvBounds(key);
  const c = nodeCornerDirections(key);
  void b;
  const e1 = angleBetween(c[0] as Vec3d, c[1] as Vec3d);
  const e2 = angleBetween(c[0] as Vec3d, c[2] as Vec3d);
  return Math.max(e1, e2) * radius;
}

function angleBetween(a: Vec3d, b: Vec3d): number {
  return Math.acos(Math.min(1, Math.max(-1, a.dot(b))));
}

export interface NodeBounds {
  readonly face: FaceIndex;
  /** Centre of the bounding sphere, in body-centred coordinates. */
  readonly center: Vec3d;
  /** Radius of the bounding sphere, metres. */
  readonly radius: number;
  /** The node's extent in warped face parameters, i.e. `warp(2u - 1)`. */
  readonly s0: number;
  readonly s1: number;
  readonly t0: number;
  readonly t1: number;
  /**
   * Nine points on the patch — centre, corners, edge midpoints — in
   * body-centred coordinates. A fallback for `distanceToPatch` when the camera
   * is on the far side of the face plane and the projection is undefined.
   */
  readonly samples: readonly Vec3d[];
}

/**
 * Bounding sphere of the node's surface patch, including the full terrain
 * amplitude. Used for culling and for the distance the screen-space error is
 * measured against.
 *
 * The patch is convex on the sphere, so the corners and edge midpoints bound
 * it; the extra 1% covers the mapping's mild bulge between those samples.
 */
export function nodeBounds(key: NodeKey, body: Body): NodeBounds {
  const b = nodeUvBounds(key);
  const um = (b.u0 + b.u1) / 2;
  const vm = (b.v0 + b.v1) / 2;

  const samples = [
    ...nodeCornerDirections(key),
    faceUvToDirection(key.face, um, b.v0),
    faceUvToDirection(key.face, um, b.v1),
    faceUvToDirection(key.face, b.u0, vm),
    faceUvToDirection(key.face, b.u1, vm),
  ];

  const center = nodeCenterDirection(key).scale(body.radius);
  const surface = samples.map((s) => s.scale(body.radius));
  let maxDist = 0;
  for (const s of surface) {
    const d = s.distanceTo(center);
    if (d > maxDist) maxDist = d;
  }
  return {
    face: key.face,
    center,
    radius: maxDist * 1.01 + body.terrain.amplitude,
    s0: warp(b.u0 * 2 - 1),
    s1: warp(b.u1 * 2 - 1),
    t0: warp(b.v0 * 2 - 1),
    t1: warp(b.v1 * 2 - 1),
    samples: [center, ...surface],
  };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Distance from a point to the node's surface patch, metres.
 *
 * The point is projected onto the node's own face and clamped into the node's
 * parameter rectangle, which gives the exact closest point whenever the camera
 * is above the patch — the case the LOD error actually depends on.
 *
 * Neither a bounding sphere nor a handful of samples is good enough here. A
 * depth-0 node's bounding sphere has a five-thousand-kilometre radius, so it
 * swallows the camera and the distance collapses to zero; its nine samples are
 * up to two thousand kilometres apart, so a camera ten kilometres above the
 * surface between two of them reads as being megametres away and the node never
 * splits. Both failures are silent: the picture is simply too coarse.
 *
 * `pointFromCentre` is the point relative to the body's centre, float64.
 */
export function distanceToPatch(
  bounds: NodeBounds,
  radius: number,
  pointFromCentre: Vec3d,
): number {
  let best = Number.POSITIVE_INFINITY;

  const f = CUBE_FACES[bounds.face] as FaceBasis;
  const n = pointFromCentre.dot(f.normal);
  if (n > 0) {
    const s = clamp(pointFromCentre.dot(f.u) / n, bounds.s0, bounds.s1);
    const t = clamp(pointFromCentre.dot(f.v) / n, bounds.t0, bounds.t1);
    const closest = new Vec3d(
      f.normal.x + f.u.x * s + f.v.x * t,
      f.normal.y + f.u.y * s + f.v.y * t,
      f.normal.z + f.u.z * s + f.v.z * t,
    )
      .normalize()
      .scale(radius);
    best = closest.distanceToSq(pointFromCentre);
  }

  // Behind the face plane the projection is undefined, so fall back to the
  // samples. Those nodes are on the far side and about to be culled anyway.
  for (const sample of bounds.samples) {
    const d = sample.distanceToSq(pointFromCentre);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// --------------------------------------------------------------- error ------

/**
 * How much relief the height field still holds at scales finer than one grid
 * cell.
 *
 * The fBm octaves whose wavelength is shorter than two cells cannot be
 * represented by the tile's vertices, so their summed amplitude is exactly the
 * error a finer tile would remove. Closed form, so this costs nothing to
 * evaluate per node per frame.
 *
 * Returns 0 for the stage-01 reference body, whose amplitude is 0.
 */
export function unresolvedRelief(body: Body, cellArc: number): number {
  const t = body.terrain;
  if (t.amplitude === 0 || cellArc <= 0) return 0;

  // Wavelength of octave k, in metres on the surface.
  const baseWavelength = (2 * Math.PI * body.radius) / t.frequency;
  const nyquist = 2 * cellArc;

  const sum = geometricSum(t.gain, t.octaves);
  if (sum === 0) return 0;

  let unresolved = 0;
  for (let k = 0; k < t.octaves; k++) {
    const wavelength = baseWavelength / t.lacunarity ** k;
    if (wavelength < nyquist) unresolved += t.gain ** k;
  }
  return (t.amplitude * unresolved) / sum;
}

function geometricSum(ratio: number, terms: number): number {
  if (ratio === 1) return terms;
  return (1 - ratio ** terms) / (1 - ratio);
}

/**
 * Geometric error of a node, in metres: how far its rendered surface can sit
 * from the true surface.
 *
 * Two contributions, both real:
 *   - the sagitta of the sphere across one grid cell, which is what makes a
 *     depth-0 tile a visibly faceted approximation up close;
 *   - the relief the grid is too coarse to sample.
 */
export function nodeGeometricError(key: NodeKey, body: Body, gridResolution: number): number {
  if (gridResolution <= 0) throw new RangeError('nodeGeometricError: gridResolution must be > 0');
  const cellArc = nodeArcLength(key, body.radius) / gridResolution;
  const sagitta = (cellArc * cellArc) / (8 * body.radius);
  return sagitta + unresolvedRelief(body, cellArc);
}
