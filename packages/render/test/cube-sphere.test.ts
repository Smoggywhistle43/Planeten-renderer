import { describe, expect, it } from 'vitest';
import { Vec3d, referenceBody, makeBody } from '@planet/core';
import {
  CUBE_FACES,
  assertValidKey,
  childKey,
  directionToFaceUv,
  faceUvToDirection,
  keysEqual,
  nodeArcLength,
  nodeBounds,
  nodeCenterDirection,
  nodeCornerDirections,
  nodeGeometricError,
  nodeId,
  nodeUvBounds,
  distanceToPatch,
  parentKey,
  parseNodeId,
  rootKeys,
  unresolvedRelief,
  unwarp,
  warp,
  type FaceIndex,
  type NodeKey,
} from '../src/cube-sphere.ts';

const EARTH = referenceBody();

/** Deterministic spread of directions, no RNG. */
function sampleDirections(count: number): Vec3d[] {
  const out: Vec3d[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    out.push(new Vec3d(Math.cos(golden * i) * r, y, Math.sin(golden * i) * r));
  }
  return out;
}

describe('face basis', () => {
  it('has six faces whose u x v is the outward normal', () => {
    expect(CUBE_FACES).toHaveLength(6);
    for (const f of CUBE_FACES) {
      const cross = new Vec3d().crossVectors(f.u, f.v);
      expect(cross.distanceTo(f.normal)).toBeCloseTo(0, 12);
      expect(f.u.dot(f.v)).toBeCloseTo(0, 12);
      expect(f.u.length()).toBeCloseTo(1, 12);
      expect(f.v.length()).toBeCloseTo(1, 12);
    }
  });
});

describe('warp', () => {
  it('is an involution pair on [-1, 1] and fixes the ends', () => {
    for (let i = -20; i <= 20; i++) {
      const s = i / 20;
      expect(unwarp(warp(s))).toBeCloseTo(s, 12);
    }
    expect(warp(-1)).toBeCloseTo(-1, 12);
    expect(warp(0)).toBe(0);
    expect(warp(1)).toBeCloseTo(1, 12);
  });

  it('evens out cell sizes across a face', () => {
    // Compare the angular width of the centre cell with a corner cell at depth 3.
    const centre = nodeArcLength({ face: 4, depth: 3, x: 4, y: 4 }, 1);
    const corner = nodeArcLength({ face: 4, depth: 3, x: 0, y: 0 }, 1);
    expect(corner / centre).toBeGreaterThan(0.7);
    expect(corner / centre).toBeLessThan(1.4);
  });
});

describe('node keys', () => {
  it('round-trips through its string id', () => {
    const keys: NodeKey[] = [
      { face: 0, depth: 0, x: 0, y: 0 },
      { face: 5, depth: 12, x: 4095, y: 0 },
      { face: 3, depth: 7, x: 13, y: 99 },
    ];
    for (const key of keys) {
      expect(parseNodeId(nodeId(key))).toEqual(key);
    }
  });

  it('gives every node a distinct id', () => {
    const ids = new Set<string>();
    for (let face = 0 as FaceIndex; face < 6; face = (face + 1) as FaceIndex) {
      for (let depth = 0; depth <= 4; depth++) {
        const span = 2 ** depth;
        for (let x = 0; x < span; x++) for (let y = 0; y < span; y++) ids.add(nodeId({ face, depth, x, y }));
      }
    }
    expect(ids.size).toBe(6 * (1 + 4 + 16 + 64 + 256));
  });

  it('rejects malformed ids', () => {
    expect(() => parseNodeId('nope')).toThrow();
    expect(() => parseNodeId('f6d0x0y0')).toThrow();
    expect(() => parseNodeId('f0d1x2y0')).toThrow(RangeError);
  });

  it('validates ranges', () => {
    expect(() => assertValidKey({ face: 0, depth: 2, x: 4, y: 0 })).toThrow(RangeError);
    expect(() => assertValidKey({ face: 0, depth: -1, x: 0, y: 0 })).toThrow(RangeError);
    expect(() => assertValidKey({ face: 0, depth: 2, x: 3, y: 3 })).not.toThrow();
  });

  it('links parents and children both ways', () => {
    const root: NodeKey = { face: 2, depth: 3, x: 5, y: 6 };
    for (let i = 0; i < 4; i++) {
      const child = childKey(root, i);
      expect(child.depth).toBe(root.depth + 1);
      expect(parentKey(child)).toEqual(root);
      assertValidKey(child);
    }
    expect(parentKey({ face: 0, depth: 0, x: 0, y: 0 })).toBeNull();
    expect(() => childKey(root, 4)).toThrow(RangeError);
  });

  it('has four children that exactly tile their parent', () => {
    const parent: NodeKey = { face: 1, depth: 2, x: 1, y: 2 };
    const pb = nodeUvBounds(parent);
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const cb = nodeUvBounds(childKey(parent, i));
      expect(cb.u0).toBeGreaterThanOrEqual(pb.u0);
      expect(cb.u1).toBeLessThanOrEqual(pb.u1);
      expect(cb.v0).toBeGreaterThanOrEqual(pb.v0);
      expect(cb.v1).toBeLessThanOrEqual(pb.v1);
      area += (cb.u1 - cb.u0) * (cb.v1 - cb.v0);
    }
    expect(area).toBeCloseTo((pb.u1 - pb.u0) * (pb.v1 - pb.v0), 12);
  });

  it('starts from six roots', () => {
    const roots = rootKeys();
    expect(roots).toHaveLength(6);
    expect(roots.every((k) => k.depth === 0 && k.x === 0 && k.y === 0)).toBe(true);
    expect(keysEqual(roots[0] as NodeKey, roots[1] as NodeKey)).toBe(false);
  });
});

describe('direction mapping', () => {
  it('produces unit vectors everywhere on every face', () => {
    for (const f of CUBE_FACES) {
      for (let i = 0; i <= 8; i++) {
        for (let j = 0; j <= 8; j++) {
          const d = faceUvToDirection(f.index, i / 8, j / 8);
          expect(d.length()).toBeCloseTo(1, 12);
        }
      }
    }
  });

  it('round-trips any direction through its face coordinates', () => {
    for (const dir of sampleDirections(2000)) {
      const uv = directionToFaceUv(dir);
      expect(uv.u).toBeGreaterThanOrEqual(-1e-12);
      expect(uv.u).toBeLessThanOrEqual(1 + 1e-12);
      expect(uv.v).toBeGreaterThanOrEqual(-1e-12);
      expect(uv.v).toBeLessThanOrEqual(1 + 1e-12);
      const back = faceUvToDirection(uv.face, uv.u, uv.v);
      expect(back.distanceTo(dir)).toBeLessThan(1e-12);
    }
  });

  it('puts a face centre on that face at (0.5, 0.5)', () => {
    for (const f of CUBE_FACES) {
      const uv = directionToFaceUv(f.normal);
      expect(uv.face).toBe(f.index);
      expect(uv.u).toBeCloseTo(0.5, 12);
      expect(uv.v).toBeCloseTo(0.5, 12);
    }
  });

  it('survives a degenerate zero vector without producing NaN', () => {
    const uv = directionToFaceUv(new Vec3d(0, 0, 0));
    expect(Number.isFinite(uv.u)).toBe(true);
    expect(Number.isFinite(uv.v)).toBe(true);
  });

  it('covers the whole sphere: every sampled direction lands on some face', () => {
    const perFace = new Map<number, number>();
    for (const dir of sampleDirections(6000)) {
      const uv = directionToFaceUv(dir);
      perFace.set(uv.face, (perFace.get(uv.face) ?? 0) + 1);
    }
    expect(perFace.size).toBe(6);
    for (const count of perFace.values()) expect(count).toBeGreaterThan(500);
  });
});

describe('node geometry', () => {
  it('measures a depth-0 face edge corner to corner', () => {
    // The edge runs between two cube corners, which subtend acos(1/3), not the
    // pi/2 the edge would span if it were measured through the face centre.
    const arc = nodeArcLength({ face: 0, depth: 0, x: 0, y: 0 }, EARTH.radius);
    expect(arc).toBeCloseTo(Math.acos(1 / 3) * EARTH.radius, -3);
    expect(arc).toBeLessThan((Math.PI / 2) * EARTH.radius);
  });

  it('halves the arc with each depth level, exactly so once away from the corners', () => {
    let previous = nodeArcLength({ face: 4, depth: 0, x: 0, y: 0 }, EARTH.radius);
    for (let depth = 1; depth <= 12; depth++) {
      const key: NodeKey = { face: 4, depth, x: 2 ** (depth - 1), y: 2 ** (depth - 1) };
      const arc = nodeArcLength(key, EARTH.radius);
      const ratio = arc / previous;
      expect(ratio).toBeLessThan(1);
      // The first split still feels the corner-to-corner geometry; below that
      // the warp has done its job and the ratio settles on a half.
      if (depth === 1) expect(ratio).toBeLessThan(0.7);
      else expect(ratio).toBeCloseTo(0.5, 2);
      previous = arc;
    }
  });

  it('bounds every point of the patch', () => {
    const key: NodeKey = { face: 3, depth: 4, x: 5, y: 9 };
    const bounds = nodeBounds(key, EARTH);
    const b = nodeUvBounds(key);
    for (let i = 0; i <= 12; i++) {
      for (let j = 0; j <= 12; j++) {
        const u = b.u0 + ((b.u1 - b.u0) * i) / 12;
        const v = b.v0 + ((b.v1 - b.v0) * j) / 12;
        const p = faceUvToDirection(key.face, u, v).scale(EARTH.radius);
        expect(p.distanceTo(bounds.center)).toBeLessThanOrEqual(bounds.radius);
      }
    }
  });

  it('includes the terrain amplitude in the bounds', () => {
    const rough = makeBody(7, { overrides: { radius: EARTH.radius } });
    const key: NodeKey = { face: 0, depth: 6, x: 3, y: 4 };
    const flat = nodeBounds(key, EARTH).radius;
    const bumpy = nodeBounds(key, rough).radius;
    expect(bumpy - flat).toBeCloseTo(rough.terrain.amplitude, 3);
  });

  it('centres a node on its own patch', () => {
    const key: NodeKey = { face: 5, depth: 3, x: 2, y: 6 };
    const centre = nodeCenterDirection(key);
    const corners = nodeCornerDirections(key);
    const mean = new Vec3d();
    for (const c of corners) mean.add(c);
    mean.normalize();
    expect(mean.distanceTo(centre)).toBeLessThan(0.02);
  });
});

describe('geometric error', () => {
  it('falls by about four with every depth level', () => {
    let previous = nodeGeometricError({ face: 0, depth: 0, x: 0, y: 0 }, EARTH, 32);
    for (let depth = 1; depth <= 14; depth++) {
      const key: NodeKey = { face: 0, depth, x: 0, y: 0 };
      const error = nodeGeometricError(key, EARTH, 32);
      expect(error / previous).toBeGreaterThan(0.2);
      expect(error / previous).toBeLessThan(0.3);
      previous = error;
    }
  });

  it('shrinks as the grid gets finer', () => {
    const key: NodeKey = { face: 2, depth: 5, x: 4, y: 4 };
    expect(nodeGeometricError(key, EARTH, 64)).toBeLessThan(nodeGeometricError(key, EARTH, 16));
    expect(() => nodeGeometricError(key, EARTH, 0)).toThrow(RangeError);
  });

  it('is a pure sphere sagitta when the body has no relief', () => {
    const key: NodeKey = { face: 0, depth: 8, x: 100, y: 100 };
    const cell = nodeArcLength(key, EARTH.radius) / 32;
    expect(nodeGeometricError(key, EARTH, 32)).toBeCloseTo(
      (cell * cell) / (8 * EARTH.radius),
      12,
    );
  });

  it('reports no unresolved relief for a flat body, and some for a rough one', () => {
    expect(unresolvedRelief(EARTH, 1000)).toBe(0);
    const rough = makeBody(11, { bodyClass: 'rocky' });
    expect(unresolvedRelief(rough, 1e6)).toBeGreaterThan(0);
    // A cell far finer than the finest octave leaves nothing unresolved.
    expect(unresolvedRelief(rough, 1e-6)).toBe(0);
  });
});

describe('distanceToPatch', () => {
  /**
   * Regression guard. An earlier version measured the distance to nine sampled
   * points on the patch. A camera 10 km above a depth-0 face, but between two
   * samples, reported 1.7e6 m — so the node's screen error came out a hundred
   * times too small and the planet never tessellated at all. Nothing threw; the
   * picture was simply a cube-ish sphere from a kilometre up.
   */
  it('returns the altitude when the camera is above the patch, at every depth', () => {
    const key: NodeKey = { face: 0, depth: 0, x: 0, y: 0 };
    for (const altitude of [1e7, 1e5, 1e4, 1e3, 10]) {
      // A direction well inside face 0 but nowhere near its centre or corners.
      const dir = new Vec3d(
        Math.cos(0.34) * Math.cos(0.75),
        Math.sin(0.34),
        Math.cos(0.34) * Math.sin(0.75),
      ).normalize();
      const camera = dir.clone().scale(EARTH.radius + altitude);
      const bounds = nodeBounds(key, EARTH);
      expect(distanceToPatch(bounds, EARTH.radius, camera)).toBeCloseTo(altitude, 3);
    }
  });

  it('agrees with the sampled points when the camera is over one', () => {
    const key: NodeKey = { face: 4, depth: 3, x: 3, y: 5 };
    const bounds = nodeBounds(key, EARTH);
    const centre = nodeCenterDirection(key);
    const camera = centre.clone().scale(EARTH.radius + 500);
    expect(distanceToPatch(bounds, EARTH.radius, camera)).toBeCloseTo(500, 3);
  });

  it('grows once the camera leaves the patch', () => {
    const key: NodeKey = { face: 4, depth: 5, x: 16, y: 16 };
    const bounds = nodeBounds(key, EARTH);
    const centre = nodeCenterDirection(key);
    const over = distanceToPatch(bounds, EARTH.radius, centre.clone().scale(EARTH.radius + 1000));

    // Slide a quarter of a face away: the closest point is now an edge.
    const far = faceUvToDirection(4, 0.9, 0.9).scale(EARTH.radius + 1000);
    expect(distanceToPatch(bounds, EARTH.radius, far)).toBeGreaterThan(over * 10);
  });

  it('never exceeds the distance to the nearest sampled point', () => {
    const key: NodeKey = { face: 2, depth: 2, x: 1, y: 2 };
    const bounds = nodeBounds(key, EARTH);
    for (const dir of sampleDirections(400)) {
      const camera = dir.clone().scale(EARTH.radius + 2e4);
      let sampled = Number.POSITIVE_INFINITY;
      for (const s of bounds.samples) sampled = Math.min(sampled, s.distanceTo(camera));
      expect(distanceToPatch(bounds, EARTH.radius, camera)).toBeLessThanOrEqual(sampled + 1e-6);
    }
  });

  it('stays finite on the far side of the body', () => {
    const key: NodeKey = { face: 0, depth: 0, x: 0, y: 0 };
    const bounds = nodeBounds(key, EARTH);
    const behind = new Vec3d(-(EARTH.radius + 1000), 0, 0);
    const d = distanceToPatch(bounds, EARTH.radius, behind);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeGreaterThan(EARTH.radius);
  });

  it('carries the face and the warped parameter range', () => {
    const key: NodeKey = { face: 3, depth: 2, x: 1, y: 3 };
    const bounds = nodeBounds(key, EARTH);
    expect(bounds.face).toBe(3);
    const b = nodeUvBounds(key);
    expect(bounds.s0).toBeCloseTo(warp(b.u0 * 2 - 1), 12);
    expect(bounds.s1).toBeCloseTo(warp(b.u1 * 2 - 1), 12);
    expect(bounds.t0).toBeCloseTo(warp(b.v0 * 2 - 1), 12);
    expect(bounds.t1).toBeCloseTo(warp(b.v1 * 2 - 1), 12);
  });
});
