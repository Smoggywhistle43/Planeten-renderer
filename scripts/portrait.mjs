#!/usr/bin/env node
/**
 * Take pictures of the planet. Not a gate — a way to look at it.
 *
 * `pnpm acceptance` answers "is it broken". This answers "does it look right",
 * which is the only question that matters for a hyperrealistic renderer and the
 * one no assertion can settle.
 *
 * It renders a set of viewpoints into `artifacts/portrait/`, including the shot
 * that actually shows whether the lighting works: the sun off to the side, so
 * the terminator is in frame. A fully lit disc with the sun behind the camera
 * hides every mistake.
 *
 * Usage:  pnpm portrait  [--headed]
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARTIFACTS,
  buildExplorer,
  openExplorer,
  setChromeVisible,
  stepFrames,
} from './lib/explorer-page.mjs';

const HEADED = process.argv.includes('--headed');
const OUT = join(ARTIFACTS, 'portrait');
const VIEWPORT = { width: 1280, height: 800 };

/**
 * Sun directions, as the angle between the sun and the camera's line of sight.
 *
 * 0 degrees is the sun directly behind the camera: a flat, fully lit disc, and
 * the least informative picture a planet renderer can produce. Everything
 * interesting happens past 60.
 */
function sunAtPhaseAngle(degrees) {
  // The camera always sits on +X looking towards the origin. Rotate the sun
  // away from that axis in the XZ plane, tilted a little for a natural look.
  const a = (degrees * Math.PI) / 180;
  return [Math.cos(a), 0.25, Math.sin(a)];
}

const SHOTS = [
  {
    name: '01-voll-beleuchtet',
    caption: 'Sonne hinter der Kamera. Volle Scheibe, kein Terminator.',
    altitude: 2.0e7,
    phaseDegrees: 0,
    tilt: 0,
  },
  {
    name: '02-terminator',
    caption: 'Sonne 75 Grad seitlich. Der Übergang von Tag zu Nacht.',
    altitude: 2.0e7,
    phaseDegrees: 75,
    tilt: 0,
  },
  {
    name: '03-sichel',
    caption: 'Sonne 130 Grad seitlich. Schmale Sichel, fast Gegenlicht.',
    altitude: 2.0e7,
    phaseDegrees: 130,
    tilt: 0,
  },
  {
    name: '04-nah-terminator',
    caption: 'Näher dran, Sonne seitlich. Hier zeigt sich der Terminator im Detail.',
    altitude: 2.0e6,
    phaseDegrees: 80,
    tilt: 0,
  },
  {
    name: '05-horizont',
    caption: 'Tief, Blick zum Horizont. Ohne Atmosphäre eine harte Kante gegen Schwarz.',
    altitude: 5.0e4,
    phaseDegrees: 55,
    tilt: 0.85,
  },
];

/** The same shot at several exposures, to show what exposure actually does. */
const EXPOSURE_LADDER = [-4, -2, 0, 2, 4];

/**
 * The rotation, as four moments of one day.
 *
 * A featureless grey ellipsoid cannot show that it turns: with a fixed camera
 * and a fixed sun, every hour looks exactly alike. So this series switches the
 * height field on — the relief is what carries the rotation — and **exaggerates
 * it far past anything real**: 240 km of it, where Earth's true range from the
 * Mariana Trench to Everest is 20 km. At true scale the relief is a fifth of a
 * percent of the radius and simply invisible from here.
 *
 * That exaggeration is the whole point of the series and has to be said out
 * loud in the caption. What the ground actually looks like is Teil 2.4; this
 * only shows that it turns with the body instead of sliding across it.
 *
 * A sidereal day is 86 164 s; these are four moments spread across one.
 */
const DAY_SECONDS = 86_164.0905;
const ROTATION_SERIES = [0, 0.25, 0.5, 0.75];
const ROTATION_RELIEF_SCALE = 20;
const ROTATION_PHASE_DEGREES = 62;

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  buildExplorer(log);
  const { page, close } = await openExplorer({ viewport: VIEWPORT, headless: !HEADED, log });

  const index = [];

  try {
    await page.evaluate(
      ([w, h]) => window.__planet.setSize(w, h, 1),
      [VIEWPORT.width, VIEWPORT.height],
    );
    await page.evaluate(() => window.__planet.setFlightRunning(false));
    await setChromeVisible(page, false);

    const metered = await page.evaluate(() => window.__planet.meteredEv100());
    log(`gemessene Belichtung: EV ${metered.toFixed(2)}`);

    for (const shot of SHOTS) {
      log(`${shot.name} …`);
      const sun = sunAtPhaseAngle(shot.phaseDegrees);
      await page.evaluate((s) => window.__planet.setSunDirection(s[0], s[1], s[2]), sun);
      await page.evaluate((a) => window.__planet.setAltitude(a), shot.altitude);
      await page.evaluate((t) => window.__planet.setTilt(t), shot.tilt);
      await page.evaluate((ev) => window.__planet.setEv100(ev), metered);
      await stepFrames(page, 240);

      const file = join(OUT, `${shot.name}.png`);
      await page.screenshot({ path: file });
      index.push({ ...shot, file: `${shot.name}.png`, ev100: metered });
    }

    // The exposure ladder, on the terminator shot, because that is where over-
    // and under-exposure are most obvious.
    const ladderShot = SHOTS[1];
    const sun = sunAtPhaseAngle(ladderShot.phaseDegrees);
    await page.evaluate((s) => window.__planet.setSunDirection(s[0], s[1], s[2]), sun);
    await page.evaluate((a) => window.__planet.setAltitude(a), ladderShot.altitude);
    await page.evaluate((t) => window.__planet.setTilt(t), ladderShot.tilt);
    await stepFrames(page, 120);

    for (const stops of EXPOSURE_LADDER) {
      const label = stops === 0 ? 'gemessen' : `${stops > 0 ? '+' : ''}${stops}`;
      log(`belichtung ${label} …`);
      await page.evaluate((ev) => window.__planet.setEv100(ev), metered + stops);
      await stepFrames(page, 8);
      const name = `belichtung-${stops >= 0 ? 'p' : 'm'}${Math.abs(stops)}`;
      await page.screenshot({ path: join(OUT, `${name}.png`) });
      index.push({
        name,
        caption: `Terminator, ${label} — ${stops > 0 ? 'dunkler' : stops < 0 ? 'heller' : 'wie gemessen'}`,
        altitude: ladderShot.altitude,
        phaseDegrees: ladderShot.phaseDegrees,
        file: `${name}.png`,
        ev100: metered + stops,
      });
    }

    // ---- the rotation, over one day -------------------------------------
    const rotationSun = sunAtPhaseAngle(ROTATION_PHASE_DEGREES);
    await page.evaluate((sun) => window.__planet.setSunDirection(sun[0], sun[1], sun[2]), rotationSun);
    await page.evaluate(() => window.__planet.setAltitude(1.2e7));
    await page.evaluate(() => window.__planet.setTilt(0));
    await page.evaluate((k) => window.__planet.setHeightScale(k), ROTATION_RELIEF_SCALE);
    await page.evaluate((ev) => window.__planet.setEv100(ev), metered);

    for (const fraction of ROTATION_SERIES) {
      const hours = fraction * 24;
      const name = `drehung-${String(Math.round(hours)).padStart(2, '0')}h`;
      log(`${name} …`);
      await page.evaluate((seconds) => window.__planet.setTime(seconds), fraction * DAY_SECONDS);
      await stepFrames(page, 200);
      await page.screenshot({ path: join(OUT, `${name}.png`) });
      index.push({
        name,
        caption:
          `Nach ${hours.toFixed(0)} Stunden. Gleiche Kamera, gleiche Sonne — nur der Körper hat ` +
          'sich gedreht. Relief 20-fach überhöht (240 km), sonst wäre nichts zu sehen.',
        altitude: 1.2e7,
        phaseDegrees: ROTATION_PHASE_DEGREES,
        file: `${name}.png`,
        ev100: metered,
      });
    }

    // ---- the shape, over the pole ---------------------------------------
    // Straight down the rotation axis, where a flattened body shows its short
    // radius and a sphere would look identical to every other view.
    log('06-pol …');
    await page.evaluate(() => window.__planet.setHeightScale(0));
    await page.evaluate(() => window.__planet.setTime(0));
    await page.evaluate((sun) => window.__planet.setSunDirection(sun[0], sun[1], sun[2]), [0.3, 0.9, 0.3]);
    await page.evaluate(() => window.__planet.setAltitude(1.2e7));
    await stepFrames(page, 240);
    await page.screenshot({ path: join(OUT, '06-pol.png') });
    index.push({
      name: '06-pol',
      caption: 'Sonne fast von oben. Die Achsneigung von 23.4 Grad steht im Bild.',
      altitude: 1.2e7,
      phaseDegrees: 0,
      file: '06-pol.png',
      ev100: metered,
    });

    await setChromeVisible(page, true);
  } finally {
    await close();
  }

  writeFileSync(join(OUT, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  writeFileSync(
    join(OUT, 'README.md'),
    [
      '# Ansichten',
      '',
      'Erzeugt mit `pnpm portrait`. Kein Gatter — nur Bilder zum Anschauen.',
      '',
      ...index.map((s) => `- **${s.file}** — ${s.caption} (Höhe ${s.altitude.toExponential(1)} m, EV ${s.ev100.toFixed(2)})`),
      '',
    ].join('\n'),
  );
  log(`\n${index.length} Bilder in ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
