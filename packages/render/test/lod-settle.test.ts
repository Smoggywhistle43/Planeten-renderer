/**
 * Settle time and budget duty cycle.
 *
 * `peakBuildsPerFrame === buildBudgetPerFrame` is easy to misread as "the
 * scheduler was pinned at the ceiling for the whole flight". It is not: a peak
 * says the ceiling was touched once. The number that predicts pop-in is how
 * long the tree takes to reach its target depth after the camera stops, and how
 * far behind it runs while the camera is moving.
 *
 * These are the two numbers, measured, with bounds that will fail if a change
 * makes convergence slower.
 *
 * Caveat that belongs with every number here: the stage-01 reference body has
 * no relief, so the target depth is shallow and the settled tile count is small.
 * With real terrain both grow and these bounds need re-measuring, not relaxing.
 */

import { describe, expect, it } from 'vitest';
import { Vec3d, referenceBody, surfaceRadius } from '@planet/core';
import { LodScheduler, type TileBuilder, type ViewParams } from '../src/lod-scheduler.ts';
import { nodeId, type NodeKey } from '../src/cube-sphere.ts';

const EARTH = referenceBody();

/** Resolves immediately: this measures scheduling, not geometry throughput. */
class InstantBuilder implements TileBuilder<string> {
  async build(key: NodeKey): Promise<string> {
    return nodeId(key);
  }
  dispose(): void {}
}

/** Off-centre, like the explorer's flight path — not over a face centre. */
const DIR = new Vec3d(
  Math.cos(0.34) * Math.cos(0.75),
  Math.sin(0.34),
  Math.cos(0.34) * Math.sin(0.75),
).normalize();

function viewAt(altitude: number, screenHeight = 1080): ViewParams {
  return {
    cameraPosition: DIR.clone().scale(surfaceRadius(EARTH, DIR) + altitude),
    bodyCenter: new Vec3d(0, 0, 0),
    forward: DIR.clone().negate(),
    fovY: (50 * Math.PI) / 180,
    aspect: 16 / 9,
    screenHeight,
  };
}

/** Frames from a cold tree until nothing is building and nothing is queued. */
async function framesToSettle(
  altitude: number,
  screenHeight: number,
  limit = 2000,
): Promise<{ frames: number; depth: number; tiles: number; builds: number }> {
  const scheduler = new LodScheduler(EARTH, new InstantBuilder(), {
    buildBudgetPerFrame: 2,
    maxDepth: 22,
  });
  await scheduler.primeRoots();
  const view = viewAt(altitude, screenHeight);

  for (let frame = 1; frame <= limit; frame++) {
    scheduler.update(view);
    await Promise.resolve();
    const stats = scheduler.stats;
    if (
      stats.buildsStartedThisFrame === 0 &&
      stats.buildsPending === 0 &&
      stats.buildsDeferredThisFrame === 0
    ) {
      const result = {
        frames: frame,
        depth: stats.maxSelectedDepth,
        tiles: stats.selectedNodes,
        builds: stats.buildsTotal,
      };
      scheduler.dispose();
      return result;
    }
  }
  scheduler.dispose();
  throw new Error(`tree did not settle at ${altitude} m within ${limit} frames`);
}

describe('settle time after the camera stops', () => {
  it('reaches its target depth within a fifth of a second at 60 fps', async () => {
    // Worst case is the lowest altitude at the highest pixel density, because
    // both push the target depth up.
    for (const screenHeight of [450, 1080, 2160]) {
      for (const altitude of [1e6, 1e5, 1e4, 1e3]) {
        const settled = await framesToSettle(altitude, screenHeight);
        expect(settled.frames).toBeLessThanOrEqual(12);
        expect(settled.depth).toBeGreaterThanOrEqual(0);
      }
    }
  }, 120_000);

  it('gets deeper and takes slightly longer as the camera comes down', async () => {
    const high = await framesToSettle(1e6, 1080);
    const low = await framesToSettle(1e3, 1080);
    expect(low.depth).toBeGreaterThan(high.depth);
    expect(low.frames).toBeGreaterThanOrEqual(high.frames);
  }, 120_000);

  it('needs only a couple of dozen tiles to settle on a flat body', async () => {
    const settled = await framesToSettle(1e3, 2160);
    expect(settled.builds).toBeLessThan(40);
    expect(settled.tiles).toBeLessThan(40);
  }, 120_000);

  it('reports quiet frames once it has settled', async () => {
    const scheduler = new LodScheduler(EARTH, new InstantBuilder(), { buildBudgetPerFrame: 2 });
    await scheduler.primeRoots();
    const view = viewAt(1e3);
    for (let i = 0; i < 200; i++) {
      scheduler.update(view);
      await Promise.resolve();
    }
    expect(scheduler.stats.framesSinceBuildActivity).toBeGreaterThan(100);
    scheduler.dispose();
  }, 120_000);
});

describe('budget duty cycle during a descent', () => {
  it('touches the ceiling on a small fraction of frames, not continuously', async () => {
    const frames = 600; // a ten-second descent at 60 fps
    const scheduler = new LodScheduler(EARTH, new InstantBuilder(), {
      buildBudgetPerFrame: 2,
      maxDepth: 22,
    });
    await scheduler.primeRoots();

    for (let i = 0; i <= frames; i++) {
      const altitude = 1e9 * (1e3 / 1e9) ** (i / frames);
      scheduler.update(viewAt(altitude));
      await Promise.resolve();
    }

    const stats = scheduler.stats;
    expect(stats.peakBuildsPerFrame).toBeLessThanOrEqual(2);
    // The point: a peak of 2 does not mean saturation. Measured at ~2 %.
    expect(stats.framesAtBudget / stats.framesTotal).toBeLessThan(0.1);
    expect(stats.buildsTotal).toBeLessThan(60);
    scheduler.dispose();
  }, 120_000);

  it('is quiet again within a frame of the camera stopping', async () => {
    const frames = 300; // a five-second descent, fast enough to fall behind
    const scheduler = new LodScheduler(EARTH, new InstantBuilder(), {
      buildBudgetPerFrame: 2,
      maxDepth: 22,
    });
    await scheduler.primeRoots();
    for (let i = 0; i <= frames; i++) {
      const altitude = 1e9 * (1e3 / 1e9) ** (i / frames);
      scheduler.update(viewAt(altitude));
      await Promise.resolve();
    }

    const held = viewAt(1e3);
    let recovery = 0;
    for (; recovery < 200; recovery++) {
      scheduler.update(held);
      await Promise.resolve();
      const stats = scheduler.stats;
      if (
        stats.buildsStartedThisFrame === 0 &&
        stats.buildsPending === 0 &&
        stats.buildsDeferredThisFrame === 0
      ) {
        break;
      }
    }
    expect(recovery).toBeLessThanOrEqual(4);
    scheduler.dispose();
  }, 120_000);

  it('runs at most one depth level behind a settled tree while descending', async () => {
    // The pop-in predictor: how coarse the picture is while the camera moves,
    // compared with what it would be if the camera had stopped there.
    const frames = 300;
    const moving = new LodScheduler(EARTH, new InstantBuilder(), {
      buildBudgetPerFrame: 2,
      maxDepth: 22,
    });
    await moving.primeRoots();

    let worstDeficit = 0;
    for (let i = 0; i <= frames; i++) {
      const altitude = 1e9 * (1e3 / 1e9) ** (i / frames);
      moving.update(viewAt(altitude));
      await Promise.resolve();
      if (i % 30 !== 0) continue;

      const settled = await framesToSettle(altitude, 1080);
      worstDeficit = Math.max(worstDeficit, settled.depth - moving.stats.maxSelectedDepth);
    }
    expect(worstDeficit).toBeLessThanOrEqual(1);
    moving.dispose();
  }, 300_000);
});
