import { describe, expect, it } from 'vitest';
import { Vec3d, cross, dot, normalize, sub, tangentBasis } from '../src/vec3d.ts';

describe('Vec3d', () => {
  it('does the usual arithmetic', () => {
    const a = new Vec3d(1, 2, 3);
    const b = new Vec3d(4, 5, 6);
    expect(dot(a, b)).toBe(32);
    expect(cross(a, b).toJSON()).toEqual([-3, 6, -3]);
    expect(sub(b, a).toJSON()).toEqual([3, 3, 3]);
    expect(a.clone().addScaled(b, 2).toJSON()).toEqual([9, 12, 15]);
  });

  it('normalizes to unit length', () => {
    const n = normalize(new Vec3d(3, 4, 0));
    expect(n.length()).toBeCloseTo(1, 15);
    expect(n.x).toBeCloseTo(0.6, 15);
    expect(n.y).toBeCloseTo(0.8, 15);
    expect(n.z).toBe(0);
  });

  it('leaves a zero vector alone instead of producing NaN', () => {
    const z = new Vec3d(0, 0, 0).normalize();
    expect(z.isFinite()).toBe(true);
    expect(z.toJSON()).toEqual([0, 0, 0]);
  });

  it('resolves a millimetre at 1e9 m, which float32 cannot', () => {
    const world = new Vec3d(1e9, 1e9, 1e9);
    const nudged = world.clone().add(new Vec3d(0.001, 0, 0));

    // float64 spacing at 1e9 is ~2.4e-7 m, so a millimetre survives.
    expect(nudged.x).not.toBe(world.x);
    expect(Math.abs(nudged.x - world.x - 0.001)).toBeLessThan(1e-6);

    // float32 spacing at 1e9 is ~64 m. The nudge vanishes completely.
    const asFloat32 = new Float32Array([world.x, nudged.x]);
    expect(asFloat32[0]).toBe(asFloat32[1]);
  });

  it('measures distance without overflowing at planetary scale', () => {
    const a = new Vec3d(1e12, 0, 0);
    const b = new Vec3d(0, 1e12, 0);
    expect(a.distanceTo(b)).toBeCloseTo(Math.SQRT2 * 1e12, -3);
    expect(Number.isFinite(a.lengthSq())).toBe(true);
  });

  it('writes float32 without allocating', () => {
    const out = new Float32Array(6);
    new Vec3d(1, 2, 3).writeFloat32(out, 3);
    expect([...out]).toEqual([0, 0, 0, 1, 2, 3]);
  });

  it('builds an orthonormal tangent basis for any normal', () => {
    const normals = [
      new Vec3d(0, 0, 1),
      new Vec3d(0, 0, -1),
      new Vec3d(1, 0, 0),
      normalize(new Vec3d(1, 1, 1)),
      normalize(new Vec3d(-0.3, 0.9, -0.2)),
    ];
    for (const n of normals) {
      const { t, b } = tangentBasis(n);
      expect(t.length()).toBeCloseTo(1, 12);
      expect(b.length()).toBeCloseTo(1, 12);
      expect(dot(t, b)).toBeCloseTo(0, 12);
      expect(dot(t, n)).toBeCloseTo(0, 12);
      expect(dot(b, n)).toBeCloseTo(0, 12);
    }
  });
});
