/**
 * Golden tests for stage 01.
 *
 * A fixed seed goes in, a JSON snapshot of every generated parameter comes out.
 * Two independent guards:
 *
 *   1. `toMatchFileSnapshot` against `golden/stage-01.json`, which is committed.
 *      Regenerating it (`pnpm test -u`) produces a visible diff.
 *   2. A checksum written into this file by hand. Regenerating the snapshot does
 *      not update it — somebody has to type the new number, and record the
 *      change in STATE.md.
 *
 * Any change to `hash.ts` or to the generation in `body.ts` breaks both. That is
 * the point. See STATE.md, "Snapshots und Checksummen".
 */

import { describe, expect, it } from 'vitest';
import { hash } from '../src/hash.ts';
import {
  escapeVelocity,
  makeBody,
  meanDensity,
  referenceBody,
  surfaceGravity,
} from '../src/body.ts';
import { resolveSeedPath } from '../src/seed.ts';
import { BODY_CLASSES } from '../src/body.ts';

/** Checksum of the snapshot below. Edit by hand, never generated. */
const STAGE_01_CHECKSUM = '0x233c912e';

const HASH_VECTORS: readonly (readonly number[])[] = [
  [0],
  [1],
  [-1],
  [1, 2, 3],
  [3, 2, 1],
  [0, 0, 0, 0],
  [2147483647, -2147483648],
  [42, 6371000, 0, 0],
];

const SEED_PATHS = [
  { universe: 'planeten', sector: [0, 0, 0] as const, system: 0, body: 0 },
  { universe: 'planeten', sector: [12, -7, 3] as const, system: 5, body: 2 },
  { universe: 8675309, sector: [-1, -1, -1] as const, system: 31, body: 15 },
];

const BODY_SEEDS = [1, 2, 3, 42, 1337, 0x5eed, 0xdeadbee];

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function buildSnapshot(): unknown {
  return {
    stage: '01-fundament',
    hash: HASH_VECTORS.map((args) => ({
      args,
      out: `0x${hash(args[0] as number, ...args.slice(1)).toString(16).padStart(8, '0')}`,
    })),
    seedChain: SEED_PATHS.map((path) => ({ path, seeds: resolveSeedPath(path) })),
    bodies: BODY_SEEDS.map((seed) => {
      const body = makeBody(seed);
      return {
        seed,
        body,
        derived: {
          surfaceGravity: round(surfaceGravity(body), 6),
          escapeVelocity: round(escapeVelocity(body), 3),
          meanDensity: round(meanDensity(body), 3),
        },
      };
    }),
    byClass: BODY_CLASSES.map((bodyClass) => ({
      bodyClass,
      body: makeBody(20250824, { bodyClass }),
    })),
    reference: referenceBody(),
  };
}

/**
 * Checksum of the serialised parameters. Folds the one engine hash over the
 * text — no second hash function, here or anywhere.
 */
function checksum(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = hash(h, text.charCodeAt(i), i & 0xffff);
  return `0x${h.toString(16).padStart(8, '0')}`;
}

describe('golden: stage 01 parameters', () => {
  const json = `${JSON.stringify(buildSnapshot(), null, 2)}\n`;

  it('matches the committed snapshot', async () => {
    await expect(json).toMatchFileSnapshot('./golden/stage-01.json');
  });

  it('matches the checksum recorded in STATE.md', () => {
    expect(checksum(json)).toBe(STAGE_01_CHECKSUM);
  });

  it('is reproducible inside a single run', () => {
    expect(`${JSON.stringify(buildSnapshot(), null, 2)}\n`).toBe(json);
  });
});
