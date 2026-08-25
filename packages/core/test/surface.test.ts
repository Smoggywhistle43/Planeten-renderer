import { describe, expect, it } from 'vitest';
import { ALBEDO } from '../src/photometry.ts';
import { makeBody, referenceBody } from '../src/body.ts';
import {
  EARTH_LAPSE_RATE,
  EARTH_PALETTE,
  FREEZING_POINT,
  PALETTE_LIMITS,
  SURFACE_ROLES,
  luminousAlbedo,
  paletteAlbedoTable,
  paletteRoughnessTable,
  parseSurfacePalette,
  seaLevel,
  snowLine,
  surfacePaletteToJson,
  surfaceTemperature,
  type SurfaceParams,
  type SurfaceRole,
} from '../src/surface.ts';

const EARTH_CLIMATE: SurfaceParams = {
  seaLevelFraction: 0.32,
  equatorTemperature: 300,
  poleTemperature: 250,
  lapseRate: EARTH_LAPSE_RATE,
  humidityFrequency: 1.6,
  humidityOffset: [0, 0, 0],
  temperatureAnomaly: 8,
  anomalyOffset: [37, -12, 91],
};

const sinOf = (degrees: number): number => Math.sin((degrees * Math.PI) / 180);

describe('the default palette', () => {
  it('gives every role a reflectance a real surface could have', () => {
    for (const role of SURFACE_ROLES) {
      const a = EARTH_PALETTE.roles[role];
      for (const channel of a.albedo) {
        expect(channel).toBeGreaterThan(0);
        expect(channel).toBeLessThanOrEqual(PALETTE_LIMITS.maxAlbedo);
      }
      expect(a.roughness).toBeGreaterThanOrEqual(PALETTE_LIMITS.minRoughness);
      expect(a.roughness).toBeLessThanOrEqual(PALETTE_LIMITS.maxRoughness);
    }
  });

  it('agrees with the published broadband albedos, where the bands overlap', () => {
    const of = (role: SurfaceRole): number => luminousAlbedo(EARTH_PALETTE.roles[role]);
    expect(of('water')).toBeCloseTo(ALBEDO.ocean, 1);
    expect(of('ice')).toBeCloseTo(ALBEDO.seaIce, 1);
    expect(of('snow')).toBeCloseTo(ALBEDO.freshSnow, 1);
    expect(of('arid')).toBeCloseTo(ALBEDO.desertSand, 1);
    expect(of('barren')).toBeCloseTo(ALBEDO.bareSoil, 1);
  });

  it('makes fertile ground darker in visible light than its broadband albedo', () => {
    // Not an error: a leaf reflects about half of near-infrared and about an
    // eighth of visible light. The broadband figure averages the two; a camera
    // only sees the second. If this ever "agrees", someone has mixed the tables.
    expect(luminousAlbedo(EARTH_PALETTE.roles.fertile)).toBeLessThan(ALBEDO.deciduousForest);
  });

  it('spans the range that makes a body legible from orbit', () => {
    const values = SURFACE_ROLES.map((r) => luminousAlbedo(EARTH_PALETTE.roles[r]));
    // Ocean to snow is about a factor of fourteen on Earth. Every visible
    // feature of a planet from space is that contrast.
    expect(Math.max(...values) / Math.min(...values)).toBeGreaterThan(10);
  });

  it('gives the liquid a wave-slope roughness, not a mirror finish', () => {
    // Cox and Munk, 1954: RMS wave slope near 0.2 at moderate wind, a GGX
    // roughness around 0.5. Below about 0.2 the star's reflection overflows a
    // half-float framebuffer and tone-maps to a black hole.
    expect(EARTH_PALETTE.roles.water.roughness).toBeGreaterThan(0.3);
    expect(EARTH_PALETTE.roles.water.roughness).toBeLessThan(0.7);
  });

  it('lays the tables out flat in the order the shader indexes them', () => {
    const albedo = paletteAlbedoTable(EARTH_PALETTE);
    const roughness = paletteRoughnessTable(EARTH_PALETTE);
    expect(albedo).toHaveLength(SURFACE_ROLES.length * 3);
    expect(roughness).toHaveLength(SURFACE_ROLES.length);
    SURFACE_ROLES.forEach((role, i) => {
      expect(albedo.slice(i * 3, i * 3 + 3)).toEqual([...EARTH_PALETTE.roles[role].albedo]);
      expect(roughness[i]).toBe(EARTH_PALETTE.roles[role].roughness);
    });
  });

  it('keeps dry and wet from overlapping', () => {
    expect(EARTH_PALETTE.thresholds.aridBelow).toBeLessThan(
      EARTH_PALETTE.thresholds.fertileAbove,
    );
  });
});

describe('reading an authored palette', () => {
  /** The default, round-tripped through JSON — what an author starts from. */
  const asJson = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(surfacePaletteToJson(EARTH_PALETTE))) as Record<string, unknown>;

  it('round-trips the default without changing a number', () => {
    const back = parseSurfacePalette(asJson());
    expect(back.name).toBe(EARTH_PALETTE.name);
    expect(back.thresholds).toEqual(EARTH_PALETTE.thresholds);
    for (const role of SURFACE_ROLES) {
      expect(back.roles[role].albedo).toEqual(EARTH_PALETTE.roles[role].albedo);
      expect(back.roles[role].roughness).toBe(EARTH_PALETTE.roles[role].roughness);
    }
  });

  it('accepts a palette that is nothing like Earth', () => {
    // The point of the whole split: `water` is whatever is liquid at the
    // surface. Mapped to molten rock, the same mechanism renders a lava world.
    const lava = asJson();
    (lava['name'] as unknown) = 'lava';
    (lava['roles'] as Record<string, unknown>)['water'] = {
      albedo: [0.9, 0.35, 0.05],
      roughness: 0.7,
    };
    (lava['roles'] as Record<string, unknown>)['ice'] = {
      albedo: [0.04, 0.035, 0.03],
      roughness: 0.95,
    };
    const parsed = parseSurfacePalette(lava);
    expect(parsed.name).toBe('lava');
    expect(parsed.roles.water.albedo[0]).toBeCloseTo(0.9, 6);
    // And it stays inside the physics: still nothing above 1, still not a mirror.
    expect(luminousAlbedo(parsed.roles.water)).toBeLessThanOrEqual(1);
  });

  it('fills in thresholds that were left out', () => {
    const partial = asJson();
    delete partial['thresholds'];
    expect(parseSurfacePalette(partial).thresholds).toEqual(EARTH_PALETTE.thresholds);
  });

  it('refuses a surface that returns more light than falls on it', () => {
    const impossible = asJson();
    (impossible['roles'] as Record<string, unknown>)['snow'] = {
      albedo: [1.4, 1.4, 1.4],
      roughness: 0.9,
    };
    expect(() => parseSurfacePalette(impossible)).toThrow(/more light than falls on it/);
  });

  it('refuses a mirror, and says why', () => {
    // The failure that cost a debugging session: roughness 0.08 put a black
    // hole in the middle of the ocean. The message has to name the reason, not
    // just the bound.
    const mirror = asJson();
    (mirror['roles'] as Record<string, unknown>)['water'] = {
      albedo: [0.02, 0.05, 0.1],
      roughness: 0.08,
    };
    expect(() => parseSurfacePalette(mirror)).toThrow(/overflow a half-float framebuffer/);
  });

  it('refuses a missing role by name', () => {
    const short = asJson();
    delete (short['roles'] as Record<string, unknown>)['fertile'];
    expect(() => parseSurfacePalette(short)).toThrow(/roles\.fertile: missing/);
  });

  it('refuses dry and wet that overlap', () => {
    const crossed = asJson();
    (crossed['thresholds'] as Record<string, unknown>)['aridBelow'] = 0.9;
    (crossed['thresholds'] as Record<string, unknown>)['fertileAbove'] = 0.2;
    expect(() => parseSurfacePalette(crossed)).toThrow(/dry and wet would overlap/);
  });

  it('reports every problem at once, not just the first', () => {
    // A palette that is half-valid renders as a body that is half-wrong, and
    // finding out which half by looking at it is worse than being told now.
    const broken = asJson();
    (broken['name'] as unknown) = '';
    delete (broken['roles'] as Record<string, unknown>)['snow'];
    (broken['roles'] as Record<string, unknown>)['arid'] = {
      albedo: [2, 0, 0],
      roughness: 0.01,
    };
    let message = '';
    try {
      parseSurfacePalette(broken);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/name/);
    expect(message).toMatch(/roles\.snow/);
    expect(message).toMatch(/roles\.arid\.albedo/);
    expect(message).toMatch(/roles\.arid\.roughness/);
  });

  it('refuses anything that is not an object', () => {
    for (const bad of [null, 42, 'earth', [], undefined]) {
      expect(() => parseSurfacePalette(bad)).toThrow(TypeError);
    }
  });
});

describe('the temperature model, against Earth', () => {
  /**
   * Observed annual-mean zonal surface air temperature, kelvin.
   *
   * These are the numbers the model has to hit. They are why the latitude
   * falloff is the fourth power of the sine rather than the square: bare
   * insolation gives the square, but the atmosphere and the ocean carry heat
   * polewards, which flattens the tropics and steepens the high latitudes.
   */
  const OBSERVED: ReadonlyArray<readonly [number, number]> = [
    [0, 300],
    [15, 299],
    [30, 294],
    [45, 283],
    [60, 272],
    [75, 258],
    [90, 250],
  ];

  it('reproduces the observed profile to within 6 kelvin', () => {
    for (const [degrees, observed] of OBSERVED) {
      const modelled = surfaceTemperature(EARTH_CLIMATE, sinOf(degrees), 0);
      expect(Math.abs(modelled - observed)).toBeLessThan(6);
    }
  });

  it('beats the plain insolation shape it replaces', () => {
    // The square-of-sine version, for comparison. It is 12 K too cold at 45
    // degrees, which is what dragged the ice caps down to 47 degrees latitude.
    const square = (degrees: number): number => {
      const s = sinOf(degrees);
      return 300 - 50 * s * s;
    };
    let modelError = 0;
    let squareError = 0;
    for (const [degrees, observed] of OBSERVED) {
      modelError += Math.abs(surfaceTemperature(EARTH_CLIMATE, sinOf(degrees), 0) - observed);
      squareError += Math.abs(square(degrees) - observed);
    }
    expect(modelError).toBeLessThan(squareError / 2);
    expect(Math.abs(square(45) - 283)).toBeGreaterThan(7);
  });

  it('is symmetric about the equator', () => {
    for (const degrees of [10, 35, 60, 85]) {
      expect(surfaceTemperature(EARTH_CLIMATE, sinOf(degrees), 0)).toBeCloseTo(
        surfaceTemperature(EARTH_CLIMATE, sinOf(-degrees), 0),
        9,
      );
    }
  });

  it('falls monotonically from equator to pole', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let degrees = 0; degrees <= 90; degrees += 5) {
      const t = surfaceTemperature(EARTH_CLIMATE, sinOf(degrees), 0);
      expect(t).toBeLessThanOrEqual(previous + 1e-9);
      previous = t;
    }
  });

  it('hits the endpoints exactly', () => {
    expect(surfaceTemperature(EARTH_CLIMATE, 0, 0)).toBe(300);
    expect(surfaceTemperature(EARTH_CLIMATE, 1, 0)).toBeCloseTo(250, 9);
  });

  it('cools with height at the tropospheric lapse rate', () => {
    const sea = surfaceTemperature(EARTH_CLIMATE, 0, 0);
    const everest = surfaceTemperature(EARTH_CLIMATE, 0, 8849);
    expect(sea - everest).toBeCloseTo(8849 * EARTH_LAPSE_RATE, 6);
    // About 57 K colder at the summit. That is why it carries snow on the
    // equator side of the Himalaya.
    expect(sea - everest).toBeGreaterThan(50);
  });

  it('does not warm the sea floor', () => {
    // Below sea level the elevation term is clamped: a trench is not hotter
    // than the surface above it.
    expect(surfaceTemperature(EARTH_CLIMATE, 0, -11_000)).toBe(
      surfaceTemperature(EARTH_CLIMATE, 0, 0),
    );
  });
});

describe('the snow line', () => {
  it('sits near 5 km at the equator, as it does on Earth', () => {
    // The tropical snow line runs about 4500 to 5500 m — Kilimanjaro and the
    // high Andes are the visible evidence.
    const line = snowLine(EARTH_CLIMATE, 0);
    expect(line).toBeGreaterThan(3500);
    expect(line).toBeLessThan(5500);
  });

  it('reaches sea level around 60 degrees, not 47', () => {
    expect(snowLine(EARTH_CLIMATE, sinOf(45))).toBeGreaterThan(0);
    expect(snowLine(EARTH_CLIMATE, sinOf(70))).toBeLessThan(0);
    // Somewhere in between it crosses zero, and where matters: it sets how much
    // of the body is under ice.
    let crossing = 90;
    for (let d = 0; d <= 90; d += 0.5) {
      if (snowLine(EARTH_CLIMATE, sinOf(d)) <= 0) {
        crossing = d;
        break;
      }
    }
    expect(crossing).toBeGreaterThan(54);
    expect(crossing).toBeLessThan(66);
  });

  it('falls monotonically towards the poles', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let d = 0; d <= 90; d += 5) {
      const line = snowLine(EARTH_CLIMATE, sinOf(d));
      expect(line).toBeLessThanOrEqual(previous + 1e-6);
      previous = line;
    }
  });

  it('never comes down at all on a body that stays above freezing', () => {
    const warm: SurfaceParams = { ...EARTH_CLIMATE, poleTemperature: 290 };
    expect(snowLine(warm, 1)).toBeGreaterThan(0);
  });

  it('is below sea level everywhere on a frozen body', () => {
    const frozen: SurfaceParams = {
      ...EARTH_CLIMATE,
      equatorTemperature: 230,
      poleTemperature: 200,
    };
    for (const d of [0, 30, 60, 90]) {
      expect(snowLine(frozen, sinOf(d))).toBeLessThan(0);
    }
  });

  it('is a straight answer when nothing cools with height', () => {
    const isothermal: SurfaceParams = { ...EARTH_CLIMATE, lapseRate: 0 };
    expect(snowLine(isothermal, 0)).toBe(Infinity);
    expect(snowLine({ ...isothermal, equatorTemperature: 200 }, 0)).toBe(-Infinity);
  });
});

describe('sea level', () => {
  it('scales with the relief it is measured against', () => {
    expect(seaLevel(EARTH_CLIMATE, 9000)).toBeCloseTo(0.32 * 9000, 9);
    expect(seaLevel(EARTH_CLIMATE, 0)).toBe(0);
  });

  it('is below the reference surface when the fraction is negative', () => {
    expect(seaLevel({ ...EARTH_CLIMATE, seaLevelFraction: -0.8 }, 5000)).toBeLessThan(0);
  });
});

describe('a generated body carries a surface', () => {
  it('draws one for every class, inside its own range', () => {
    for (const seed of [1, 2, 7, 42, 20_250_825]) {
      const body = makeBody(seed);
      const s = body.surface;
      expect(s.equatorTemperature).toBeGreaterThan(s.poleTemperature);
      expect(s.lapseRate).toBeGreaterThan(0);
      expect(s.seaLevelFraction).toBeGreaterThanOrEqual(-1);
      expect(s.seaLevelFraction).toBeLessThanOrEqual(1);
      expect(s.humidityFrequency).toBeGreaterThan(0);
      expect(s.humidityOffset).toHaveLength(3);
    }
  });

  it('freezes an ice world from pole to equator', () => {
    const ice = makeBody(3, { bodyClass: 'ice' });
    expect(surfaceTemperature(ice.surface, 0, 0)).toBeLessThan(FREEZING_POINT);
  });

  it('gives a desert world no sea to speak of', () => {
    const desert = makeBody(5, { bodyClass: 'desert' });
    expect(desert.surface.seaLevelFraction).toBeLessThan(0);
    expect(surfaceTemperature(desert.surface, 0, 0)).toBeGreaterThan(FREEZING_POINT + 20);
  });

  it('floods an ocean world further than Earth, and a desert not at all', () => {
    // Against Earth rather than against a raw number: the fraction is a
    // position in the height field's distribution, and what it floods depends
    // on that distribution. Earth's 0.081 is 71 % ocean.
    const earth = referenceBody().surface.seaLevelFraction;
    for (const seed of [9, 21, 404]) {
      expect(makeBody(seed, { bodyClass: 'ocean' }).surface.seaLevelFraction).toBeGreaterThan(
        earth,
      );
      expect(makeBody(seed, { bodyClass: 'desert' }).surface.seaLevelFraction).toBeLessThan(0);
      expect(makeBody(seed, { bodyClass: 'moon' }).surface.seaLevelFraction).toBeLessThan(
        makeBody(seed, { bodyClass: 'desert' }).surface.seaLevelFraction,
      );
    }
  });

  it('keeps the ground independent of the shape', () => {
    // The surface draws from the surface seed. Two bodies that differ only in
    // the fields the *body* seed feeds must still get the same ground, or
    // re-rolling a mountain range would repaint the continents.
    const a = makeBody(11);
    const b = makeBody(11, { overrides: { rotationPeriod: 12_345 } });
    expect(b.surface).toEqual(a.surface);
  });

  it('gives the reference body the climate of Earth', () => {
    const earth = referenceBody();
    expect(earth.surface.equatorTemperature).toBe(300);
    expect(earth.surface.poleTemperature).toBe(250);
    expect(earth.surface.lapseRate).toBe(EARTH_LAPSE_RATE);
  });
});
