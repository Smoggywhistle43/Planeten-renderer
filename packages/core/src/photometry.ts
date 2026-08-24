/**
 * Light in real units.
 *
 * Everything the renderer emits is a luminance in candela per square metre.
 * Nothing is a made-up 0..1 brightness, because the moment one number is made
 * up, every number downstream has to be tuned against it by eye, and the
 * picture stops being predictable.
 *
 * The chain, end to end:
 *
 *   illuminance E  (lux)          sunlight arriving on a surface
 *   x cos(incidence)              how slanted the surface is to the sun
 *   x albedo / pi                 Lambert reflection
 *   = luminance L  (cd/m^2)       what the eye or sensor actually sees
 *
 * three implements exactly that: `lightColor = color * intensity`, then
 * `irradiance = cos * lightColor`, then `diffuse = irradiance * albedo / pi`.
 * So setting a directional light's intensity to an illuminance in lux and a
 * material's colour to a real albedo makes the framebuffer hold cd/m^2, with
 * no correction factor anywhere.
 *
 * The last step is exposure, which is what a camera or an eye does: pick how
 * much of that enormous range to map onto a display. Sunlit ground is around
 * 1.2e4 cd/m^2; the night side without a moon is below 1e-3. No display shows
 * both. See `ev100FromLuminance` and `exposureFromEv100`.
 *
 * No `three` in here: the simulation needs these numbers too, and they are
 * physics rather than rendering.
 */

/** Astronomical unit, metres. Exact by IAU definition since 2012. */
export const ASTRONOMICAL_UNIT = 1.495978707e11;

/** Total solar irradiance at 1 AU, W/m^2. The "solar constant". */
export const SOLAR_CONSTANT = 1361;

/**
 * Solar illuminance at 1 AU, perpendicular to the rays, outside any
 * atmosphere. lux.
 *
 * This is `SOLAR_CONSTANT` weighted by the eye's response — about 93 lumens
 * per watt for the solar spectrum. It is the number the renderer actually
 * uses; the watt figure is here for anything thermal later on.
 */
export const SOLAR_ILLUMINANCE_1AU = 128_000;

/** Radius of the Sun, metres. */
export const SOLAR_RADIUS = 6.957e8;

/** Effective temperature of the Sun's photosphere, kelvin. */
export const SOLAR_TEMPERATURE = 5772;

/**
 * A star, as far as lighting is concerned.
 *
 * Data, like `Body` — no methods, no inheritance.
 */
export interface Star {
  readonly id: string;
  /** Illuminance perpendicular to the rays at 1 AU, outside any atmosphere. lux. */
  readonly illuminanceAt1Au: number;
  /** Radius, metres. Sets the angular size, which sets how soft shadows are. */
  readonly radius: number;
  /** Effective temperature, kelvin. */
  readonly temperature: number;
}

export const SUN: Star = Object.freeze({
  id: 'sol',
  illuminanceAt1Au: SOLAR_ILLUMINANCE_1AU,
  radius: SOLAR_RADIUS,
  temperature: SOLAR_TEMPERATURE,
});

/**
 * Illuminance from a star at a given distance, lux.
 *
 * Inverse square, which is the whole reason a planet at 5 AU is dim.
 */
export function illuminanceAtDistance(star: Star, distanceMetres: number): number {
  if (!(distanceMetres > 0)) {
    throw new RangeError(`illuminanceAtDistance: distance must be positive, got ${distanceMetres}`);
  }
  const ratio = ASTRONOMICAL_UNIT / distanceMetres;
  return star.illuminanceAt1Au * ratio * ratio;
}

/** Angular radius of a star seen from a distance, radians. */
export function angularRadius(star: Star, distanceMetres: number): number {
  if (!(distanceMetres > star.radius)) {
    throw new RangeError('angularRadius: the observer is inside the star');
  }
  return Math.asin(star.radius / distanceMetres);
}

/** Solid angle a star subtends, steradians. */
export function solidAngle(star: Star, distanceMetres: number): number {
  const theta = angularRadius(star, distanceMetres);
  // Spherical cap: 2*pi*(1 - cos(theta)). Exact, and stable for small angles
  // via the half-angle identity, which matters at 1 AU where theta is 0.0047.
  const halfSin = Math.sin(theta / 2);
  return 4 * Math.PI * halfSin * halfSin;
}

/**
 * Luminance of the star's own disc, cd/m^2.
 *
 * About 1.9e9 for the Sun at 1 AU. Worth knowing because it is far beyond what
 * a half-float framebuffer can hold — see the note on `MAX_HALF_FLOAT`.
 */
export function discLuminance(star: Star, distanceMetres: number): number {
  return illuminanceAtDistance(star, distanceMetres) / solidAngle(star, distanceMetres);
}

/**
 * Luminance of a Lambertian surface, cd/m^2.
 *
 * `cosIncidence` is the cosine of the angle between the surface normal and the
 * direction to the light; negative values mean the surface faces away and
 * return zero rather than something unphysical.
 */
export function lambertLuminance(
  illuminance: number,
  cosIncidence: number,
  albedo: number,
): number {
  if (cosIncidence <= 0) return 0;
  return (illuminance * cosIncidence * albedo) / Math.PI;
}

/** Largest value a half-float framebuffer can hold. */
export const MAX_HALF_FLOAT = 65504;

// --------------------------------------------------------------- exposure ---

/**
 * Reflected-light meter calibration constant.
 *
 * 12.5 is what Canon and Nikon use; Sekonic uses 14. It only shifts the whole
 * image, so it is a taste knob dressed as a constant.
 */
export const REFLECTED_LIGHT_CALIBRATION = 12.5;

/** Incident-light meter calibration constant. */
export const INCIDENT_LIGHT_CALIBRATION = 250;

/**
 * Exposure value at ISO 100 that would put the given luminance in the middle
 * of the frame.
 *
 * This is the auto-exposure rule: measure the scene, get an EV, expose for it.
 */
export function ev100FromLuminance(
  luminance: number,
  calibration = REFLECTED_LIGHT_CALIBRATION,
): number {
  if (!(luminance > 0)) return -Infinity;
  return Math.log2((luminance * 100) / calibration);
}

/** The inverse: the luminance a given EV100 is metered for. */
export function luminanceFromEv100(
  ev100: number,
  calibration = REFLECTED_LIGHT_CALIBRATION,
): number {
  return (2 ** ev100 * calibration) / 100;
}

/** Same, from an incident-light reading in lux. */
export function ev100FromIlluminance(
  illuminance: number,
  calibration = INCIDENT_LIGHT_CALIBRATION,
): number {
  if (!(illuminance > 0)) return -Infinity;
  return Math.log2((illuminance * 100) / calibration);
}

export interface CameraSettings {
  /** f-number. Smaller is a wider opening and a brighter image. */
  readonly aperture: number;
  /** Shutter time, seconds. */
  readonly shutterSpeed: number;
  /** Sensor sensitivity. 100 is the reference. */
  readonly iso: number;
}

/**
 * The photographer's daylight rule: f/16 at one over the ISO. It lands on
 * EV 15, which is the canonical table entry for bright sunlight *at the
 * ground*, under the atmosphere, with the sun at a normal elevation.
 *
 * Worth keeping around as a sanity anchor. Above the atmosphere at the
 * sub-solar point it is about a stop too dark, and it should be — there is no
 * air up there absorbing a quarter of the light, and the sun is straight
 * overhead rather than at fifty degrees.
 */
export const SUNNY_16: CameraSettings = Object.freeze({
  aperture: 16,
  shutterSpeed: 1 / 125,
  iso: 100,
});

/**
 * Illuminance on a horizontal surface at sea level on a clear day, sun near
 * the zenith. lux.
 *
 * Lower than `SOLAR_ILLUMINANCE_1AU` because the atmosphere takes its cut.
 * Stage 02 does not model that yet — this constant is here so ground-level
 * intuitions can be checked against the space-side numbers.
 */
export const CLEAR_SKY_SURFACE_ILLUMINANCE = 110_000;

/** Exposure value at ISO 100 for a set of camera settings. */
export function ev100FromCamera(settings: CameraSettings): number {
  const { aperture, shutterSpeed, iso } = settings;
  if (!(aperture > 0) || !(shutterSpeed > 0) || !(iso > 0)) {
    throw new RangeError('ev100FromCamera: aperture, shutter and ISO must all be positive');
  }
  return Math.log2(((aperture * aperture) / shutterSpeed) * (100 / iso));
}

/**
 * The multiplier to apply to a luminance before tone mapping.
 *
 * The 1.2 is the saturation-based sensitivity of a real sensor: the point
 * where it clips rather than the point where it meters. Standard practice, and
 * it is why a scene metered at EV100 lands near 0.104 rather than at the 0.18
 * of a grey card.
 */
export function exposureFromEv100(ev100: number): number {
  return 1 / (1.2 * 2 ** ev100);
}

/** What a luminance becomes after exposure, before tone mapping. */
export function exposeLuminance(luminance: number, ev100: number): number {
  return luminance * exposureFromEv100(ev100);
}

/**
 * Move an exposure towards a target the way an eye does: fast when it gets
 * brighter, slow when it gets darker.
 *
 * The asymmetry is real — walking into a dark room takes far longer than
 * walking out of one — and it is also what stops the image pumping when the
 * camera sweeps across the terminator.
 *
 * `deltaSeconds` is frame time; the speeds are in EV per second.
 */
export function adaptEv100(
  currentEv100: number,
  targetEv100: number,
  deltaSeconds: number,
  brighteningSpeed = 3,
  darkeningSpeed = 1,
): number {
  if (!Number.isFinite(targetEv100)) return currentEv100;
  if (!Number.isFinite(currentEv100)) return targetEv100;

  const rising = targetEv100 > currentEv100;
  const speed = rising ? brighteningSpeed : darkeningSpeed;
  // Exponential approach: framerate-independent, and it never overshoots.
  const blend = 1 - Math.exp(-Math.max(0, deltaSeconds) * speed);
  return currentEv100 + (targetEv100 - currentEv100) * blend;
}

// ----------------------------------------------------------------- albedo ---

/**
 * Reference albedos, as fractions of incident light reflected.
 *
 * These are the numbers a material's colour should be set to. They are
 * measured, not chosen: a renderer that uses 0.8 for grass because it looks
 * nicer has given up on predicting anything.
 */
export const ALBEDO = Object.freeze({
  /** Open ocean, sun high. Rises steeply at grazing angles — Fresnel, later. */
  ocean: 0.06,
  seaIce: 0.6,
  freshSnow: 0.85,
  oldSnow: 0.5,
  desertSand: 0.35,
  bareSoil: 0.17,
  grassland: 0.2,
  deciduousForest: 0.17,
  coniferousForest: 0.1,
  basalt: 0.07,
  granite: 0.3,
  /** Thick cumulus, seen from above. */
  cloud: 0.7,
  /** Earth as a whole, including clouds. The Bond albedo. */
  earthMean: 0.3,
  /** The Moon is far darker than photographs suggest — closer to asphalt. */
  moonMean: 0.12,
  marsMean: 0.25,
} as const);

/**
 * Luminance at the sub-solar point of an airless Lambertian body.
 *
 * The brightest thing a stage-02 render can produce, and therefore the number
 * that decides whether the half-float framebuffer overflows.
 */
export function subsolarLuminance(star: Star, distanceMetres: number, albedo: number): number {
  return lambertLuminance(illuminanceAtDistance(star, distanceMetres), 1, albedo);
}
