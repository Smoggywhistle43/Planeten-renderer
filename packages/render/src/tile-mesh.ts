/**
 * Tile vertex generation.
 *
 * This is precision rule 2 from the handoff, in code: a tile's vertices are
 * generated *relative to that tile's own origin*, in float64, and only the
 * small difference is narrowed to float32. Nothing here ever produces an
 * absolute world position for the GPU.
 *
 * A depth-20 tile is about ten metres across. Its vertex offsets are therefore
 * a few metres, where float32 resolves a micrometre. The same vertices
 * expressed absolutely would be 6.371e6 metres out, where float32 resolves half
 * a metre — the tile would visibly snap as the camera moved.
 *
 * No `three` in this file: it is plain typed arrays, so the geometry maths runs
 * and is tested in Node.
 */

import { Vec3d, type Body } from '@planet/core';
import {
  faceUvToDirection,
  nodeArcLength,
  nodeCenterDirection,
  nodeGeometricError,
  nodeUvBounds,
  type NodeKey,
} from './cube-sphere.ts';

export interface TileMeshOptions {
  /** Cells per tile edge. Vertex count is (n+1)^2 plus the skirt. */
  readonly gridResolution: number;
  /**
   * Skirt depth as a fraction of one cell's arc length. The skirt only has to
   * out-reach the height step across an LOD boundary, so this is generous.
   */
  readonly skirtFactor?: number;
}

export interface TileMeshData {
  readonly key: NodeKey;
  /** Tile origin, body-centred world coordinates, float64. Never uploaded raw. */
  readonly origin: Vec3d;
  /** Vertex minus origin, at the mean radius. float32, metres. */
  readonly positions: Float32Array;
  /** Unit direction per vertex. float32. Doubles as the undisplaced normal. */
  readonly directions: Float32Array;
  /**
   * Per-vertex `(depth, angularStep)`, constant across the tile. The depth
   * drives LOD debug colouring; the angular step tells the shader how far apart
   * to place the finite-difference taps when it derives a surface normal.
   */
  readonly tileInfo: Float32Array;
  /** Undisplaced normal per vertex — the same data as `directions`. float32. */
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  /** Largest |position|, metres. The tile's own bounding radius. */
  readonly localRadius: number;
  /** Angular spacing between neighbouring vertices, radians. */
  readonly angularStep: number;
  /** How far the skirt hangs below the surface, metres. */
  readonly skirtDepth: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
}

const DEFAULT_SKIRT_FACTOR = 0.05;

/**
 * Build one tile.
 *
 * The mesh is a `(n+1) x (n+1)` grid plus a skirt: a one-quad-deep wall hanging
 * inward from the border. Neighbouring tiles at different depths disagree about
 * where the surface is by at most the coarser tile's geometric error, and the
 * skirt is sized to swallow that, so LOD boundaries do not crack.
 */
export function buildTileMeshData(
  key: NodeKey,
  body: Body,
  options: TileMeshOptions,
): TileMeshData {
  const n = options.gridResolution;
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`buildTileMeshData: gridResolution must be a positive integer, got ${n}`);
  }

  const bounds = nodeUvBounds(key);
  const origin = nodeCenterDirection(key).scale(body.radius);

  const arc = nodeArcLength(key, body.radius);
  const cellArc = arc / n;
  const angularStep = cellArc / body.radius;

  const skirtFactor = options.skirtFactor ?? DEFAULT_SKIRT_FACTOR;
  const skirtDepth = Math.max(
    skirtFactor * cellArc,
    4 * nodeGeometricError(key, body, n),
  );

  const gridCount = (n + 1) * (n + 1);
  const perimeterCount = 4 * n;
  const vertexCount = gridCount + perimeterCount;

  const positions = new Float32Array(vertexCount * 3);
  const directions = new Float32Array(vertexCount * 3);
  const tileInfo = new Float32Array(vertexCount * 2);
  for (let i = 0; i < vertexCount; i++) {
    tileInfo[i * 2] = key.depth;
    tileInfo[i * 2 + 1] = angularStep;
  }

  const dir = new Vec3d();
  let localRadiusSq = 0;

  // ---- grid ---------------------------------------------------------------
  for (let j = 0; j <= n; j++) {
    const v = bounds.v0 + ((bounds.v1 - bounds.v0) * j) / n;
    for (let i = 0; i <= n; i++) {
      const u = bounds.u0 + ((bounds.u1 - bounds.u0) * i) / n;
      faceUvToDirection(key.face, u, v, dir);

      const idx = j * (n + 1) + i;
      // float64 throughout, narrowed once on assignment into the float32 view.
      const px = dir.x * body.radius - origin.x;
      const py = dir.y * body.radius - origin.y;
      const pz = dir.z * body.radius - origin.z;
      positions[idx * 3] = px;
      positions[idx * 3 + 1] = py;
      positions[idx * 3 + 2] = pz;
      directions[idx * 3] = dir.x;
      directions[idx * 3 + 1] = dir.y;
      directions[idx * 3 + 2] = dir.z;

      const rSq = px * px + py * py + pz * pz;
      if (rSq > localRadiusSq) localRadiusSq = rSq;
    }
  }

  // ---- skirt vertices -----------------------------------------------------
  const perimeter = perimeterIndices(n);
  for (let k = 0; k < perimeter.length; k++) {
    const src = perimeter[k] as number;
    const dst = gridCount + k;
    const dx = directions[src * 3] as number;
    const dy = directions[src * 3 + 1] as number;
    const dz = directions[src * 3 + 2] as number;
    positions[dst * 3] = (positions[src * 3] as number) - dx * skirtDepth;
    positions[dst * 3 + 1] = (positions[src * 3 + 1] as number) - dy * skirtDepth;
    positions[dst * 3 + 2] = (positions[src * 3 + 2] as number) - dz * skirtDepth;
    directions[dst * 3] = dx;
    directions[dst * 3 + 1] = dy;
    directions[dst * 3 + 2] = dz;
  }

  // ---- indices ------------------------------------------------------------
  const gridTris = n * n * 2;
  const skirtTris = perimeterCount * 2;
  const indices = new Uint32Array((gridTris + skirtTris) * 3);
  let w = 0;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + (n + 1);
      const d = c + 1;
      // Counter-clockwise in (u, v). `u x v` is the outward normal on every
      // face, so this is counter-clockwise seen from space — front-facing.
      indices[w++] = a;
      indices[w++] = b;
      indices[w++] = d;
      indices[w++] = a;
      indices[w++] = d;
      indices[w++] = c;
    }
  }

  for (let k = 0; k < perimeterCount; k++) {
    const p0 = perimeter[k] as number;
    const p1 = perimeter[(k + 1) % perimeterCount] as number;
    const s0 = gridCount + k;
    const s1 = gridCount + ((k + 1) % perimeterCount);
    indices[w++] = p0;
    indices[w++] = s0;
    indices[w++] = s1;
    indices[w++] = p0;
    indices[w++] = s1;
    indices[w++] = p1;
  }

  return {
    key,
    origin,
    positions,
    directions,
    normals: directions,
    tileInfo,
    indices,
    localRadius: Math.sqrt(localRadiusSq) + skirtDepth,
    angularStep,
    skirtDepth,
    vertexCount,
    triangleCount: gridTris + skirtTris,
  };
}

/**
 * Border vertices of an `(n+1) x (n+1)` grid, walked counter-clockwise in
 * `(u, v)`. Exactly `4n` entries — each corner appears once.
 */
export function perimeterIndices(n: number): Uint32Array {
  const out = new Uint32Array(4 * n);
  let w = 0;
  const at = (i: number, j: number): number => j * (n + 1) + i;

  for (let i = 0; i < n; i++) out[w++] = at(i, 0); // bottom, left to right
  for (let j = 0; j < n; j++) out[w++] = at(n, j); // right, bottom to top
  for (let i = n; i > 0; i--) out[w++] = at(i, n); // top, right to left
  for (let j = n; j > 0; j--) out[w++] = at(0, j); // left, top to bottom
  return out;
}
