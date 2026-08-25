import { describe, expect, it } from 'vitest';
import {
  EARTH_EQUATORIAL_RADIUS,
  EARTH_FLATTENING,
  EARTH_MASS,
  EARTH_ROTATION_PERIOD,
  referenceBody,
} from '../src/body.ts';
import {
  altitudeAbove,
  curvatureRadius,
  equatorialCentrifugalRatio,
  geodeticNormal,
  hydrostaticFlattening,
  meanRadius,
  polarRadius,
  surfacePoint,
  surfaceRadius,
  verticalDeflection,
  type Ellipsoid,
} from '../src/shape.ts';
import { Vec3d } from '../src/vec3d.ts';

const EARTH: Ellipsoid = {
  equatorialRadius: EARTH_EQUATORIAL_RADIUS,
  flattening: EARTH_FLATTENING,
};
const SPHERE: Ellipsoid = { equatorialRadius: 1000, flattening: 0 };

/** Unit direction at a given geocentric latitude, spin axis +Y. */
function atLatitude(degrees: number): Vec3d {
  const lat = (degrees * Math.PI) / 180;
  return new Vec3d(Math.cos(lat), Math.sin(lat), 0).normalize();
}

describe('the ellipsoid', () => {
  it('collapses to a sphere when the flattening is zero', () => {
    expect(polarRadius(SPHERE)).toBe(1000);
    expect(meanRadius(SPHERE)).toBe(1000);
    for (const dir of [atLatitude(0), atLatitude(45), atLatitude(90), atLatitude(-30)]) {
      expect(surfaceRadius(SPHERE, dir)).toBeCloseTo(1000, 9);
      expect(geodeticNormal(SPHERE, dir).distanceTo(dir)).toBeLessThan(1e-12);
      expect(verticalDeflection(SPHERE, dir)).toBeCloseTo(0, 12);
    }
  });

  it('reproduces the WGS 84 numbers', () => {
    expect(polarRadius(EARTH)).toBeCloseTo(6_356_752.314, 2);
    expect(meanRadius(EARTH)).toBeCloseTo(6_371_008.771, 2);
    expect(EARTH.equatorialRadius - polarRadius(EARTH)).toBeCloseTo(21_384.7, 0);
  });

  it('is widest at the equator and narrowest at the poles', () => {
    expect(surfaceRadius(EARTH, atLatitude(0))).toBeCloseTo(EARTH.equatorialRadius, 6);
    expect(surfaceRadius(EARTH, atLatitude(90))).toBeCloseTo(polarRadius(EARTH), 6);
    expect(surfaceRadius(EARTH, atLatitude(-90))).toBeCloseTo(polarRadius(EARTH), 6);
  });

  it('shrinks monotonically from equator to pole', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let lat = 0; lat <= 90; lat += 5) {
      const r = surfaceRadius(EARTH, atLatitude(lat));
      expect(r).toBeLessThanOrEqual(previous + 1e-6);
      previous = r;
    }
  });

  it('puts every surface point on the ellipsoid, to the millimetre', () => {
    const a = EARTH.equatorialRadius;
    const b = polarRadius(EARTH);
    for (let lat = -90; lat <= 90; lat += 7) {
      for (const lon of [0, 40, 130, 250]) {
        const rad = (lat * Math.PI) / 180;
        const lonRad = (lon * Math.PI) / 180;
        const dir = new Vec3d(
          Math.cos(rad) * Math.cos(lonRad),
          Math.sin(rad),
          Math.cos(rad) * Math.sin(lonRad),
        ).normalize();
        const p = surfacePoint(EARTH, dir);
        // x^2/a^2 + y^2/b^2 + z^2/a^2 must be exactly 1 on the surface.
        const residual = (p.x * p.x + p.z * p.z) / (a * a) + (p.y * p.y) / (b * b) - 1;
        expect(Math.abs(residual)).toBeLessThan(1e-12);
      }
    }
  });
});

describe('geodetic versus geocentric up', () => {
  it('agrees at the equator and at the poles', () => {
    expect(verticalDeflection(EARTH, atLatitude(0))).toBeCloseTo(0, 12);
    expect(verticalDeflection(EARTH, atLatitude(90))).toBeCloseTo(0, 12);
  });

  it('differs most near 45 degrees, by about 11.5 arcminutes', () => {
    // The textbook figure for Earth. If this drifts, the terminator moves.
    const arcminutes = (verticalDeflection(EARTH, atLatitude(45)) * 180 * 60) / Math.PI;
    expect(arcminutes).toBeGreaterThan(11);
    expect(arcminutes).toBeLessThan(12);
  });

  it('peaks near 45 degrees rather than anywhere else', () => {
    let best = 0;
    let bestLat = 0;
    for (let lat = 0; lat <= 90; lat += 1) {
      const d = verticalDeflection(EARTH, atLatitude(lat));
      if (d > best) {
        best = d;
        bestLat = lat;
      }
    }
    expect(bestLat).toBeGreaterThan(40);
    expect(bestLat).toBeLessThan(50);
  });

  it('always produces a unit normal pointing outward', () => {
    for (let lat = -90; lat <= 90; lat += 11) {
      const dir = atLatitude(lat);
      const normal = geodeticNormal(EARTH, dir);
      expect(normal.length()).toBeCloseTo(1, 12);
      expect(normal.dot(dir)).toBeGreaterThan(0.999);
    }
  });

  it('leans towards the pole, never towards the equator', () => {
    // On a flattened body the ground under your feet is tilted slightly
    // pole-ward of the line back to the centre, so a plumb line points a little
    // north of the centre in the northern hemisphere. That is why geodetic
    // latitude is always the larger of the two: 45 degrees on a map is 44.8
    // degrees measured from the centre.
    for (const lat of [15, 30, 45, 60, 75]) {
      const dir = atLatitude(lat);
      const normal = geodeticNormal(EARTH, dir);
      // Larger y-component means further from the equatorial plane.
      expect(normal.y).toBeGreaterThan(dir.y);
    }
    for (const lat of [-15, -45, -75]) {
      const dir = atLatitude(lat);
      const normal = geodeticNormal(EARTH, dir);
      expect(normal.y).toBeLessThan(dir.y);
    }
  });

  it('puts geodetic latitude 45 degrees at geocentric 44.8', () => {
    // The published pair. Worth pinning: it is the one number that says the
    // two latitudes are not the same thing.
    const geocentric = 44.8076;
    const dir = atLatitude(geocentric);
    const normal = geodeticNormal(EARTH, dir);
    const geodetic = (Math.asin(normal.y) * 180) / Math.PI;
    expect(geodetic).toBeCloseTo(45, 3);
  });
});

describe('altitude above an ellipsoid', () => {
  it('is zero on the surface, at every latitude', () => {
    for (let lat = -90; lat <= 90; lat += 15) {
      const dir = atLatitude(lat);
      expect(altitudeAbove(EARTH, surfacePoint(EARTH, dir))).toBeCloseTo(0, 6);
    }
  });

  it('measures the right height over the poles as well as the equator', () => {
    // The trap this replaces: subtracting a single radius would report a
    // camera 1000 m over the north pole as being 22 km underground.
    for (const lat of [0, 45, 90]) {
      const dir = atLatitude(lat);
      const point = dir.clone().scale(surfaceRadius(EARTH, dir) + 1000);
      expect(altitudeAbove(EARTH, point)).toBeCloseTo(1000, 6);
    }
  });

  it('reports a negative altitude below the surface', () => {
    const dir = atLatitude(30);
    const point = dir.clone().scale(surfaceRadius(EARTH, dir) - 500);
    expect(altitudeAbove(EARTH, point)).toBeCloseTo(-500, 6);
  });

  it('survives the centre of the body', () => {
    expect(altitudeAbove(EARTH, new Vec3d(0, 0, 0))).toBeCloseTo(-meanRadius(EARTH), 0);
  });
});

describe('flattening from rotation and mass', () => {
  it('is zero for a body that does not turn', () => {
    expect(hydrostaticFlattening(EARTH_MASS, EARTH_EQUATORIAL_RADIUS, 0)).toBe(0);
    expect(hydrostaticFlattening(EARTH_MASS, EARTH_EQUATORIAL_RADIUS, Infinity)).toBe(0);
  });

  it('grows as the square of the spin rate', () => {
    const slow = hydrostaticFlattening(EARTH_MASS, EARTH_EQUATORIAL_RADIUS, 2 * EARTH_ROTATION_PERIOD);
    const fast = hydrostaticFlattening(EARTH_MASS, EARTH_EQUATORIAL_RADIUS, EARTH_ROTATION_PERIOD);
    expect(fast / slow).toBeCloseTo(4, 1);
  });

  it('does not care which way the body turns', () => {
    expect(hydrostaticFlattening(EARTH_MASS, EARTH_EQUATORIAL_RADIUS, -EARTH_ROTATION_PERIOD)).toBe(
      hydrostaticFlattening(EARTH_MASS, EARTH_EQUATORIAL_RADIUS, EARTH_ROTATION_PERIOD),
    );
  });

  it('predicts 1/232 for a uniform Earth, against the measured 1/298', () => {
    // Not a bad approximation — a real result. Earth's mass is concentrated
    // towards the core, so its outer layers bulge less than a uniform body's
    // would. The gap is a measurement of that concentration.
    const predicted = hydrostaticFlattening(
      EARTH_MASS,
      EARTH_EQUATORIAL_RADIUS,
      EARTH_ROTATION_PERIOD,
    );
    expect(1 / predicted).toBeGreaterThan(225);
    expect(1 / predicted).toBeLessThan(240);
    expect(predicted).toBeGreaterThan(EARTH_FLATTENING);
  });

  it('never produces a shape that cannot exist', () => {
    // A body spun far past break-up would otherwise report a flattening above
    // one, which is not a shape at all.
    const absurd = hydrostaticFlattening(EARTH_MASS, EARTH_EQUATORIAL_RADIUS, 60);
    expect(absurd).toBeLessThanOrEqual(0.5);
    expect(absurd).toBeGreaterThan(0);
  });

  it('rejects a body with no mass or no size', () => {
    expect(() => hydrostaticFlattening(0, 1e6, 3600)).toThrow(RangeError);
    expect(() => hydrostaticFlattening(1e24, 0, 3600)).toThrow(RangeError);
  });

  it('reports how close Earth is to shedding its equator', () => {
    // About 0.35 % of surface gravity. Comfortably intact.
    const ratio = equatorialCentrifugalRatio(
      EARTH_MASS,
      EARTH_EQUATORIAL_RADIUS,
      EARTH_ROTATION_PERIOD,
    );
    expect(ratio).toBeGreaterThan(0.003);
    expect(ratio).toBeLessThan(0.004);
  });
});

describe('a Body is an Ellipsoid', () => {
  it('can be handed straight to the shape functions', () => {
    const earth = referenceBody();
    expect(surfaceRadius(earth, atLatitude(0))).toBeCloseTo(earth.equatorialRadius, 6);
    expect(meanRadius(earth)).toBeCloseTo(6_371_008.771, 2);
  });
});

describe('how sharply the surface bends', () => {
  it('is just the radius on a sphere, everywhere', () => {
    for (const lat of [0, 30, 60, 90, -45]) {
      expect(curvatureRadius(SPHERE, atLatitude(lat))).toBeCloseTo(1000, 9);
    }
  });

  it('is tightest at the equator and flattest at the poles', () => {
    // The opposite of the radius, which is longest at the equator. An oblate
    // body is a squashed ball: the squashed part is the flat part.
    const equator = curvatureRadius(EARTH, atLatitude(0));
    const pole = curvatureRadius(EARTH, atLatitude(90));
    expect(equator).toBeLessThan(pole);
    expect(equator).toBeLessThan(polarRadius(EARTH));
    expect(pole).toBeGreaterThan(EARTH.equatorialRadius);
  });

  it('matches the published geodesy for Earth', () => {
    // b^2/a at the equator, a^2/b at the pole.
    const a = EARTH.equatorialRadius;
    const b = polarRadius(EARTH);
    expect(curvatureRadius(EARTH, atLatitude(0))).toBeCloseTo((b * b) / a, 3);
    expect(curvatureRadius(EARTH, atLatitude(90))).toBeCloseTo((a * a) / b, 3);
    expect(curvatureRadius(EARTH, atLatitude(0))).toBeCloseTo(6_335_439, 0);
  });

  it('never exceeds the distance to the centre by more than the flattening allows', () => {
    for (let lat = -90; lat <= 90; lat += 9) {
      const dir = atLatitude(lat);
      const r = curvatureRadius(EARTH, dir);
      expect(r).toBeGreaterThan(0);
      expect(Math.abs(r / surfaceRadius(EARTH, dir) - 1)).toBeLessThan(0.01);
    }
  });

  it('is what makes a flat tile sag less at the pole than at the equator', () => {
    // The number the level-of-detail error is built on: same tile size, more
    // error where the ground curves harder.
    const arc = 100_000;
    const sag = (dir: Vec3d): number => (arc * arc) / (8 * curvatureRadius(EARTH, dir));
    expect(sag(atLatitude(0))).toBeGreaterThan(sag(atLatitude(90)));
  });
});
