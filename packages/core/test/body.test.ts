import { describe, expect, it } from 'vitest';
import {
  BODY_CLASSES,
  EARTH_MASS,
  EARTH_RADIUS,
  escapeVelocity,
  makeBody,
  maxSurfaceRadius,
  meanDensity,
  minSurfaceRadius,
  referenceBody,
  surfaceGravity,
} from '../src/body.ts';

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
        expect(body.radius).toBeGreaterThan(1e5);
        expect(body.radius).toBeLessThan(1e8);
        expect(meanDensity(body)).toBeGreaterThan(500);
        expect(meanDensity(body)).toBeLessThan(6500);
        expect(body.terrain.amplitude).toBeGreaterThanOrEqual(0);
        expect(body.terrain.amplitude).toBeLessThan(body.radius * 0.01);
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
    const body = makeBody(1, { overrides: { radius: 123 } });
    expect(body.radius).toBe(123);
    expect(body.id).toBe(makeBody(1).id);
  });

  it('gives each seed its own id', () => {
    const ids = new Set(Array.from({ length: 1000 }, (_, i) => makeBody(i).id));
    expect(ids.size).toBe(1000);
  });
});

describe('referenceBody', () => {
  it('is Earth-sized and, for stage 01, exactly spherical', () => {
    const earth = referenceBody();
    expect(earth.radius).toBe(EARTH_RADIUS);
    expect(earth.mass).toBe(EARTH_MASS);
    expect(earth.terrain.amplitude).toBe(0);
    expect(maxSurfaceRadius(earth)).toBe(EARTH_RADIUS);
    expect(minSurfaceRadius(earth)).toBe(EARTH_RADIUS);
  });

  it('reproduces Earth physics closely enough to trust the constants', () => {
    const earth = referenceBody();
    expect(surfaceGravity(earth)).toBeCloseTo(9.82, 1);
    expect(escapeVelocity(earth)).toBeCloseTo(11180, -2);
    expect(meanDensity(earth)).toBeCloseTo(5514, -2);
  });
});
