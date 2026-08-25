/**
 * The shape of a body. Not a sphere.
 *
 * A body that spins bulges at its equator. Earth is 21 km wider across the
 * equator than pole to pole — 0.34 %, which is three pixels on a thousand-pixel
 * disc and therefore visible. Jupiter is flattened by 6.5 %, which nobody could
 * miss. Saturn by 9.8 %.
 *
 * This is not an optional feature of some bodies. It is what rotation and mass
 * do to anything big enough to be round, so it belongs in the foundation
 * alongside them — and `hydrostaticFlattening` below computes it *from* the
 * rotation and the mass rather than taking it as a free parameter.
 *
 * Everything here works on an oblate spheroid: one equatorial radius, one
 * flattening, spin axis along +Y. Real bodies small enough to be lumpy are not
 * ellipsoids at all; those need a shape model, and that is a later problem.
 *
 * Two different "up" directions matter and are easy to confuse:
 *
 *   geocentric   the direction from the centre to the point
 *   geodetic     the direction perpendicular to the surface
 *
 * On a sphere they are the same. On Earth they differ by up to 11.5 arcminutes,
 * at 45 degrees latitude. The renderer needs the geodetic one for shading — the
 * geocentric one would put the terminator in slightly the wrong place.
 */

import { Vec3d } from './vec3d.ts';

/**
 * An oblate spheroid. The spin axis is +Y.
 *
 * `Body` carries these two fields, so a `Body` can be passed to anything here.
 */
export interface Ellipsoid {
  /** Radius across the equator, metres. The larger one. */
  readonly equatorialRadius: number;
  /** `(a - b) / a`. Zero is a sphere; Earth is about 1/298. */
  readonly flattening: number;
}

/** A perfectly round body. Handy for tests and for bodies that do not turn. */
export function sphere(radius: number): Ellipsoid {
  return { equatorialRadius: radius, flattening: 0 };
}

/** Radius from the centre to either pole, metres. */
export function polarRadius(shape: Ellipsoid): number {
  return shape.equatorialRadius * (1 - shape.flattening);
}

/**
 * Mean radius, metres: `(2a + b) / 3`, the IUGG definition.
 *
 * This is the number to use wherever a single characteristic size is wanted —
 * gravity, orbital mechanics, "how big is this thing". For Earth it comes out
 * at 6371.0 km, which is the figure everybody quotes.
 */
export function meanRadius(shape: Ellipsoid): number {
  return (2 * shape.equatorialRadius + polarRadius(shape)) / 3;
}

/**
 * Distance from the centre to the surface along a unit direction, metres.
 *
 * Solving `t^2 * ((dx^2 + dz^2) / a^2 + dy^2 / b^2) = 1` for `t`.
 */
export function surfaceRadius(shape: Ellipsoid, direction: Vec3d): number {
  const a = shape.equatorialRadius;
  const b = polarRadius(shape);
  const horizontal = direction.x * direction.x + direction.z * direction.z;
  const vertical = direction.y * direction.y;
  const denominator = horizontal / (a * a) + vertical / (b * b);
  if (!(denominator > 0)) return a;
  return 1 / Math.sqrt(denominator);
}

/** The point on the surface along a unit direction, body-fixed coordinates. */
export function surfacePoint(
  shape: Ellipsoid,
  direction: Vec3d,
  out: Vec3d = new Vec3d(),
): Vec3d {
  return out.copy(direction).scale(surfaceRadius(shape, direction));
}

/**
 * Outward normal of the surface at the point along `direction`, body-fixed.
 *
 * The gradient of `x^2/a^2 + y^2/b^2 + z^2/a^2 = 1`, normalised. On a sphere
 * this is the direction itself; on Earth it tilts away from it by up to 11.5
 * arcminutes, which is what makes the terminator sit where it really sits.
 */
export function geodeticNormal(
  shape: Ellipsoid,
  direction: Vec3d,
  out: Vec3d = new Vec3d(),
): Vec3d {
  const a = shape.equatorialRadius;
  const b = polarRadius(shape);
  const invA2 = 1 / (a * a);
  const invB2 = 1 / (b * b);
  // The radial scaling cancels in the normalisation, so the direction alone is
  // enough — no need to find the surface point first.
  return out.set(direction.x * invA2, direction.y * invB2, direction.z * invA2).normalize();
}

/**
 * How sharply the surface bends at a point, metres — the tighter of the two
 * radii of curvature there.
 *
 * Not the same as the distance to the centre, and the difference is the wrong
 * way round from intuition: at the pole an oblate body is *flatter* than its
 * short polar radius suggests, and at the equator it bends *harder* than its
 * long equatorial radius suggests.
 *
 * This is the number the level-of-detail error wants. A flat tile chord sags
 * away from a curved surface by `arc^2 / (8 R)` with `R` the curvature radius,
 * so using the distance-to-centre instead would under-estimate the error along
 * the equator — by 0.7 % on Earth, but by 23 % on Saturn.
 *
 * The meridional radius `M = a(1-e^2) / (1 - e^2 sin^2 phi)^{3/2}`, with `phi`
 * the geodetic latitude, which is what the geodetic normal already gives us.
 */
export function curvatureRadius(shape: Ellipsoid, direction: Vec3d): number {
  const a = shape.equatorialRadius;
  const b = polarRadius(shape);
  if (shape.flattening === 0) return a;
  const e2 = 1 - (b * b) / (a * a);
  const sinPhi = geodeticNormal(shape, direction).y;
  const w = 1 - e2 * sinPhi * sinPhi;
  return (a * (1 - e2)) / (w * Math.sqrt(w));
}

/**
 * Angle between the geocentric and geodetic directions, radians.
 *
 * Zero at the equator and at the poles, largest around 45 degrees latitude.
 * Diagnostics, and a useful thing to assert against published geodesy.
 */
export function verticalDeflection(shape: Ellipsoid, direction: Vec3d): number {
  const normal = geodeticNormal(shape, direction);
  const dot = Math.min(1, Math.max(-1, normal.dot(direction) / direction.length()));
  return Math.acos(dot);
}

/**
 * Height of a point above the surface, metres, measured along the geocentric
 * direction rather than along the geodetic normal.
 *
 * The two differ by less than a millimetre per kilometre of altitude on Earth,
 * and the geocentric one is what the camera and the LOD want: it answers "how
 * far am I from the ground below me" without an iterative solve.
 */
export function altitudeAbove(shape: Ellipsoid, pointFromCentre: Vec3d): number {
  const distance = pointFromCentre.length();
  if (distance === 0) return -meanRadius(shape);
  const direction = pointFromCentre.clone().scale(1 / distance);
  return distance - surfaceRadius(shape, direction);
}

// ------------------------------------------------------------- rotation -----

/** Gravitational constant, m^3 kg^-1 s^-2 (CODATA 2018). */
const G = 6.6743e-11;

/**
 * How flat rotation makes a body, if its density were uniform.
 *
 * `f ≈ (5/4) * m`, where `m = omega^2 a^3 / GM` is the ratio of centrifugal to
 * gravitational acceleration at the equator. This is the first-order
 * hydrostatic result for a homogeneous body.
 *
 * It over-predicts, and by a known amount: for Earth it gives 1/232 against the
 * measured 1/298. The reason is real physics rather than a bad approximation —
 * Earth's mass is concentrated towards the core, so the outer layers feel a
 * stronger pull than a uniform body would and bulge less. A body's flattening
 * is therefore a *measurement* of how centrally condensed it is.
 *
 * Use this to give a generated body a plausible shape. Use the measured value
 * for any body that has one.
 */
export function hydrostaticFlattening(
  mass: number,
  equatorialRadius: number,
  rotationPeriodSeconds: number,
): number {
  if (!(mass > 0) || !(equatorialRadius > 0)) {
    throw new RangeError('hydrostaticFlattening: mass and radius must be positive');
  }
  const period = Math.abs(rotationPeriodSeconds);
  if (!(period > 0)) return 0;

  const omega = (2 * Math.PI) / period;
  const centrifugalRatio = (omega * omega * equatorialRadius ** 3) / (G * mass);
  const flattening = 1.25 * centrifugalRatio;

  // Past about a half the body is not an ellipsoid any more, it is coming
  // apart. Clamp rather than emit a shape that cannot exist.
  return Math.min(0.5, Math.max(0, flattening));
}

/**
 * Fraction of surface gravity cancelled by rotation at the equator.
 *
 * Above 1 the body would shed material from its equator. Worth checking when a
 * generated body draws a very short rotation period.
 */
export function equatorialCentrifugalRatio(
  mass: number,
  equatorialRadius: number,
  rotationPeriodSeconds: number,
): number {
  const period = Math.abs(rotationPeriodSeconds);
  if (!(period > 0) || !(mass > 0)) return 0;
  const omega = (2 * Math.PI) / period;
  return (omega * omega * equatorialRadius ** 3) / (G * mass);
}
