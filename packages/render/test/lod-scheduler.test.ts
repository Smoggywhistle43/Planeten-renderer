import { describe, expect, it } from 'vitest';
import { Vec3d, referenceBody } from '@planet/core';
import {
  DEFAULT_LOD_CONFIG,
  LodScheduler,
  type LodConfig,
  type TileBuilder,
  type ViewParams,
} from '../src/lod-scheduler.ts';
import { nodeId, type NodeKey } from '../src/cube-sphere.ts';

const EARTH = referenceBody();

/**
 * A builder that records what it was asked for and resolves when told to.
 * Lets the tests drive the async boundary instead of racing it.
 */
class FakeBuilder implements TileBuilder<string> {
  readonly requested: string[] = [];
  readonly disposed: string[] = [];
  private readonly pending: Array<{ id: string; resolve: (v: string) => void; reject: (e: unknown) => void }> = [];
  failNext = false;

  build(key: NodeKey): Promise<string> {
    const id = nodeId(key);
    this.requested.push(id);
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error(`build failed for ${id}`));
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ id, resolve, reject });
    });
  }

  dispose(tile: string): void {
    this.disposed.push(tile);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Resolve everything currently in flight and let the microtasks run. */
  async flush(): Promise<void> {
    const batch = this.pending.splice(0, this.pending.length);
    for (const p of batch) p.resolve(p.id);
    await Promise.resolve();
    await Promise.resolve();
  }
}

/** A builder that resolves immediately, for tests that only care about counts. */
class InstantBuilder implements TileBuilder<string> {
  readonly requested: string[] = [];
  readonly disposed: string[] = [];

  async build(key: NodeKey): Promise<string> {
    const id = nodeId(key);
    this.requested.push(id);
    return id;
  }

  dispose(tile: string): void {
    this.disposed.push(tile);
  }
}

function viewFrom(altitude: number, screenHeight = 1080): ViewParams {
  const distance = EARTH.radius + altitude;
  return {
    cameraPosition: new Vec3d(distance, 0, 0),
    bodyCenter: new Vec3d(0, 0, 0),
    forward: new Vec3d(-1, 0, 0),
    fovY: (50 * Math.PI) / 180,
    aspect: 16 / 9,
    screenHeight,
  };
}

async function makeScheduler(
  builder: TileBuilder<string>,
  config: Partial<LodConfig> = {},
): Promise<LodScheduler<string>> {
  const scheduler = new LodScheduler(EARTH, builder, config);
  await scheduler.primeRoots();
  return scheduler;
}

describe('LodScheduler', () => {
  it('starts with six roots and refuses a budget below one', () => {
    const scheduler = new LodScheduler(EARTH, new InstantBuilder());
    expect(scheduler.rootNodes).toHaveLength(6);
    expect(() => new LodScheduler(EARTH, new InstantBuilder(), { buildBudgetPerFrame: 0 })).toThrow(
      RangeError,
    );
    scheduler.dispose();
  });

  it('primes the roots outside the budget, so the first frame is never a hole', async () => {
    const builder = new InstantBuilder();
    const scheduler = await makeScheduler(builder, { buildBudgetPerFrame: 2 });
    expect(builder.requested).toHaveLength(6);
    expect(scheduler.rootNodes.every((n) => n.state === 'ready')).toBe(true);

    scheduler.update(viewFrom(1e9));
    expect(scheduler.selected.length).toBeGreaterThan(0);
    scheduler.dispose();
  });

  describe('the build budget', () => {
    it('never starts more than the budget in one frame', async () => {
      for (const budget of [1, 2, 4, 8]) {
        const builder = new InstantBuilder();
        const scheduler = await makeScheduler(builder, { buildBudgetPerFrame: budget });
        const view = viewFrom(1e4);

        for (let frame = 0; frame < 200; frame++) {
          const before = builder.requested.length;
          scheduler.update(view);
          const started = builder.requested.length - before;
          expect(started).toBeLessThanOrEqual(budget);
          expect(scheduler.stats.buildsStartedThisFrame).toBe(started);
          expect(scheduler.stats.buildsStartedThisFrame).toBeLessThanOrEqual(budget);
          await Promise.resolve();
        }
        scheduler.dispose();
      }
    });

    it('defaults to two, as the handoff specifies', () => {
      expect(DEFAULT_LOD_CONFIG.buildBudgetPerFrame).toBe(2);
    });

    it('holds the budget while the camera dives from 1e9 m to 1e3 m', async () => {
      const builder = new InstantBuilder();
      const scheduler = await makeScheduler(builder, { buildBudgetPerFrame: 2, maxDepth: 20 });

      let worst = 0;
      for (let i = 0; i <= 600; i++) {
        const t = i / 600;
        const altitude = 1e9 * (1e3 / 1e9) ** t;
        const before = builder.requested.length;
        scheduler.update(viewFrom(altitude));
        worst = Math.max(worst, builder.requested.length - before);
        await Promise.resolve();
      }
      expect(worst).toBeLessThanOrEqual(2);
      scheduler.dispose();
    });

    it('reports the work it could not start', async () => {
      const builder = new InstantBuilder();
      const scheduler = await makeScheduler(builder, { buildBudgetPerFrame: 1 });
      scheduler.update(viewFrom(1e5));
      expect(scheduler.stats.buildsDeferredThisFrame).toBeGreaterThan(0);
      scheduler.dispose();
    });
  });

  describe('selection', () => {
    it('draws the coarsest tiles from far away', async () => {
      const scheduler = await makeScheduler(new InstantBuilder());
      scheduler.update(viewFrom(1e9));
      expect(scheduler.stats.maxSelectedDepth).toBe(0);
      scheduler.dispose();
    });

    it('reaches deeper as the camera comes down', async () => {
      const builder = new InstantBuilder();
      const scheduler = await makeScheduler(builder, { buildBudgetPerFrame: 64, maxDepth: 20 });

      // The steps are decades apart because a depth-0 tile really is sub-pixel
      // from 1e6 m up: its sagitta is 1178 m over a 245 km cell, which at that
      // range is 1.4 px. Splitting there would be wasted work, not detail.
      const depths: number[] = [];
      for (const altitude of [1e9, 1e5, 1e3, 1e1]) {
        // Let the tree settle at this altitude before reading the depth.
        for (let i = 0; i < 400; i++) {
          scheduler.update(viewFrom(altitude));
          await Promise.resolve();
        }
        depths.push(scheduler.stats.maxSelectedDepth);
      }
      for (let i = 1; i < depths.length; i++) {
        expect(depths[i]).toBeGreaterThan(depths[i - 1] as number);
      }
      expect(depths[0]).toBe(0);
      expect(depths[depths.length - 1]).toBeGreaterThanOrEqual(6);
      scheduler.dispose();
    });

    it('keeps the drawn error near the threshold once it has settled', async () => {
      const scheduler = await makeScheduler(new InstantBuilder(), {
        buildBudgetPerFrame: 64,
        errorThresholdPixels: 2,
        maxDepth: 20,
      });
      for (let i = 0; i < 600; i++) {
        scheduler.update(viewFrom(1e4));
        await Promise.resolve();
      }
      expect(scheduler.stats.maxSelectedErrorPixels).toBeLessThanOrEqual(2.0001);
      scheduler.dispose();
    });

    it('never draws a node that has no tile', async () => {
      const builder = new FakeBuilder();
      const scheduler = await makeSchedulerWithFake(builder);
      for (let i = 0; i < 50; i++) {
        scheduler.update(viewFrom(1e5));
        for (const node of scheduler.selected) {
          expect(node.state).toBe('ready');
          expect(node.tile).not.toBeNull();
        }
        await builder.flush();
      }
      scheduler.dispose();
    });

    it('tessellates under a camera that is not over a face centre', async () => {
      // The same regression as `distanceToPatch`: with a sampled-point distance
      // this settled at depth 0 and drew a faceted cube from a kilometre up.
      const dir = new Vec3d(
        Math.cos(0.34) * Math.cos(0.75),
        Math.sin(0.34),
        Math.cos(0.34) * Math.sin(0.75),
      ).normalize();
      const scheduler = await makeScheduler(new InstantBuilder(), {
        buildBudgetPerFrame: 64,
        maxDepth: 20,
      });
      const position = dir.clone().scale(EARTH.radius + 1e3);
      const view: ViewParams = {
        cameraPosition: position,
        bodyCenter: new Vec3d(0, 0, 0),
        forward: dir.clone().negate(),
        fovY: (50 * Math.PI) / 180,
        aspect: 16 / 9,
        screenHeight: 1080,
      };
      for (let i = 0; i < 900; i++) {
        scheduler.update(view);
        await Promise.resolve();
      }
      expect(scheduler.stats.maxSelectedDepth).toBeGreaterThanOrEqual(6);
      expect(scheduler.stats.maxSelectedErrorPixels).toBeLessThanOrEqual(2.0001);
      scheduler.dispose();
    });

    it('works the same with the body away from the world origin', async () => {
      const offset = new Vec3d(4.1e11, -2.7e11, 9.3e10);
      const atOrigin = await makeScheduler(new InstantBuilder(), { buildBudgetPerFrame: 64, maxDepth: 12 });
      const offOrigin = await makeScheduler(new InstantBuilder(), { buildBudgetPerFrame: 64, maxDepth: 12 });

      for (let i = 0; i < 400; i++) {
        const base = viewFrom(1e4);
        atOrigin.update(base);
        offOrigin.update({
          ...base,
          cameraPosition: base.cameraPosition.clone().add(offset),
          bodyCenter: offset,
        });
        await Promise.resolve();
      }
      expect(offOrigin.stats.maxSelectedDepth).toBe(atOrigin.stats.maxSelectedDepth);
      expect(offOrigin.stats.selectedNodes).toBe(atOrigin.stats.selectedNodes);
      atOrigin.dispose();
      offOrigin.dispose();
    });

    it('respects maxDepth', async () => {
      const scheduler = await makeScheduler(new InstantBuilder(), {
        buildBudgetPerFrame: 64,
        maxDepth: 5,
      });
      for (let i = 0; i < 600; i++) {
        scheduler.update(viewFrom(1e3));
        await Promise.resolve();
      }
      expect(scheduler.stats.maxSelectedDepth).toBeLessThanOrEqual(5);
      scheduler.dispose();
    });
  });

  describe('culling', () => {
    it('drops the far side of the planet at low altitude', async () => {
      const builder = new InstantBuilder();
      const scheduler = await makeScheduler(builder, { buildBudgetPerFrame: 64, maxDepth: 8 });
      for (let i = 0; i < 400; i++) {
        scheduler.update(viewFrom(1e4));
        await Promise.resolve();
      }
      const withCulling = scheduler.stats.selectedNodes;
      scheduler.dispose();

      const naive = await makeScheduler(new InstantBuilder(), {
        buildBudgetPerFrame: 64,
        maxDepth: 8,
        horizonCulling: false,
        frustumCulling: false,
      });
      for (let i = 0; i < 400; i++) {
        naive.update(viewFrom(1e4));
        await Promise.resolve();
      }
      expect(withCulling).toBeLessThan(naive.stats.selectedNodes);
      naive.dispose();
    });

    it('keeps the whole planet when the camera is far away', async () => {
      const scheduler = await makeScheduler(new InstantBuilder());
      scheduler.update(viewFrom(1e9));
      // From 1e9 m the entire sphere is inside the view cone, and the horizon
      // test only removes the hemisphere pointing away.
      expect(scheduler.stats.selectedNodes).toBeGreaterThanOrEqual(3);
      expect(scheduler.stats.selectedNodes).toBeLessThanOrEqual(6);
      scheduler.dispose();
    });
  });

  describe('asynchronous builds', () => {
    it('discards a build that lands after its node was released', async () => {
      const builder = new FakeBuilder();
      const scheduler = await makeSchedulerWithFake(builder, { unloadDelayFrames: 1 });

      scheduler.update(viewFrom(1e4));
      expect(builder.pendingCount).toBeGreaterThan(0);

      // Fly away, so the requested subtree is pruned before the build returns.
      for (let i = 0; i < 5; i++) scheduler.update(viewFrom(1e9));
      await builder.flush();

      expect(scheduler.stats.discardedBuilds).toBeGreaterThan(0);
      expect(builder.disposed.length).toBeGreaterThan(0);
      for (const node of scheduler.selected) expect(node.key.depth).toBe(0);
      scheduler.dispose();
    });

    it('surfaces a failed build instead of retrying it silently', async () => {
      const builder = new FakeBuilder();
      const errors: unknown[] = [];
      const scheduler = new LodScheduler(
        EARTH,
        builder,
        { buildBudgetPerFrame: 1 },
        (e) => errors.push(e),
      );
      const priming = scheduler.primeRoots();
      await builder.flush();
      await priming;

      builder.failNext = true;
      scheduler.update(viewFrom(1e5));
      await Promise.resolve();
      await Promise.resolve();

      expect(errors).toHaveLength(1);
      expect(scheduler.stats.failedBuilds).toBe(1);
      scheduler.dispose();
    });

    it('counts what is in flight', async () => {
      const builder = new FakeBuilder();
      const scheduler = await makeSchedulerWithFake(builder, { buildBudgetPerFrame: 2 });
      scheduler.update(viewFrom(1e5));
      scheduler.update(viewFrom(1e5));
      expect(scheduler.stats.buildsPending).toBeGreaterThan(0);
      await builder.flush();
      scheduler.update(viewFrom(1e5));
      expect(scheduler.stats.buildsCompletedThisFrame).toBeGreaterThan(0);
      scheduler.dispose();
    });
  });

  describe('lifecycle', () => {
    it('releases tiles nobody has looked at', async () => {
      const builder = new InstantBuilder();
      const scheduler = await makeScheduler(builder, {
        buildBudgetPerFrame: 64,
        maxDepth: 8,
        unloadDelayFrames: 2,
      });
      for (let i = 0; i < 300; i++) {
        scheduler.update(viewFrom(1e4));
        await Promise.resolve();
      }
      const grown = scheduler.stats.residentNodes;
      expect(grown).toBeGreaterThan(6);

      for (let i = 0; i < 300; i++) {
        scheduler.update(viewFrom(1e9));
        await Promise.resolve();
      }
      expect(scheduler.stats.residentNodes).toBeLessThan(grown);
      expect(builder.disposed.length).toBeGreaterThan(0);
      scheduler.dispose();
    });

    it('refuses use after dispose', async () => {
      const scheduler = await makeScheduler(new InstantBuilder());
      scheduler.dispose();
      expect(() => scheduler.update(viewFrom(1e6))).toThrow(/disposed/);
    });

    it('disposes every resident tile when torn down', async () => {
      const builder = new InstantBuilder();
      const scheduler = await makeScheduler(builder, { buildBudgetPerFrame: 32, maxDepth: 6 });
      for (let i = 0; i < 200; i++) {
        scheduler.update(viewFrom(1e5));
        await Promise.resolve();
      }
      const built = builder.requested.length;
      scheduler.dispose();
      expect(builder.disposed.length).toBe(built);
    });
  });
});

async function makeSchedulerWithFake(
  builder: FakeBuilder,
  config: Partial<LodConfig> = {},
): Promise<LodScheduler<string>> {
  const scheduler = new LodScheduler(EARTH, builder, { buildBudgetPerFrame: 2, ...config });
  const priming = scheduler.primeRoots();
  await builder.flush();
  await priming;
  return scheduler;
}
