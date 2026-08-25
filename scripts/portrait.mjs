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
  captureCanvas,
  openExplorer,
  setChromeVisible,
  stepFrames,
} from './lib/explorer-page.mjs';

const HEADED = process.argv.includes('--headed');
const OUT = join(ARTIFACTS, 'portrait');
const VIEWPORT = { width: 1280, height: 800 };

/**
 * Point the sun a given angle away from the camera's line of sight.
 *
 * 0 degrees is the sun directly behind the camera: a flat, fully lit disc, and
 * the least informative picture a planet renderer can produce. Everything
 * interesting happens past 60.
 *
 * The harness does the maths, because it knows where the camera actually is.
 * This used to assume the camera sat on +X, which stopped being true the moment
 * the flight path changed and turned every portrait into a night-side picture
 * without anything reporting a problem.
 */
async function setSunAtPhase(page, degrees) {
  await page.evaluate((d) => window.__planet.setSunAtPhaseAngle(d), degrees);
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
    // True scale relief everywhere except the rotation series, which says so.
    await page.evaluate(() => window.__planet.setHeightScale(1));

    const metered = await page.evaluate(() => window.__planet.meteredEv100());
    log(`gemessene Belichtung: EV ${metered.toFixed(2)}`);

    for (const shot of SHOTS) {
      log(`${shot.name} …`);
      await page.evaluate((a) => window.__planet.setAltitude(a), shot.altitude);
      await page.evaluate((t) => window.__planet.setTilt(t), shot.tilt);
      // After the camera is in place: the phase angle is measured from where it
      // actually ended up.
      await page.evaluate(() => window.__planet.renderFrame(0));
      await setSunAtPhase(page, shot.phaseDegrees);
      await page.evaluate((ev) => window.__planet.setEv100(ev), metered);
      await stepFrames(page, 240);

      const file = join(OUT, `${shot.name}.png`);
      await captureCanvas(page, file);
      index.push({ ...shot, file: `${shot.name}.png`, ev100: metered });
    }

    // The exposure ladder, on the terminator shot, because that is where over-
    // and under-exposure are most obvious.
    const ladderShot = SHOTS[1];
    await page.evaluate((a) => window.__planet.setAltitude(a), ladderShot.altitude);
    await page.evaluate((t) => window.__planet.setTilt(t), ladderShot.tilt);
    await page.evaluate(() => window.__planet.renderFrame(0));
    await setSunAtPhase(page, ladderShot.phaseDegrees);
    await stepFrames(page, 120);

    for (const stops of EXPOSURE_LADDER) {
      const label = stops === 0 ? 'gemessen' : `${stops > 0 ? '+' : ''}${stops}`;
      log(`belichtung ${label} …`);
      await page.evaluate((ev) => window.__planet.setEv100(ev), metered + stops);
      await stepFrames(page, 8);
      const name = `belichtung-${stops >= 0 ? 'p' : 'm'}${Math.abs(stops)}`;
      await captureCanvas(page, join(OUT, `${name}.png`));
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
    await page.evaluate(() => window.__planet.setAltitude(1.2e7));
    await page.evaluate(() => window.__planet.setTilt(0));
    await page.evaluate(() => window.__planet.renderFrame(0));
    await setSunAtPhase(page, ROTATION_PHASE_DEGREES);
    await page.evaluate((k) => window.__planet.setHeightScale(k), ROTATION_RELIEF_SCALE);
    await page.evaluate((ev) => window.__planet.setEv100(ev), metered);

    for (const fraction of ROTATION_SERIES) {
      const hours = fraction * 24;
      const name = `drehung-${String(Math.round(hours)).padStart(2, '0')}h`;
      log(`${name} …`);
      await page.evaluate((seconds) => window.__planet.setTime(seconds), fraction * DAY_SECONDS);
      await stepFrames(page, 200);
      await captureCanvas(page, join(OUT, `${name}.png`));
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
    await page.evaluate(() => window.__planet.setHeightScale(1));
    await page.evaluate(() => window.__planet.setTime(0));
    // Over the pole, not merely lit from above: the camera itself moves there.
    await page.evaluate(() => window.__planet.setLatitude(Math.PI / 2));
    await page.evaluate(() => window.__planet.setAltitude(1.2e7));
    await page.evaluate(() => window.__planet.renderFrame(0));
    await page.evaluate(() => window.__planet.setSunAtPhaseAngle(35, 0));
    await stepFrames(page, 240);
    await captureCanvas(page, join(OUT, '06-pol.png'));
    index.push({
      name: '06-pol',
      caption:
        'Von oben auf die Drehachse. Hier zeigt sich die Eiskappe als Kappe und ' +
        'nicht als Streifen am Rand.',
      altitude: 1.2e7,
      phaseDegrees: 35,
      file: '06-pol.png',
      ev100: metered,
    });
    await page.evaluate(() => window.__planet.setLatitude(0.34));

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
