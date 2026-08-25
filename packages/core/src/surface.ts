/**
 * The surface, split into the part that is mechanism and the part that is
 * design.
 *
 * The renderer has to know *that* a body has liquid and ice and bare ground,
 * and how one gives way to another. It has no business deciding what those look
 * like. So this file draws that line and holds both halves of it:
 *
 *   **roles**    — the fixed vocabulary the shader understands. Six of them,
 *                  and adding a seventh is a change to the mechanism.
 *   **palette**  — what each role looks like, and where the transitions sit.
 *                  Plain data: authored, loaded from JSON, swapped at runtime,
 *                  never compiled in.
 *
 * The roles are named for what they *are* rather than for how Earth happens to
 * dress them. `water` is whatever is liquid at the surface — ocean here, molten
 * rock on a body close enough to its star. `ice` is that liquid frozen. A
 * palette that maps `water` to glowing orange and `ice` to black crust turns
 * the same mechanism into a lava world without touching a shader.
 *
 * What decides *which* role applies is temperature and elevation, and that part
 * is mechanism: it is physics, it is testable against real climatology, and it
 * has exactly one implementation, in TSL, in `@planet/field`.
 *
 * A note on the colour numbers. `ALBEDO` in `photometry.ts` holds *broadband*
 * albedos — the fraction of all incoming sunlight a surface returns, which is
 * what energy balance cares about. Palette entries are *visible-band*
 * reflectances split into red, green and blue, which is what a camera sees. The
 * two differ, and for vegetation they differ enormously: a leaf reflects about
 * 12 % of visible light and about 50 % of near-infrared. That gap is the whole
 * basis of vegetation mapping from satellites, and it is why a forest looks
 * dark to the eye and bright to a broadband instrument. Do not mix them up.
 */

/**
 * The fixed vocabulary. Six roles, in the order the shader indexes them.
 *
 * Every one earns its place by producing something visible from orbit that no
 * other role can produce:
 *
 *   water     the liquid surface — the dark, smooth, specular one
 *   ice       that liquid frozen — bright, and it moves with the climate
 *   snow      frozen precipitation on land — what caps mountains
 *   barren    bare ground; the fallback when nothing else applies
 *   arid      dry land — the bright land surface
 *   fertile   wet land — whatever grows there, or its equivalent
 */
export const SURFACE_ROLES = Object.freeze([
  'water',
  'ice',
  'snow',
  'barren',
  'arid',
  'fertile',
] as const);

export type SurfaceRole = (typeof SURFACE_ROLES)[number];

/** How one role looks. Pure appearance — the design half. */
export interface SurfaceAppearance {
  /**
   * Reflectance per channel in linear light, 0..1.
   *
   * Not a colour picked on a screen — the fraction of red, green and blue light
   * the surface sends back. It is handed straight to the renderer, where it
   * turns illuminance into luminance, so a value above 1 would return more
   * light than falls on it.
   */
  readonly albedo: readonly [number, number, number];
  /**
   * 0 is a mirror, 1 is fully diffuse.
   *
   * Below about 0.2 a surface lit by a star produces a highlight bright enough
   * to overflow a half-float framebuffer — see `PALETTE_LIMITS`.
   */
  readonly roughness: number;
}

/**
 * Where one role gives way to another, and how sharply.
 *
 * The design half of the *transitions*. That a coast is where elevation crosses
 * zero is mechanism; how wide that blend is, is a choice, and a wrong one shows
 * up as either a crawling one-pixel coastline or a beach a hundred kilometres
 * across.
 */
export interface SurfaceThresholds {
  /** Metres of elevation over which liquid gives way to land. */
  readonly coastBlendMetres: number;
  /** Kelvin over which land gives way to snow, below freezing. */
  readonly snowBlendKelvin: number;
  /** Kelvin over which liquid gives way to ice, below freezing. */
  readonly iceBlendKelvin: number;
  /** Humidity below which land is fully arid, 0..1. */
  readonly aridBelow: number;
  /** Humidity above which land is fully fertile, 0..1. */
  readonly fertileAbove: number;
  /**
   * How far above freezing it has to be for anything to be fertile, kelvin.
   *
   * Without it, tundra looks like jungle.
   */
  readonly fertileNeedsKelvin: number;
}

/**
 * A complete look for a body: one appearance per role, plus the transitions.
 *
 * This is the artefact a design pass produces. It is data — no code, no
 * behaviour — so it can be written by hand, generated, stored as JSON, checked
 * into the repository, and swapped while the renderer is running.
 */
export interface SurfacePalette {
  /** Human-readable name. Appears in the overlay and in reports. */
  readonly name: string;
  readonly roles: { readonly [K in SurfaceRole]: SurfaceAppearance };
  readonly thresholds: SurfaceThresholds;
}

/**
 * The limits a palette has to stay inside to be renderable.
 *
 * Not taste — arithmetic. A reflectance above 1 breaks conservation of energy,
 * and a roughness low enough to make a mirror overflows the framebuffer.
 */
export const PALETTE_LIMITS = Object.freeze({
  /** Nothing returns more light than falls on it. */
  maxAlbedo: 1,
  /**
   * Below this, a star's reflection exceeds the half-float ceiling of 65 504
   * cd/m^2, writes infinity, and tone-maps to a black hole in the middle of the
   * ocean. At 0.08 the highlight reaches about five million.
   */
  minRoughness: 0.2,
  maxRoughness: 1,
});

function appearance(
  albedo: readonly [number, number, number],
  roughness: number,
): SurfaceAppearance {
  return Object.freeze({ albedo: Object.freeze(albedo), roughness });
}

/**
 * The default palette: Earth, in visible light.
 *
 * Here so a body renders as something recognisable before anyone has designed
 * anything, and so the numbers have a reference to be checked against. It is
 * *a* palette, not *the* palette.
 *
 * The water roughness is not the roughness of water — water is a mirror. It is
 * the roughness of a *sea*: from orbit one pixel covers kilometres, and what
 * the light meets is the slope distribution of the waves. Cox and Munk measured
 * that from sun-glitter photographs in 1954 and found an RMS slope near 0.2 at
 * moderate wind, which is a GGX roughness around 0.5. Close to the surface,
 * where waves are geometry rather than statistics, it has to change again.
 */
export const EARTH_PALETTE: SurfacePalette = Object.freeze({
  name: 'earth',
  roles: Object.freeze({
    water: appearance([0.025, 0.06, 0.12], 0.5),
    ice: appearance([0.58, 0.6, 0.63], 0.6),
    snow: appearance([0.86, 0.86, 0.88], 0.85),
    barren: appearance([0.2, 0.165, 0.13], 0.95),
    arid: appearance([0.43, 0.34, 0.21], 0.9),
    fertile: appearance([0.08, 0.15, 0.05], 1),
  }),
  thresholds: Object.freeze({
    coastBlendMetres: 60,
    snowBlendKelvin: 3,
    iceBlendKelvin: 6,
    aridBelow: 0.3,
    fertileAbove: 0.75,
    fertileNeedsKelvin: 12,
  }),
});

/**
 * Read a palette from unknown data, or say exactly what is wrong with it.
 *
 * The entry point for anything authored outside this package. It rejects rather
 * than repairs, and it reports every problem at once rather than the first: a
 * palette that is half-valid renders as a body that is half-wrong, and finding
 * out which half by looking at it is worse than being told now.
 */
export function parseSurfacePalette(input: unknown): SurfacePalette {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('surface palette: expected an object');
  }
  const data = input as Record<string, unknown>;
  const problems: string[] = [];

  const rawName = data['name'];
  const name = typeof rawName === 'string' && rawName.length > 0 ? rawName : null;
  if (name === null) problems.push('name: expected a non-empty string');

  const rolesInput = data['roles'];
  const roles: Record<string, SurfaceAppearance> = {};
  if (typeof rolesInput !== 'object' || rolesInput === null) {
    problems.push('roles: expected an object with one entry per role');
  } else {
    const table = rolesInput as Record<string, unknown>;
    for (const role of SURFACE_ROLES) {
      const entry = table[role];
      if (typeof entry !== 'object' || entry === null) {
        problems.push(`roles.${role}: missing`);
        continue;
      }
      const fields = entry as Record<string, unknown>;
      const albedo = fields['albedo'];
      const roughness = fields['roughness'];

      let albedoOk = false;
      if (!Array.isArray(albedo) || albedo.length !== 3) {
        problems.push(`roles.${role}.albedo: expected three numbers`);
      } else if (!albedo.every((c) => typeof c === 'number' && Number.isFinite(c))) {
        problems.push(`roles.${role}.albedo: expected three finite numbers`);
      } else if (albedo.some((c) => (c as number) < 0 || (c as number) > PALETTE_LIMITS.maxAlbedo)) {
        problems.push(
          `roles.${role}.albedo: outside 0..${PALETTE_LIMITS.maxAlbedo} — a surface cannot ` +
            'return more light than falls on it',
        );
      } else {
        albedoOk = true;
      }

      let roughnessOk = false;
      if (typeof roughness !== 'number' || !Number.isFinite(roughness)) {
        problems.push(`roles.${role}.roughness: expected a number`);
      } else if (roughness < PALETTE_LIMITS.minRoughness) {
        problems.push(
          `roles.${role}.roughness: ${roughness} is below ${PALETTE_LIMITS.minRoughness}; the ` +
            'star reflection would overflow a half-float framebuffer and render black',
        );
      } else if (roughness > PALETTE_LIMITS.maxRoughness) {
        problems.push(`roles.${role}.roughness: ${roughness} is above ${PALETTE_LIMITS.maxRoughness}`);
      } else {
        roughnessOk = true;
      }

      if (albedoOk && roughnessOk) {
        const [r, g, b] = albedo as number[];
        roles[role] = appearance([r as number, g as number, b as number], roughness as number);
      }
    }
  }

  const rawThresholds = data['thresholds'];
  if (rawThresholds !== undefined && (typeof rawThresholds !== 'object' || rawThresholds === null)) {
    problems.push('thresholds: expected an object');
  }
  const t = (rawThresholds ?? {}) as Record<string, unknown>;
  const defaults = EARTH_PALETTE.thresholds;
  const readThreshold = (key: keyof SurfaceThresholds, low: number, high: number): number => {
    const value = t[key];
    if (value === undefined) return defaults[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`thresholds.${key}: expected a number`);
      return defaults[key];
    }
    if (value < low || value > high) {
      problems.push(`thresholds.${key}: ${value} is outside ${low}..${high}`);
    }
    return value;
  };
  const thresholds: SurfaceThresholds = {
    coastBlendMetres: readThreshold('coastBlendMetres', 0, 100_000),
    snowBlendKelvin: readThreshold('snowBlendKelvin', 0, 100),
    iceBlendKelvin: readThreshold('iceBlendKelvin', 0, 100),
    aridBelow: readThreshold('aridBelow', 0, 1),
    fertileAbove: readThreshold('fertileAbove', 0, 1),
    fertileNeedsKelvin: readThreshold('fertileNeedsKelvin', -100, 100),
  };
  if (thresholds.aridBelow > thresholds.fertileAbove) {
    problems.push(
      `thresholds: aridBelow (${thresholds.aridBelow}) is above fertileAbove ` +
        `(${thresholds.fertileAbove}); dry and wet would overlap`,
    );
  }

  if (problems.length > 0) {
    throw new TypeError(`surface palette is not usable:\n  ${problems.join('\n  ')}`);
  }

  return Object.freeze({
    name: name as string,
    roles: Object.freeze(roles) as SurfacePalette['roles'],
    thresholds: Object.freeze(thresholds),
  });
}

/** A palette as plain JSON-safe data, for writing one out. */
export function surfacePaletteToJson(palette: SurfacePalette): unknown {
  const roles: Record<string, unknown> = {};
  for (const role of SURFACE_ROLES) {
    const a = palette.roles[role];
    roles[role] = { albedo: [...a.albedo], roughness: a.roughness };
  }
  return { name: palette.name, roles, thresholds: { ...palette.thresholds } };
}

/** The albedos as a flat array, in `SURFACE_ROLES` order. Eighteen numbers. */
export function paletteAlbedoTable(palette: SurfacePalette): number[] {
  const out: number[] = [];
  for (const role of SURFACE_ROLES) {
    const [r, g, b] = palette.roles[role].albedo;
    out.push(r, g, b);
  }
  return out;
}

/** The roughness of each role, in `SURFACE_ROLES` order. */
export function paletteRoughnessTable(palette: SurfacePalette): number[] {
  return SURFACE_ROLES.map((role) => palette.roles[role].roughness);
}

/**
 * Broadband reflectance of one appearance, weighted the way vision weights the
 * three channels.
 *
 * For checking a palette entry against the published figures in `ALBEDO`, and
 * for predicting how bright a body will render before rendering it.
 */
export function luminousAlbedo(a: SurfaceAppearance): number {
  const [r, g, b] = a.albedo;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ------------------------------------------------------------- climate ------

/**
 * What decides which role applies where.
 *
 * This half is *not* design. It is one physical idea — **temperature**, which
 * falls towards the poles and falls with altitude — and everything follows from
 * it. Ice caps sit at the poles *and* on the peaks without anything being told
 * to put them there.
 *
 * `equatorTemperature` and `poleTemperature` are prescribed rather than derived
 * from the star. Deriving them needs an orbit, and bodies do not have one yet;
 * when they do, these become the output of a radiative balance instead of a
 * draw. Flagged in STATE.md rather than hidden here.
 */
export interface SurfaceParams {
  /**
   * Where the liquid stands, as a fraction of the terrain amplitude.
   *
   * The height field is far more peaked than its nominal amplitude suggests, so
   * this number is smaller than it looks: 0.081 floods 71 % of the reference
   * body, which is Earth's ocean fraction. Measured, not guessed — see
   * `surface.gpu.test.ts`.
   */
  readonly seaLevelFraction: number;
  /** Mean surface temperature at the equator, at sea level, kelvin. */
  readonly equatorTemperature: number;
  /** Mean surface temperature at the poles, at sea level, kelvin. */
  readonly poleTemperature: number;
  /**
   * How fast temperature falls with height, kelvin per metre.
   *
   * Earth's troposphere averages 6.5 K per kilometre. It is why mountains carry
   * snow at latitudes where the lowland never freezes.
   */
  readonly lapseRate: number;
  /** Spatial frequency of the wet/dry field that separates arid from fertile. */
  readonly humidityFrequency: number;
  /** Domain offset for that field, so it does not line up with the terrain. */
  readonly humidityOffset: readonly [number, number, number];
  /**
   * How far the local climate departs from its latitude, kelvin.
   *
   * Latitude alone gives a planet drawn with a compass: every ice edge a circle
   * and every snow line a contour. Earth is not like that, and the reason is
   * physical — ocean currents and continents move heat sideways. The Gulf
   * Stream keeps northern Norway about 10 K above the zonal mean and ice-free
   * at a latitude where Labrador, the same distance from the pole, freezes.
   *
   * So this is not roughening for its own sake. It is the one term that turns a
   * zonal average into a place, and 8 K is roughly the spread Earth shows.
   */
  readonly temperatureAnomaly: number;
  /** Domain offset for the anomaly field. */
  readonly anomalyOffset: readonly [number, number, number];
}

/** Water freezes at 273.15 K. Not a parameter — a fact about water. */
export const FREEZING_POINT = 273.15;

/** Earth's tropospheric lapse rate, kelvin per metre. */
export const EARTH_LAPSE_RATE = 0.0065;

/**
 * Sea level in metres, relative to the reference surface.
 *
 * The fraction maps onto the terrain amplitude directly. What fraction of the
 * body that floods depends on the height field's distribution, and can only be
 * found by sampling it.
 */
export function seaLevel(params: SurfaceParams, terrainAmplitude: number): number {
  return params.seaLevelFraction * terrainAmplitude;
}

/**
 * Mean surface temperature at a place, kelvin.
 *
 * `sinLatitude` is the sine of the latitude, which is what a direction gives
 * you for free. `elevation` is metres above sea level; below sea level it does
 * not warm the liquid further, so it is clamped.
 *
 * The falloff goes as **the fourth power** of the sine, not the square. Bare
 * insolation goes as the square — that is the standard energy-balance expansion
 * — but the atmosphere and the ocean carry heat polewards, which flattens the
 * profile across the tropics and steepens it near the poles. The fourth power
 * reproduces Earth's observed annual zonal means to within a few kelvin, where
 * the square is 12 K too cold at 45 degrees and puts the ice caps at 47 degrees
 * latitude instead of 60. `surface.test.ts` checks it against the measured
 * profile rather than against a shape someone liked.
 *
 * The renderer does not call this. It is here so the numbers can be checked
 * against real climatology in a Node test; the shader has its own copy of the
 * formula, and a GPU test pins the two together.
 */
export function surfaceTemperature(
  params: SurfaceParams,
  sinLatitude: number,
  elevation: number,
): number {
  const drop = params.equatorTemperature - params.poleTemperature;
  const s2 = sinLatitude * sinLatitude;
  const atSeaLevel = params.equatorTemperature - drop * s2 * s2;
  return atSeaLevel - params.lapseRate * Math.max(0, elevation);
}

/**
 * How high the snow line sits at a given latitude, metres above sea level.
 *
 * Negative means the liquid itself freezes. Infinite means it never snows
 * there. On Earth this runs from about 5000 m at the equator to sea level
 * around 60 degrees, which is roughly what this produces.
 */
export function snowLine(params: SurfaceParams, sinLatitude: number): number {
  const seaLevelTemperature = surfaceTemperature(params, sinLatitude, 0);
  if (params.lapseRate <= 0) {
    return seaLevelTemperature <= FREEZING_POINT ? -Infinity : Infinity;
  }
  return (seaLevelTemperature - FREEZING_POINT) / params.lapseRate;
}
