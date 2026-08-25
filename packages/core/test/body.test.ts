import { describe, expect, it } from 'vitest';
import {
  BODY_CLASSES,
  EARTH_EQUATORIAL_RADIUS,
  EARTH_FLATTENING,
  EARTH_MASS,
  EARTH_MEAN_RADIUS,
  escapeVelocity,
  makeBody,
  maxSurfaceRadius,
  meanDensity,
  meanRadius,
  minSurfaceRadius,
  polarRadius,
  referenceBody,
  surfaceGravity,
} from '../src/body.ts';
import { hydrostaticFlattening, surfaceRadius } from '../src/shape.ts';
import { Vec3d } from '../src/vec3d.ts';

describe('makeBody', () => {
  it('is a pure function of the seed', () => {
    expect(makeBody(1234)).toEqual(makeBody(1234));
    expect(makeBody(1234)).not.toEqual(makeBody(1235));
  });

  it('produces frozen plain data, not an instance with behaviour', () => {
    const body = makeBody(7);
    expect(Object.isFrozen(body)).toBe(true);
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(body))).toEqual({ ...body, terrain: { ...body.terrain } });
  });

  it('stays inside plausible physical ranges for every class', () => {
    for (const bodyClass of BODY_CLASSES) {
      for (let i = 0; i < 200; i++) {
        const body = makeBody(i * 7919 + 3, { bodyClass });
        expect(body.class).toBe(bodyClass);
        expect(meanRadius(body)).toBeGreaterThan(1e5);
        expect(meanRadius(body)).toBeLessThan(1e8);
        expect(polarRadius(body)).toBeLessThanOrEqual(body.equatorialRadius);
        expect(meanDensity(body)).toBeGreaterThan(500);
        expect(meanDensity(body)).toBeLessThan(6500);
        expect(body.terrain.amplitude).toBeGreaterThanOrEqual(0);
        expect(body.terrain.amplitude).toBeLessThan(meanRadius(body) * 0.01);
        expect(body.terrain.octaves).toBeGreaterThanOrEqual(4);
        expect(body.terrain.octaves).toBeLessThanOrEqual(9);
        expect(Number.isFinite(body.mass)).toBe(true);
      }
    }
  });

  it('draws every class over enough seeds', () => {
    const seen = new Set(Array.from({ length: 500 }, (_, i) => makeBody(i).class));
    expect(seen.size).toBe(BODY_CLASSES.length);
  });

  it('applies overrides last', () => {
    const body = makeBody(1, { overrides: { equatorialRadius: 123 } });
    expect(body.equatorialRadius).toBe(123);
    expect(body.id).toBe(makeBody(1).id);
  });

  it('derives the shape from the rotation and the mass, not from a draw', () => {
    // A body that turns faster must come out flatter, every time. Nothing here
    // is random: it is the physics of a spinning fluid.
    for (let i = 0; i < 50; i++) {
      const body = makeBody(i * 977 + 5, { bodyClass: 'rocky' });
      const predicted = hydrostaticFlattening(
        body.mass,
        meanRadius(body),
        body.rotationPeriod,
      );
      // The stored flattening comes from the same physics, computed on the mean
      // radius before the equatorial one was solved back out.
      expect(Math.abs(body.flattening - predicted)).toBeLessThan(predicted * 0.05 + 1e-9);
      expect(body.flattening).toBeGreaterThanOrEqual(0);
      expect(body.flattening).toBeLessThan(0.5);
    }
  });

  it('spins faster into a flatter body', () => {
    const slow = makeBody(11, { bodyClass: 'rocky', overrides: { rotationPeriod: 200 * 3600 } });
    const fast = makeBody(11, { bodyClass: 'rocky', overrides: { rotationPeriod: 4 * 3600 } });
    // Overrides are applied after generation, so recompute from the physics.
    expect(
      hydrostaticFlattening(fast.mass, meanRadius(fast), fast.rotationPeriod),
    ).toBeGreaterThan(hydrostaticFlattening(slow.mass, meanRadius(slow), slow.rotationPeriod));
  });

  it('gives each seed its own id', () => {
    const ids = new Set(Array.from({ length: 1000 }, (_, i) => makeBody(i).id));
    expect(ids.size).toBe(1000);
  });
});

describe('referenceBody', () => {
  it('is Earth-shaped: WGS 84, not a sphere', () => {
    const earth = referenceBody();
    expect(earth.equatorialRadius).toBe(EARTH_EQUATORIAL_RADIUS);
    expect(earth.flattening).toBeCloseTo(EARTH_FLATTENING, 12);
    expect(earth.mass).toBe(EARTH_MASS);
    expect(earth.terrain.amplitude).toBe(0);
  });

  it('has the mean radius everybody quotes', () => {
    // The IUGG mean of the WGS 84 ellipsoid is 6371008.8 m, which is where the
    // familiar "6371 km" comes from. It is derived, not a separate constant.
    expect(Math.abs(meanRadius(referenceBody()) - EARTH_MEAN_RADIUS)).toBeLessThan(20);
  });

  it('is 21 km flatter pole to pole, which is what makes it visibly not round', () => {
    const earth = referenceBody();
    const difference = earth.equatorialRadius - polarRadius(earth);
    expect(difference).toBeGreaterThan(21_000);
    expect(difference).toBeLessThan(21_500);
  });

  it('reaches its equatorial radius at the equator and its polar one at the pole', () => {
    const earth = referenceBody();
    expect(surfaceRadius(earth, new Vec3d(1, 0, 0))).toBeCloseTo(earth.equatorialRadius, 6);
    expect(surfaceRadius(earth, new Vec3d(0, 1, 0))).toBeCloseTo(polarRadius(earth), 6);
    expect(maxSurfaceRadius(earth)).toBe(earth.equatorialRadius);
    expect(minSurfaceRadius(earth)).toBeCloseTo(polarRadius(earth), 6);
  });

  it('is flatter than the homogeneous prediction, because of its core', () => {
    // 1/298 measured against 1/232 predicted for a uniform body. The gap is a
    // measurement of how much of Earth's mass sits in the middle.
    const earth = referenceBody();
    const homogeneous = hydrostaticFlattening(
      earth.mass,
      earth.equatorialRadius,
      earth.rotationPeriod,
    );
    expect(homogeneous).toBeGreaterThan(earth.flattening);
    expect(homogeneous / earth.flattening).toBeGreaterThan(1.2);
    expect(homogeneous / earth.flattening).toBeLessThan(1.4);
  });

  it('reproduces Earth physics closely enough to trust the constants', () => {
    const earth = referenceBody();
    expect(surfaceGravity(earth)).toBeCloseTo(9.82, 1);
    expect(escapeVelocity(earth)).toBeCloseTo(11180, -2);
    expect(meanDensity(earth)).toBeCloseTo(5514, -2);
  });
});
