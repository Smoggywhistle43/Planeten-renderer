/**
 * Where a body is pointing, and how fast it is turning.
 *
 * Two things every body has and neither is optional:
 *
 *   spin        it turns, so the terrain under a fixed point in space changes
 *   axial tilt  its spin axis is not perpendicular to its orbit, which is the
 *               entire reason seasons exist and why the terminator is not a
 *               straight north-south line
 *
 * `BodyPose` is the rotation from body-fixed coordinates — the frame terrain
 * and tiles live in — to world coordinates. It is three orthonormal axes rather
 * than a quaternion or a matrix class, because that is the smallest thing that
 * does the job and it keeps `core` free of a maths library it does not need.
 *
 * Conventions, stated once so nothing has to guess:
 *
 *   body-fixed +Y   the spin axis, before tilt
 *   world +Y        the orbital normal, so tilt is measured from it
 *   positive spin   counter-clockwise seen from +Y, i.e. prograde
 *
 * The rotation is rebuilt from the elapsed time on every update rather than
 * accumulated frame by frame. An accumulating rotation drifts out of
 * orthonormality and, worse, makes the world depend on the frame rate.
 */

import { Vec3d, rotateAbout } from './vec3d.ts';

/** Everything needed to know where a body points at a given moment. */
export interface Spinning {
  /** Sidereal rotation period, seconds. Negative is retrograde. */
  readonly rotationPeriod: number;
  /** Angle between the spin axis and the orbital normal, radians. */
  readonly axialTilt: number;
  /** Which way the axis leans, radians around the orbital plane. */
  readonly axialTiltAzimuth: number;
  /** Rotation angle at time zero, radians. Fixes the prime meridian. */
  readonly spinAtEpoch: number;
}

const UNIT_X = /*@__PURE__*/ new Vec3d(1, 0, 0);
const UNIT_Y = /*@__PURE__*/ new Vec3d(0, 1, 0);
const UNIT_Z = /*@__PURE__*/ new Vec3d(0, 0, 1);

/**
 * The body's axes, expressed in world coordinates.
 *
 * Mutable and reused: this gets rebuilt every frame, and allocating three
 * vectors per body per frame is pointless.
 */
export class BodyPose {
  /** Body-fixed X axis, in world coordinates. */
  readonly x = new Vec3d(1, 0, 0);
  /** Body-fixed Y axis — the spin axis — in world coordinates. */
  readonly y = new Vec3d(0, 1, 0);
  /** Body-fixed Z axis, in world coordinates. */
  readonly z = new Vec3d(0, 0, 1);

  /** Rotation angle used for the current axes, radians. Diagnostics. */
  spinAngle = 0;

  private readonly tiltAxis = new Vec3d();
  private readonly tilted = { x: new Vec3d(), y: new Vec3d(), z: new Vec3d() };

  /** Point the pose at where `body` is at `seconds` past the epoch. */
  update(body: Spinning, seconds: number): this {
    const tilt = body.axialTilt;
    const azimuth = body.axialTiltAzimuth;

    // Lean the spin axis by `tilt` towards `azimuth`. Rotating about this axis
    // takes world +Y to (sin t cos a, cos t, sin t sin a), which is the axis
    // leaning the way the azimuth says.
    this.tiltAxis.set(Math.sin(azimuth), 0, -Math.cos(azimuth));

    rotateAbout(UNIT_X, this.tiltAxis, tilt, this.tilted.x);
    rotateAbout(UNIT_Y, this.tiltAxis, tilt, this.tilted.y);
    rotateAbout(UNIT_Z, this.tiltAxis, tilt, this.tilted.z);

    this.spinAngle = spinAngleAt(body, seconds);

    // The spin happens about the body's own axis, so it comes after the tilt.
    this.y.copy(this.tilted.y);
    rotateAbout(this.tilted.x, this.y, this.spinAngle, this.x);
    rotateAbout(this.tilted.z, this.y, this.spinAngle, this.z);
    return this;
  }

  /** Body-fixed vector to world. A rotation, so it works for points too. */
  toWorld(v: Vec3d, out: Vec3d = new Vec3d()): Vec3d {
    return out.set(
      this.x.x * v.x + this.y.x * v.y + this.z.x * v.z,
      this.x.y * v.x + this.y.y * v.y + this.z.y * v.z,
      this.x.z * v.x + this.y.z * v.y + this.z.z * v.z,
    );
  }

  /** World vector to body-fixed. The transpose, because the basis is orthonormal. */
  toBody(v: Vec3d, out: Vec3d = new Vec3d()): Vec3d {
    return out.set(this.x.dot(v), this.y.dot(v), this.z.dot(v));
  }

  /** Copy the axes into a column-major 4x4, for handing to a renderer. */
  writeMatrix4(out: number[]): number[] {
    out[0] = this.x.x;
    out[1] = this.x.y;
    out[2] = this.x.z;
    out[3] = 0;
    out[4] = this.y.x;
    out[5] = this.y.y;
    out[6] = this.y.z;
    out[7] = 0;
    out[8] = this.z.x;
    out[9] = this.z.y;
    out[10] = this.z.z;
    out[11] = 0;
    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 1;
    return out;
  }
}

/**
 * Rotation angle at a given time, radians.
 *
 * Computed from the absolute time rather than accumulated, so the same moment
 * always gives the same angle no matter how the simulation got there.
 */
export function spinAngleAt(body: Spinning, seconds: number): number {
  if (!Number.isFinite(body.rotationPeriod) || body.rotationPeriod === 0) {
    return body.spinAtEpoch;
  }
  return body.spinAtEpoch + (2 * Math.PI * seconds) / body.rotationPeriod;
}

/** Angular speed, radians per second. Negative is retrograde. */
export function angularVelocity(body: Spinning): number {
  if (!Number.isFinite(body.rotationPeriod) || body.rotationPeriod === 0) return 0;
  return (2 * Math.PI) / body.rotationPeriod;
}

/**
 * Speed of the surface at a body-fixed point, metres per second.
 *
 * At Earth's equator this is 465 m/s. It is what a launch site gains for free,
 * and later it is what makes a fixed camera drift over the ground.
 */
export function surfaceVelocity(
  body: Spinning,
  pointBodyFixed: Vec3d,
  out: Vec3d = new Vec3d(),
): Vec3d {
  const omega = angularVelocity(body);
  // v = omega x r, with omega along body-fixed +Y.
  return out.set(omega * pointBodyFixed.z, 0, -omega * pointBodyFixed.x);
}
