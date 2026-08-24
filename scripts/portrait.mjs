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
