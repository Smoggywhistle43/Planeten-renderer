import { describe, expect, it } from 'vitest';
import {
  EARTH_AXIAL_TILT,
  EARTH_EQUATORIAL_RADIUS,
  EARTH_ROTATION_PERIOD,
  referenceBody,
} from '../src/body.ts';
import {
  BodyPose,
  angularVelocity,
  spinAngleAt,
  surfaceVelocity,
  type Spinning,
} from '../src/orientation.ts';
import { Vec3d } from '../src/vec3d.ts';

function spinning(overrides: Partial<Spinning> = {}): Spinning {
  return {
    rotationPeriod: EARTH_ROTATION_PERIOD,
    axialTilt: 0,
    axialTiltAzimuth: 0,
    spinAtEpoch: 0,
    ...overrides,
  };
}

/** The axes must stay a right-handed set of unit vectors, forever. */
function expectOrthonormal(pose: BodyPose): void {
  for (const axis of [pose.x, pose.y, pose.z]) {
    expect(axis.length()).toBeCloseTo(1, 12);
  }
  expect(pose.x.dot(pose.y)).toBeCloseTo(0, 12);
  expect(pose.y.dot(pose.z)).toBeCloseTo(0, 12);
  expect(pose.z.dot(pose.x)).toBeCloseTo(0, 12);
  // x cross y must be z, not -z.
  const handedness = pose.x.clone().cross(pose.y);
  expect(handedness.distanceTo(pose.z)).toBeLessThan(1e-12);
}

describe('the pose at time zero', () => {
  it('is the identity for an untilted body at zero spin', () => {
    const pose = new BodyPose().update(spinning(), 0);
    expect(pose.x.distanceTo(new Vec3d(1, 0, 0))).toBeLessThan(1e-12);
    expect(pose.y.distanceTo(new Vec3d(0, 1, 0))).toBeLessThan(1e-12);
    expect(pose.z.distanceTo(new Vec3d(0, 0, 1))).toBeLessThan(1e-12);
  });

  it('stays orthonormal and right-handed at every time and tilt', () => {
    const body = spinning({ axialTilt: EARTH_AXIAL_TILT, axialTiltAzimuth: 1.3 });
    for (const t of [0, 1, 1234.5, -9999, 86_164.0905, 1e7]) {
      expectOrthonormal(new BodyPose().update(body, t));
    }
    for (const tilt of [0, 0.4, Math.PI / 2, 2.5, Math.PI]) {
      expectOrthonormal(new BodyPose().update(spinning({ axialTilt: tilt }), 4242));
    }
  });
});

describe('the spin', () => {
  it('comes all the way back around after one full period', () => {
    const body = spinning();
    const start = new BodyPose().update(body, 0);
    const later = new BodyPose().update(body, EARTH_ROTATION_PERIOD);
    expect(later.x.distanceTo(start.x)).toBeLessThan(1e-9);
    expect(later.z.distanceTo(start.z)).toBeLessThan(1e-9);
  });

  it('is halfway around after half a period', () => {
    const pose = new BodyPose().update(spinning(), EARTH_ROTATION_PERIOD / 2);
    expect(pose.x.distanceTo(new Vec3d(-1, 0, 0))).toBeLessThan(1e-9);
    expect(pose.z.distanceTo(new Vec3d(0, 0, -1))).toBeLessThan(1e-9);
  });

  it('turns the right way round: prograde is counter-clockwise from above', () => {
    // A quarter turn takes body +X towards world -Z, seen looking down the +Y
    // axis. Get this backwards and the sun rises in the west.
    const pose = new BodyPose().update(spinning(), EARTH_ROTATION_PERIOD / 4);
    expect(pose.x.distanceTo(new Vec3d(0, 0, -1))).toBeLessThan(1e-9);
  });

  it('turns the other way for a retrograde body', () => {
    const pose = new BodyPose().update(spinning({ rotationPeriod: -EARTH_ROTATION_PERIOD }), EARTH_ROTATION_PERIOD / 4);
    expect(pose.x.distanceTo(new Vec3d(0, 0, 1))).toBeLessThan(1e-9);
  });

  it('does not turn at all for a body with no period', () => {
    for (const period of [0, Infinity, Number.NaN]) {
      const pose = new BodyPose().update(spinning({ rotationPeriod: period }), 1e6);
      expect(pose.x.distanceTo(new Vec3d(1, 0, 0))).toBeLessThan(1e-12);
      expect(angularVelocity(spinning({ rotationPeriod: period }))).toBe(0);
    }
  });

  it('starts where the epoch angle says, not always at zero', () => {
    const pose = new BodyPose().update(spinning({ spinAtEpoch: Math.PI / 2 }), 0);
    expect(pose.x.distanceTo(new Vec3d(0, 0, -1))).toBeLessThan(1e-9);
  });

  it('is rebuilt from absolute time, never accumulated', () => {
    // The whole point of the design. Stepping in a thousand small pieces must
    // land in exactly the same place as one big jump, or the world would
    // depend on the frame rate.
    const body = spinning({ axialTilt: EARTH_AXIAL_TILT, axialTiltAzimuth: 0.7 });
    const direct = new BodyPose().update(body, 5000);
    const stepped = new BodyPose();
    for (let i = 1; i <= 1000; i++) stepped.update(body, i * 5);
    expect(stepped.x.distanceTo(direct.x)).toBeLessThan(1e-12);
    expect(stepped.y.distanceTo(direct.y)).toBeLessThan(1e-12);
    expect(stepped.z.distanceTo(direct.z)).toBeLessThan(1e-12);
  });

  it('reports Earth turning once per sidereal day', () => {
    const omega = angularVelocity(spinning());
    expect(omega).toBeCloseTo(7.2921e-5, 9);
  });

  it('agrees with spinAngleAt', () => {
    const body = spinning({ spinAtEpoch: 0.3 });
    const pose = new BodyPose().update(body, 12_345);
    expect(pose.spinAngle).toBe(spinAngleAt(body, 12_345));
  });
});

describe('the axial tilt', () => {
  it('leaves the axis upright when the tilt is zero', () => {
    const pose = new BodyPose().update(spinning({ axialTilt: 0 }), 999);
    expect(pose.y.distanceTo(new Vec3d(0, 1, 0))).toBeLessThan(1e-12);
  });

  it('leans the axis by exactly the tilt angle', () => {
    for (const tilt of [0.1, EARTH_AXIAL_TILT, 1.0, Math.PI / 2]) {
      const pose = new BodyPose().update(spinning({ axialTilt: tilt }), 1234);
      const fromUpright = Math.acos(Math.min(1, Math.max(-1, pose.y.y)));
      expect(fromUpright).toBeCloseTo(tilt, 12);
    }
  });

  it('leans in the direction the azimuth says', () => {
    // Azimuth 0 tips the north pole towards world +X; a quarter turn of
    // azimuth tips it towards +Z instead.
    const flat = new BodyPose().update(spinning({ axialTilt: 0.5, axialTiltAzimuth: 0 }), 0);
    expect(flat.y.x).toBeGreaterThan(0);
    expect(Math.abs(flat.y.z)).toBeLessThan(1e-12);

    const quarter = new BodyPose().update(
      spinning({ axialTilt: 0.5, axialTiltAzimuth: Math.PI / 2 }),
      0,
    );
    expect(quarter.y.z).toBeGreaterThan(0);
    expect(Math.abs(quarter.y.x)).toBeLessThan(1e-12);
  });

  it('holds the axis still while the body spins under it', () => {
    // The reason seasons last months and days last hours: the spin does not
    // move the axis.
    const body = spinning({ axialTilt: EARTH_AXIAL_TILT, axialTiltAzimuth: 2.0 });
    const first = new BodyPose().update(body, 0).y.clone();
    for (const t of [1000, 40_000, 86_164, 1e6]) {
      const y = new BodyPose().update(body, t).y;
      expect(y.distanceTo(first)).toBeLessThan(1e-12);
    }
  });

  it('gives Earth 23.4 degrees', () => {
    const earth = referenceBody();
    const pose = new BodyPose().update(earth, 0);
    const degrees = (Math.acos(pose.y.y) * 180) / Math.PI;
    expect(degrees).toBeCloseTo(23.44, 2);
  });
});

describe('converting between the frames', () => {
  it('round-trips any vector', () => {
    const pose = new BodyPose().update(
      spinning({ axialTilt: 0.9, axialTiltAzimuth: -1.7, spinAtEpoch: 0.4 }),
      55_555,
    );
    for (const v of [
      new Vec3d(1, 0, 0),
      new Vec3d(0, 0, 1),
      new Vec3d(6.378e6, -1.2e6, 3.3e6),
      new Vec3d(-7, 11, -13),
    ]) {
      const back = pose.toBody(pose.toWorld(v));
      expect(back.distanceTo(v)).toBeLessThan(1e-9 * Math.max(1, v.length()));
    }
  });

  it('preserves lengths and angles, because it is only a rotation', () => {
    const pose = new BodyPose().update(spinning({ axialTilt: 0.6 }), 3600);
    const a = new Vec3d(3, -4, 12);
    const b = new Vec3d(-1, 5, 2);
    expect(pose.toWorld(a).length()).toBeCloseTo(a.length(), 9);
    expect(pose.toWorld(a).dot(pose.toWorld(b))).toBeCloseTo(a.dot(b), 9);
  });

  it('sends the body-fixed axes to the pose axes', () => {
    const pose = new BodyPose().update(spinning({ axialTilt: 0.3, axialTiltAzimuth: 1.1 }), 700);
    expect(pose.toWorld(new Vec3d(1, 0, 0)).distanceTo(pose.x)).toBeLessThan(1e-12);
    expect(pose.toWorld(new Vec3d(0, 1, 0)).distanceTo(pose.y)).toBeLessThan(1e-12);
    expect(pose.toWorld(new Vec3d(0, 0, 1)).distanceTo(pose.z)).toBeLessThan(1e-12);
  });

  it('writes a matrix that does the same thing as toWorld', () => {
    const pose = new BodyPose().update(spinning({ axialTilt: 0.8, axialTiltAzimuth: 0.2 }), 4321);
    const m = pose.writeMatrix4([]);
    expect(m).toHaveLength(16);
    const at = (i: number): number => {
      const value = m[i];
      if (value === undefined) throw new Error(`matrix is short at ${i}`);
      return value;
    };
    const v = new Vec3d(2, -3, 5);
    // Column-major, the layout every graphics API expects.
    const byMatrix = new Vec3d(
      at(0) * v.x + at(4) * v.y + at(8) * v.z,
      at(1) * v.x + at(5) * v.y + at(9) * v.z,
      at(2) * v.x + at(6) * v.y + at(10) * v.z,
    );
    expect(byMatrix.distanceTo(pose.toWorld(v))).toBeLessThan(1e-12);
    expect(at(15)).toBe(1);
  });
});

describe('how fast the ground moves', () => {
  it('is 465 metres per second at Earth’s equator', () => {
    const v = surfaceVelocity(spinning(), new Vec3d(EARTH_EQUATORIAL_RADIUS, 0, 0));
    expect(v.length()).toBeCloseTo(465.1, 0);
  });

  it('is zero on the axis', () => {
    const v = surfaceVelocity(spinning(), new Vec3d(0, 6.4e6, 0));
    expect(v.length()).toBe(0);
  });

  it('points east and stays level', () => {
    // East is by definition the way the body turns. With the spin axis along
    // +Y, prograde carries a point on the +X side towards -Z, so that is east
    // here. What matters physically is only that the ground moves sideways:
    // the velocity never has a vertical component and never points outward.
    const v = surfaceVelocity(spinning(), new Vec3d(EARTH_EQUATORIAL_RADIUS, 1e6, 0));
    expect(v.y).toBe(0);
    expect(v.z).toBeLessThan(0);
    const radial = new Vec3d(EARTH_EQUATORIAL_RADIUS, 1e6, 0);
    expect(Math.abs(v.dot(radial))).toBeLessThan(1e-6 * v.length() * radial.length());
  });

  it('reverses for a retrograde body', () => {
    const point = new Vec3d(EARTH_EQUATORIAL_RADIUS, 0, 0);
    const forward = surfaceVelocity(spinning(), point);
    const back = surfaceVelocity(spinning({ rotationPeriod: -EARTH_ROTATION_PERIOD }), point);
    expect(back.z).toBeCloseTo(-forward.z, 6);
  });
});
