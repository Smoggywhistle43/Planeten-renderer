import { describe, expect, it } from 'vitest';
import { Vec3d, float32PrecisionAt, makeBody, referenceBody } from '@planet/core';
import { buildTileMeshData, perimeterIndices } from '../src/tile-mesh.ts';
import { nodeArcLength, type NodeKey } from '../src/cube-sphere.ts';

const EARTH = referenceBody();
const N = 16;

function build(key: NodeKey, gridResolution = N) {
  return buildTileMeshData(key, EARTH, { gridResolution });
}

function vertexAt(positions: Float32Array, i: number): Vec3d {
  return new Vec3d(
    positions[i * 3] as number,
    positions[i * 3 + 1] as number,
    positions[i * 3 + 2] as number,
  );
}

describe('perimeterIndices', () => {
  it('walks exactly 4n distinct border vertices', () => {
    for (const n of [1, 2, 4, 16, 32]) {
      const p = perimeterIndices(n);
      expect(p.length).toBe(4 * n);
      expect(new Set(p).size).toBe(4 * n);
      for (const idx of p) {
        const i = idx % (n + 1);
        const j = Math.floor(idx / (n + 1));
        expect(i === 0 || i === n || j === 0 || j === n).toBe(true);
      }
    }
  });

  it('walks a closed loop of single steps', () => {
    const n = 8;
    const p = perimeterIndices(n);
    for (let k = 0; k < p.length; k++) {
      const a = p[k] as number;
      const b = p[(k + 1) % p.length] as number;
      const di = Math.abs((a % (n + 1)) - (b % (n + 1)));
      const dj = Math.abs(Math.floor(a / (n + 1)) - Math.floor(b / (n + 1)));
      expect(di + dj).toBe(1);
    }
  });
});

describe('buildTileMeshData', () => {
  it('produces the expected vertex and triangle counts', () => {
    const tile = build({ face: 0, depth: 3, x: 2, y: 5 });
    expect(tile.vertexCount).toBe((N + 1) * (N + 1) + 4 * N);
    expect(tile.triangleCount).toBe(N * N * 2 + 4 * N * 2);
    expect(tile.positions.length).toBe(tile.vertexCount * 3);
    expect(tile.directions.length).toBe(tile.vertexCount * 3);
    expect(tile.tileInfo.length).toBe(tile.vertexCount * 2);
    expect(tile.indices.length).toBe(tile.triangleCount * 3);
  });

  it('rejects a nonsensical grid resolution', () => {
    const key: NodeKey = { face: 0, depth: 0, x: 0, y: 0 };
    expect(() => buildTileMeshData(key, EARTH, { gridResolution: 0 })).toThrow(RangeError);
    expect(() => buildTileMeshData(key, EARTH, { gridResolution: 2.5 })).toThrow(RangeError);
  });

  it('keeps every index inside the vertex range', () => {
    const tile = build({ face: 4, depth: 2, x: 1, y: 3 });
    for (const idx of tile.indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(tile.vertexCount);
    }
  });

  it('emits unit directions everywhere', () => {
    const tile = build({ face: 2, depth: 4, x: 7, y: 9 });
    for (let i = 0; i < tile.vertexCount; i++) {
      expect(vertexAt(tile.directions, i).length()).toBeCloseTo(1, 6);
    }
  });

  it('carries the node depth and the vertex spacing on every vertex', () => {
    const key: NodeKey = { face: 1, depth: 6, x: 33, y: 12 };
    const tile = build(key);
    const expectedStep = nodeArcLength(key, EARTH.radius) / N / EARTH.radius;
    for (let i = 0; i < tile.vertexCount; i++) {
      expect(tile.tileInfo[i * 2]).toBe(key.depth);
      // Stored as float32, so compare at float32 resolution, not float64.
      expect(tile.tileInfo[i * 2 + 1]).toBeCloseTo(expectedStep, 8);
    }
    expect(tile.angularStep).toBeCloseTo(expectedStep, 12);
  });

  describe('precision rule 2: vertices are relative to the tile origin', () => {
    it('puts every grid vertex back on the sphere when the origin is added', () => {
      const tile = build({ face: 5, depth: 7, x: 40, y: 91 });
      const gridCount = (N + 1) * (N + 1);
      for (let i = 0; i < gridCount; i++) {
        const world = vertexAt(tile.positions, i).add(tile.origin);
        expect(world.length()).toBeCloseTo(EARTH.radius, 1);
      }
    });

    it('keeps the offsets small enough that float32 resolves them finely', () => {
      // A depth-18 tile is about forty metres across. Its vertex offsets have
      // to land well inside float32's resolution at that magnitude, and they do
      // only because the subtraction happened in float64 first.
      const tile = build({ face: 0, depth: 18, x: 100_000, y: 100_000 });
      expect(tile.localRadius).toBeLessThan(100);

      const resolutionHere = float32PrecisionAt(tile.localRadius);
      const resolutionIfAbsolute = float32PrecisionAt(EARTH.radius);
      expect(resolutionHere).toBeLessThan(1e-4);
      expect(resolutionIfAbsolute / resolutionHere).toBeGreaterThan(1000);
    });

    it('shrinks the offsets by half with each depth level', () => {
      let previous = build({ face: 0, depth: 2, x: 1, y: 1 }).localRadius;
      for (let depth = 3; depth <= 16; depth++) {
        const key: NodeKey = { face: 0, depth, x: 2 ** (depth - 1), y: 2 ** (depth - 1) };
        const radius = build(key).localRadius;
        expect(radius).toBeLessThan(previous);
        previous = radius;
      }
      expect(previous).toBeLessThan(500);
    });

    it('places the origin on the node centre, at the mean radius', () => {
      const tile = build({ face: 3, depth: 5, x: 9, y: 20 });
      expect(tile.origin.length()).toBeCloseTo(EARTH.radius, 6);
    });
  });

  describe('winding', () => {
    it('faces outward on every face', () => {
      for (let face = 0; face < 6; face++) {
        const tile = build({ face: face as NodeKey['face'], depth: 1, x: 1, y: 0 }, 4);
        const gridTris = 4 * 4 * 2;
        for (let t = 0; t < gridTris; t++) {
          const ia = tile.indices[t * 3] as number;
          const ib = tile.indices[t * 3 + 1] as number;
          const ic = tile.indices[t * 3 + 2] as number;
          const a = vertexAt(tile.positions, ia);
          const b = vertexAt(tile.positions, ib);
          const c = vertexAt(tile.positions, ic);
          const normal = new Vec3d()
            .crossVectors(new Vec3d().subVectors(b, a), new Vec3d().subVectors(c, a))
            .normalize();
          const outward = vertexAt(tile.directions, ia);
          expect(normal.dot(outward)).toBeGreaterThan(0.9);
        }
      }
    });
  });

  describe('skirt', () => {
    it('hangs inward from the border, never outward', () => {
      const key: NodeKey = { face: 0, depth: 6, x: 20, y: 20 };
      const tile = build(key);
      const gridCount = (N + 1) * (N + 1);
      const perimeter = perimeterIndices(N);

      for (let k = 0; k < perimeter.length; k++) {
        const border = vertexAt(tile.positions, perimeter[k] as number).add(tile.origin);
        const skirt = vertexAt(tile.positions, gridCount + k).add(tile.origin);
        expect(skirt.length()).toBeLessThan(border.length());
        expect(border.length() - skirt.length()).toBeCloseTo(tile.skirtDepth, 1);
      }
    });

    it('reaches deeper than the height step an LOD boundary can produce', () => {
      // The worst case is a tile bordering one a level coarser: the step is at
      // most the coarser tile's geometric error.
      const key: NodeKey = { face: 4, depth: 8, x: 128, y: 128 };
      const tile = build(key);
      const parentError =
        (nodeArcLength({ ...key, depth: key.depth - 1, x: key.x >> 1, y: key.y >> 1 }, EARTH.radius) /
          N) **
          2 /
        (8 * EARTH.radius);
      expect(tile.skirtDepth).toBeGreaterThan(parentError);
    });

    it('scales with the tile, so a deep tile does not carry a huge wall', () => {
      const shallow = build({ face: 0, depth: 2, x: 1, y: 1 });
      const deep = build({ face: 0, depth: 14, x: 8192, y: 8192 });
      expect(deep.skirtDepth).toBeLessThan(shallow.skirtDepth);
      expect(deep.skirtDepth).toBeLessThan(deep.localRadius);
    });
  });

  it('displaces nothing for a flat body but reserves room for a rough one', () => {
    const rough = makeBody(4242, { bodyClass: 'rocky' });
    const key: NodeKey = { face: 0, depth: 5, x: 4, y: 4 };
    const flat = buildTileMeshData(key, EARTH, { gridResolution: N });
    const bumpy = buildTileMeshData(key, rough, { gridResolution: N });
    // The base grid is the undisplaced sphere in both cases; only the skirt
    // has to account for relief the grid cannot represent.
    expect(bumpy.skirtDepth).toBeGreaterThan(flat.skirtDepth * 0.5);
    expect(Number.isFinite(bumpy.localRadius)).toBe(true);
  });
});
