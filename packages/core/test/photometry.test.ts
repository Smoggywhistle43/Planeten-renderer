import { describe, expect, it } from 'vitest';
import {
  ALBEDO,
  ASTRONOMICAL_UNIT,
  CLEAR_SKY_SURFACE_ILLUMINANCE,
  MAX_HALF_FLOAT,
  SOLAR_ILLUMINANCE_1AU,
  SUN,
  SUNNY_16,
  adaptEv100,
  angularRadius,
  discLuminance,
  ev100FromCamera,
  ev100FromIlluminance,
  ev100FromLuminance,
  exposeLuminance,
  exposureFromEv100,
  illuminanceAtDistance,
  lambertLuminance,
  luminanceFromEv100,
  solidAngle,
  subsolarLuminance,
} from '../src/photometry.ts';

const EARTH_ORBIT = ASTRONOMICAL_UNIT;

describe('sunlight', () => {
  it('delivers the solar constant at 1 AU', () => {
    expect(illuminanceAtDistance(SUN, EARTH_ORBIT)).toBeCloseTo(SOLAR_ILLUMINANCE_1AU, 6);
  });

  it('falls off with the inverse square', () => {
    expect(illuminanceAtDistance(SUN, 2 * EARTH_ORBIT)).toBeCloseTo(SOLAR_ILLUMINANCE_1AU / 4, 6);
    expect(illuminanceAtDistance(SUN, EARTH_ORBIT / 2)).toBeCloseTo(SOLAR_ILLUMINANCE_1AU * 4, 3);
  });

  it('matches the known illuminance at the other planets', () => {
    // Mars at 1.524 AU: about 55 klx. Jupiter at 5.203 AU: about 4.7 klx.
    expect(illuminanceAtDistance(SUN, 1.524 * EARTH_ORBIT)).toBeCloseTo(55_100, -2);
    expect(illuminanceAtDistance(SUN, 5.203 * EARTH_ORBIT)).toBeCloseTo(4_728, -1);
  });

  it('rejects a non-positive distance', () => {
    expect(() => illuminanceAtDistance(SUN, 0)).toThrow(RangeError);
    expect(() => illuminanceAtDistance(SUN, -1)).toThrow(RangeError);
  });

  it('subtends about half a degree from Earth', () => {
    const radius = angularRadius(SUN, EARTH_ORBIT);
    // The Sun is famously ~0.53 degrees across, so ~0.265 in radius.
    expect((radius * 360) / Math.PI).toBeCloseTo(0.533, 2);
  });

  it('subtends about 6.8e-5 steradians from Earth', () => {
    expect(solidAngle(SUN, EARTH_ORBIT)).toBeCloseTo(6.8e-5, 6);
  });

  it('has a disc luminance around 1.9e9 cd/m2', () => {
    const l = discLuminance(SUN, EARTH_ORBIT);
    expect(l).toBeGreaterThan(1.5e9);
    expect(l).toBeLessThan(2.2e9);
  });

  it('refuses to measure from inside the star', () => {
    expect(() => angularRadius(SUN, SUN.radius / 2)).toThrow(RangeError);
  });
});

describe('Lambert reflection', () => {
  it('reflects illuminance over pi steradians', () => {
    expect(lambertLuminance(Math.PI, 1, 1)).toBeCloseTo(1, 12);
    expect(lambertLuminance(1000, 1, 0.5)).toBeCloseTo(500 / Math.PI, 12);
  });

  it('darkens with the cosine of the incidence angle', () => {
    const straight = lambertLuminance(1000, 1, 0.3);
    const slanted = lambertLuminance(1000, Math.cos(Math.PI / 3), 0.3);
    expect(slanted).toBeCloseTo(straight / 2, 12);
  });

  it('is zero on a surface facing away, not negative', () => {
    expect(lambertLuminance(1000, 0, 0.3)).toBe(0);
    expect(lambertLuminance(1000, -0.5, 0.3)).toBe(0);
  });

  it('puts sunlit Earth around 1.2e4 cd/m2', () => {
    // The number the whole exposure chain is calibrated against.
    const l = subsolarLuminance(SUN, EARTH_ORBIT, ALBEDO.earthMean);
    expect(l).toBeGreaterThan(1.1e4);
    expect(l).toBeLessThan(1.3e4);
  });
});

describe('the half-float ceiling', () => {
  it('leaves headroom for the brightest surface stage 02 can produce', () => {
    // Fresh snow at the sub-solar point is the worst case without an ocean
    // highlight or the sun's own disc in frame.
    const brightest = subsolarLuminance(SUN, EARTH_ORBIT, ALBEDO.freshSnow);
    expect(brightest).toBeLessThan(MAX_HALF_FLOAT);
    // And it is not comfortable headroom — under a factor of two.
    expect(brightest).toBeGreaterThan(MAX_HALF_FLOAT / 4);
  });

  it('cannot hold the sun disc itself, which is why it is not drawn yet', () => {
    expect(discLuminance(SUN, EARTH_ORBIT)).toBeGreaterThan(MAX_HALF_FLOAT);
  });
});

describe('exposure', () => {
  it('round-trips luminance through EV100', () => {
    for (const l of [1e-3, 1, 100, 1.2e4, 1e6]) {
      expect(luminanceFromEv100(ev100FromLuminance(l))).toBeCloseTo(l, 6);
    }
  });

  it('gives sunlit ground roughly EV 15, as a light meter would', () => {
    const ev = ev100FromLuminance(subsolarLuminance(SUN, EARTH_ORBIT, ALBEDO.earthMean));
    expect(ev).toBeGreaterThan(15);
    expect(ev).toBeLessThan(17);
  });

  it('puts the sunny 16 rule on EV 15, where the tables put it', () => {
    expect(ev100FromCamera(SUNNY_16)).toBeCloseTo(15, 1);
  });

  it('agrees with sunny 16 for a ground-level scene', () => {
    // Sunny 16 describes a mid-toned subject at sea level with the sun at a
    // normal elevation. Reproduce that and the physics has to land on the same
    // exposure the rule of thumb gives, or one of the two is wrong.
    const sunElevation = Math.cos((40 * Math.PI) / 180);
    const luminance = lambertLuminance(
      CLEAR_SKY_SURFACE_ILLUMINANCE,
      sunElevation,
      0.18, // a grey card, which is what the rule is calibrated on
    );
    expect(Math.abs(ev100FromLuminance(luminance) - ev100FromCamera(SUNNY_16))).toBeLessThan(0.5);
  });

  it('is about a stop brighter above the atmosphere, and it should be', () => {
    // No air taking a quarter of the light, and the sun straight overhead
    // rather than at forty degrees. If this gap ever closed, something would
    // be quietly applying an atmosphere that stage 02 does not have.
    const inSpace = ev100FromLuminance(subsolarLuminance(SUN, EARTH_ORBIT, 0.18));
    const onTheGround = ev100FromLuminance(
      lambertLuminance(CLEAR_SKY_SURFACE_ILLUMINANCE, Math.cos((40 * Math.PI) / 180), 0.18),
    );
    const stops = inSpace - onTheGround;
    expect(stops).toBeGreaterThan(0.5);
    expect(stops).toBeLessThan(2);
  });

  it('follows the camera triangle', () => {
    const base = ev100FromCamera({ aperture: 8, shutterSpeed: 1 / 125, iso: 100 });
    // Opening one stop, halving the shutter, or doubling ISO each move one EV.
    expect(ev100FromCamera({ aperture: 5.6, shutterSpeed: 1 / 125, iso: 100 })).toBeCloseTo(base - 1, 1);
    expect(ev100FromCamera({ aperture: 8, shutterSpeed: 1 / 250, iso: 100 })).toBeCloseTo(base + 1, 6);
    expect(ev100FromCamera({ aperture: 8, shutterSpeed: 1 / 125, iso: 200 })).toBeCloseTo(base - 1, 6);
  });

  it('rejects impossible camera settings', () => {
    expect(() => ev100FromCamera({ aperture: 0, shutterSpeed: 1, iso: 100 })).toThrow(RangeError);
    expect(() => ev100FromCamera({ aperture: 8, shutterSpeed: 0, iso: 100 })).toThrow(RangeError);
    expect(() => ev100FromCamera({ aperture: 8, shutterSpeed: 1, iso: 0 })).toThrow(RangeError);
  });

  it('lands a correctly metered scene near the middle of the range', () => {
    const luminance = 1.2e4;
    const exposed = exposeLuminance(luminance, ev100FromLuminance(luminance));
    // The saturation-based convention puts it at 1/1.2/8 = 0.104, not 0.18.
    expect(exposed).toBeCloseTo(0.104, 3);
  });

  it('halves the image for every stop of over-exposure', () => {
    const l = 1.2e4;
    const metered = ev100FromLuminance(l);
    expect(exposeLuminance(l, metered + 1)).toBeCloseTo(exposeLuminance(l, metered) / 2, 6);
  });

  it('maps the whole day-to-night range without clipping at either end', () => {
    // Sunlit ground and a moonless night differ by about seven orders of
    // magnitude. Exposed for each in turn, both must land in a usable range.
    const day = subsolarLuminance(SUN, EARTH_ORBIT, ALBEDO.earthMean);
    const night = 1e-3;
    for (const l of [day, night]) {
      const exposed = exposeLuminance(l, ev100FromLuminance(l));
      expect(exposed).toBeGreaterThan(0.05);
      expect(exposed).toBeLessThan(0.5);
    }
  });

  it('reports minus infinity for pure darkness rather than NaN', () => {
    expect(ev100FromLuminance(0)).toBe(-Infinity);
    expect(ev100FromIlluminance(0)).toBe(-Infinity);
    expect(Number.isNaN(exposureFromEv100(10))).toBe(false);
  });
});

describe('eye adaptation', () => {
  it('converges on the target', () => {
    let ev = 5;
    for (let i = 0; i < 600; i++) ev = adaptEv100(ev, 15, 1 / 60);
    expect(ev).toBeCloseTo(15, 3);
  });

  it('brightens faster than it darkens, like an eye', () => {
    const up = adaptEv100(10, 15, 1);
    const down = adaptEv100(10, 5, 1);
    expect(up - 10).toBeGreaterThan(10 - down);
  });

  it('never overshoots, at any frame time', () => {
    for (const dt of [1 / 240, 1 / 60, 1 / 10, 1, 10]) {
      const ev = adaptEv100(5, 15, dt);
      expect(ev).toBeGreaterThanOrEqual(5);
      expect(ev).toBeLessThanOrEqual(15);
    }
  });

  it('reaches the same place regardless of frame rate', () => {
    let fast = 5;
    for (let i = 0; i < 240; i++) fast = adaptEv100(fast, 15, 1 / 240);
    let slow = 5;
    for (let i = 0; i < 30; i++) slow = adaptEv100(slow, 15, 1 / 30);
    expect(fast).toBeCloseTo(slow, 2);
  });

  it('survives a scene with no light in it', () => {
    expect(adaptEv100(12, -Infinity, 1 / 60)).toBe(12);
    expect(adaptEv100(-Infinity, 12, 1 / 60)).toBe(12);
  });

  it('does not move backwards on a zero or negative frame time', () => {
    expect(adaptEv100(10, 15, 0)).toBe(10);
    expect(adaptEv100(10, 15, -1)).toBe(10);
  });
});
