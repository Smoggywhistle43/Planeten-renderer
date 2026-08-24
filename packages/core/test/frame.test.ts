import { describe, expect, it } from 'vitest';
import { Frame, float32PrecisionAt } from '../src/frame.ts';
import { Vec3d } from '../src/vec3d.ts';

describe('Frame', () => {
  it('starts at the origin and converts both ways', () => {
    const frame = new Frame();
    const world = new Vec3d(10, 20, 30);
    expect(frame.toFrame(world).toJSON()).toEqual([10, 20, 30]);
    expect(frame.toWorld(new Vec3d(1, 2, 3)).toJSON()).toEqual([1, 2, 3]);
  });

  it('rebases only past the threshold', () => {
    const frame = new Frame({ threshold: 1000 });
    expect(frame.update(new Vec3d(999, 0, 0))).toBe(false);
    expect(frame.rebaseCount).toBe(0);
    expect(frame.update(new Vec3d(1001, 0, 0))).toBe(true);
    expect(frame.rebaseCount).toBe(1);
    expect(frame.origin.toJSON()).toEqual([1001, 0, 0]);
  });

  it('bumps its version on every rebase so caches can invalidate', () => {
    const frame = new Frame({ threshold: 10 });
    const v0 = frame.version;
    frame.update(new Vec3d(100, 0, 0));
    frame.update(new Vec3d(200, 0, 0));
    expect(frame.version).toBe(v0 + 2);
  });

  it('keeps frame-space coordinates inside the threshold while tracking', () => {
    const frame = new Frame({ threshold: 4096 });
    const pos = new Vec3d();
    for (let i = 0; i < 20000; i++) {
      pos.set(1e9 + i * 137, 5e8 - i * 91, i * 13);
      frame.update(pos);
      expect(frame.toFrame(pos).length()).toBeLessThanOrEqual(4096);
    }
    expect(frame.rebaseCount).toBeGreaterThan(0);
  });

  it('rejects a non-positive threshold', () => {
    expect(() => new Frame({ threshold: 0 })).toThrow(RangeError);
    expect(() => new Frame({ threshold: -1 })).toThrow(RangeError);
  });

  describe('toCameraRelative32', () => {
    it('is the only float32 narrowing, and it happens after the subtraction', () => {
      // A tile origin one kilometre from a camera that is 6371 km from the
      // world origin. This is exactly the stage-01 low-altitude case.
      const camera = new Vec3d(6.371e6, 0, 0);
      const tile = new Vec3d(6.371e6 + 1000.25, 300.125, -50.0625);
      const frame = new Frame({ threshold: 4096 });
      frame.update(camera);

      const out = new Float32Array(3);
      frame.toCameraRelative32(tile, camera, out);

      expect(out[0]).toBeCloseTo(1000.25, 4);
      expect(out[1]).toBeCloseTo(300.125, 4);
      expect(out[2]).toBeCloseTo(-50.0625, 4);
    });

    it('beats uploading the absolute position by six orders of magnitude', () => {
      const camera = new Vec3d(6.371e6, 0, 0);
      const a = new Vec3d(6.371e6 + 1000, 0, 0);
      const b = new Vec3d(6.371e6 + 1000.01, 0, 0);

      // What the naive path does: narrow the absolute positions, then subtract.
      const absolute = new Float32Array([a.x, b.x]);
      expect(absolute[0]).toBe(absolute[1]); // 1 cm is gone at 6371 km in float32

      // What we do: subtract in float64, narrow the small result.
      const relA = new Float32Array(3);
      const relB = new Float32Array(3);
      const frame = new Frame();
      frame.toCameraRelative32(a, camera, relA);
      frame.toCameraRelative32(b, camera, relB);
      expect(relA[0]).not.toBe(relB[0]);
      expect(relB[0]! - relA[0]!).toBeCloseTo(0.01, 4);
    });

    it('puts the camera itself exactly at the origin', () => {
      const camera = new Vec3d(1.234e9, -8.7e8, 4.2e7);
      const out = new Float32Array(3);
      new Frame().toCameraRelative32(camera, camera, out);
      expect([...out]).toEqual([0, 0, 0]);
    });
  });
});

describe('float32PrecisionAt', () => {
  it('reports the ~0.5 m float32 resolution at Earth radius', () => {
    const p = float32PrecisionAt(6.371e6);
    expect(p).toBeGreaterThan(0.2);
    expect(p).toBeLessThan(1);
  });

  it('reports sub-millimetre resolution inside a rebase threshold', () => {
    expect(float32PrecisionAt(4096)).toBeLessThan(1e-3);
  });

  it('matches the actual float32 spacing', () => {
    for (const m of [1, 1024, 6.371e6, 1e9]) {
      const step = float32PrecisionAt(m);
      const arr = new Float32Array([m, m + step]);
      expect(arr[1]).not.toBe(arr[0]);
      const half = new Float32Array([m, m + step / 4]);
      expect(half[1]).toBe(half[0]);
    }
  });
});
