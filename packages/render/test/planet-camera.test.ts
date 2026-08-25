import { describe, expect, it } from 'vitest';
import { BodyPose, Vec3d, referenceBody, surfaceRadius } from '@planet/core';
import { Vector3 } from 'three/webgpu';
import { PlanetCamera } from '../src/planet-camera.ts';

const EARTH = referenceBody();
/**
 * The reference body with its axis upright, so these tests are about the camera
 * rather than about Earth's tilt. `BodyPose` starts as the identity.
 */
const UPRIGHT = new BodyPose();

/** Distance from the centre to the surface at the equator. */
const EQUATOR = surfaceRadius(EARTH, new Vec3d(1, 0, 0));
const CENTRE = new Vec3d(0, 0, 0);

describe('PlanetCamera', () => {
  describe('precision rule 3: the camera never leaves the origin', () => {
    it('leaves the three camera at (0, 0, 0) wherever the world position is', () => {
      const camera = new PlanetCamera();
      for (const p of [
        new Vec3d(0, 0, 0),
        new Vec3d(EQUATOR + 1000, 0, 0),
        new Vec3d(1e9, -4e8, 7e8),
        new Vec3d(1e12, 1e12, 1e12),
      ]) {
        camera.position.copy(p);
        camera.update();
        expect(camera.three.position.toArray()).toEqual([0, 0, 0]);
        const t = new Vector3().setFromMatrixPosition(camera.three.matrixWorld);
        expect(t.toArray()).toEqual([0, 0, 0]);
      }
    });

    it('produces a view matrix that is a pure rotation', () => {
      const camera = new PlanetCamera();
      camera.position.set(1.234e9, -5.6e8, 3.3e8);
      camera.lookAt(CENTRE);
      camera.update();

      const e = camera.three.matrixWorldInverse.elements;
      // Translation column is zero, and the rotation block is orthonormal.
      // `=== 0` rather than `toBe(0)`: inverting a rotation can produce -0.
      expect(e[12] === 0).toBe(true);
      expect(e[13] === 0).toBe(true);
      expect(e[14] === 0).toBe(true);
      const col0 = new Vector3(e[0], e[1], e[2]);
      const col1 = new Vector3(e[4], e[5], e[6]);
      expect(col0.length()).toBeCloseTo(1, 12);
      expect(col1.length()).toBeCloseTo(1, 12);
      expect(col0.dot(col1)).toBeCloseTo(0, 12);
    });

    it('keeps the world position in float64, resolving a millimetre at 1e9 m', () => {
      const camera = new PlanetCamera();
      camera.position.set(1e9, 0, 0);
      const before = camera.position.x;
      camera.position.x += 0.001;
      camera.update();
      expect(camera.position.x).not.toBe(before);
      expect(camera.position.x - before).toBeCloseTo(0.001, 6);
    });
  });

  describe('camera-relative conversion', () => {
    it('maps the camera itself to exactly zero', () => {
      const camera = new PlanetCamera();
      camera.position.set(6.371e6 + 1000, 2000, -3000);
      const out = camera.cameraRelative(camera.position.clone());
      expect(out.toArray()).toEqual([0, 0, 0]);
    });

    it('resolves a centimetre next to a tile 6371 km from the world origin', () => {
      const camera = new PlanetCamera();
      camera.position.set(6.371e6, 0, 0);
      const a = camera.cameraRelative(new Vec3d(6.371e6 + 100, 0, 0), new Vector3());
      const b = camera.cameraRelative(new Vec3d(6.371e6 + 100.01, 0, 0), new Vector3());
      expect(b.x).not.toBe(a.x);
      expect(b.x - a.x).toBeCloseTo(0.01, 4);
    });
  });

  describe('orientation', () => {
    it('looks at a target', () => {
      const camera = new PlanetCamera();
      camera.position.set(1e7, 0, 0);
      camera.lookAt(CENTRE);
      const forward = camera.forward();
      expect(forward.x).toBeCloseTo(-1, 9);
      expect(forward.length()).toBeCloseTo(1, 12);
    });

    it('keeps an orthonormal basis in every orientation', () => {
      const camera = new PlanetCamera();
      for (let i = 0; i < 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        camera.position.set(Math.cos(a) * 1e7, Math.sin(a * 0.7) * 1e7, Math.sin(a) * 1e7);
        camera.lookAt(CENTRE);
        const f = camera.forward();
        const u = camera.up();
        const r = camera.right();
        expect(f.length()).toBeCloseTo(1, 9);
        expect(u.length()).toBeCloseTo(1, 9);
        expect(r.length()).toBeCloseTo(1, 9);
        expect(Math.abs(f.dot(u))).toBeLessThan(1e-9);
        expect(Math.abs(f.dot(r))).toBeLessThan(1e-9);
        expect(Math.abs(u.dot(r))).toBeLessThan(1e-9);
      }
    });

    it('survives an up hint parallel to the view direction', () => {
      const camera = new PlanetCamera();
      camera.position.set(0, 1e7, 0);
      camera.lookAt(CENTRE, new Vec3d(0, 1, 0));
      const f = camera.forward();
      expect(f.isFinite()).toBe(true);
      expect(f.y).toBeCloseTo(-1, 9);
    });

    it('does nothing when asked to look at its own position', () => {
      const camera = new PlanetCamera();
      camera.position.set(5, 5, 5);
      const before = camera.orientation.clone();
      camera.lookAt(camera.position.clone());
      expect(camera.orientation.equals(before)).toBe(true);
    });
  });

  describe('altitude and placement', () => {
    it('lands on the requested altitude exactly', () => {
      const camera = new PlanetCamera();
      for (const altitude of [1e9, 1e6, 1e3, 1, 0]) {
        camera.placeAtAltitude(CENTRE, new Vec3d(1, 0, 0), altitude, EARTH, UPRIGHT);
        expect(camera.altitudeAbove(CENTRE, EARTH, UPRIGHT)).toBeCloseTo(altitude, 6);
        expect(camera.forward().x).toBeCloseTo(-1, 9);
      }
    });

    it('normalises whatever direction it is handed', () => {
      const camera = new PlanetCamera();
      const direction = new Vec3d(3, 4, 0);
      camera.placeAtAltitude(CENTRE, direction, 1000, EARTH, UPRIGHT);
      const expected = surfaceRadius(EARTH, direction.clone().normalize()) + 1000;
      expect(camera.distanceFromCentre(CENTRE)).toBeCloseTo(expected, 6);
    });
  });

  describe('projection', () => {
    it('tracks the viewport aspect', () => {
      const camera = new PlanetCamera();
      camera.setViewport(1600, 900);
      expect(camera.aspect).toBeCloseTo(16 / 9, 12);
      camera.setViewport(0, 0);
      expect(Number.isFinite(camera.aspect)).toBe(true);
    });

    it('defaults to a near plane small enough for surface work', () => {
      const camera = new PlanetCamera();
      expect(camera.near).toBeLessThanOrEqual(0.1);
      expect(camera.far).toBeGreaterThanOrEqual(1e10);
    });

    it('converts field of view to pixels per radian', () => {
      const camera = new PlanetCamera({ fovY: Math.PI / 2 });
      expect(camera.fovY).toBeCloseTo(Math.PI / 2, 9);
      // At 90 degrees, half the viewport spans tan(45) = 1 unit at unit depth.
      expect(camera.pixelsPerRadian(1000)).toBeCloseTo(500, 6);
    });
  });

  describe('floating origin', () => {
    it('rebases once the camera drifts past the threshold', () => {
      const camera = new PlanetCamera({ rebaseThreshold: 1000 });
      camera.position.set(0, 0, 0);
      camera.update();
      expect(camera.frame.rebaseCount).toBe(0);

      camera.position.set(999, 0, 0);
      expect(camera.update()).toBe(false);

      camera.position.set(1001, 0, 0);
      expect(camera.update()).toBe(true);
      expect(camera.frame.rebaseCount).toBe(1);
    });

    it('rebases a bounded number of times over the whole descent', () => {
      const camera = new PlanetCamera({ rebaseThreshold: 4096 });
      for (let i = 0; i <= 2000; i++) {
        const altitude = 1e9 * (1e3 / 1e9) ** (i / 2000);
        camera.placeAtAltitude(CENTRE, new Vec3d(1, 0, 0), altitude, EARTH, UPRIGHT);
        camera.update();
        expect(camera.frame.toFrame(camera.position).length()).toBeLessThanOrEqual(4096);
      }
      expect(camera.frame.rebaseCount).toBeGreaterThan(0);
      expect(camera.frame.rebaseCount).toBeLessThanOrEqual(2001);
    });
  });
});

describe('altitude over a tilted body', () => {
  /**
   * The trap that cost a debugging session. `placeAtAltitude` and
   * `altitudeAbove` need the body's pose because the ground is a different
   * distance from the centre at every latitude — and which latitude a world
   * direction points at depends on how the axis is tilted.
   *
   * With Earth's 23.4 degrees, taking the world direction for the body-fixed
   * one puts a "1 km" camera kilometres off, and nothing complains. Making the
   * pose a required argument is what stops that; these tests pin the size of
   * what it prevents.
   */
  const TILTED = new BodyPose().update(EARTH, 0);
  const DIRECTION = new Vec3d(0.69, 0.33, 0.64);

  it('lands on the requested altitude with the pose', () => {
    const camera = new PlanetCamera();
    for (const altitude of [1e6, 1e3, 0]) {
      camera.placeAtAltitude(CENTRE, DIRECTION, altitude, EARTH, TILTED);
      expect(camera.altitudeAbove(CENTRE, EARTH, TILTED)).toBeCloseTo(altitude, 6);
    }
  });

  it('is kilometres out if the tilt is ignored', () => {
    const camera = new PlanetCamera();
    camera.placeAtAltitude(CENTRE, DIRECTION, 1000, EARTH, TILTED);
    const withTilt = camera.distanceFromCentre(CENTRE);

    const upright = new PlanetCamera();
    upright.placeAtAltitude(CENTRE, DIRECTION, 1000, EARTH, UPRIGHT);
    const withoutTilt = upright.distanceFromCentre(CENTRE);

    expect(Math.abs(withTilt - withoutTilt)).toBeGreaterThan(1000);
  });

  it('does not care how far the body has spun', () => {
    // An ellipsoid looks the same from every longitude, so the time of day must
    // not move the ground.
    const camera = new PlanetCamera();
    const heights: number[] = [];
    for (const seconds of [0, 21_541, 43_082, 64_623]) {
      const pose = new BodyPose().update(EARTH, seconds);
      camera.placeAtAltitude(CENTRE, DIRECTION, 1000, EARTH, pose);
      heights.push(camera.distanceFromCentre(CENTRE));
    }
    for (const h of heights) expect(h).toBeCloseTo(heights[0] as number, 6);
  });

  it('agrees with the sphere case when the body is round', () => {
    const round = { ...EARTH, flattening: 0 };
    const camera = new PlanetCamera();
    camera.placeAtAltitude(CENTRE, DIRECTION, 1000, round, TILTED);
    expect(camera.distanceFromCentre(CENTRE)).toBeCloseTo(round.equatorialRadius + 1000, 6);
  });
});
