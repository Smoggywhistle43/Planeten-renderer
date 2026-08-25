/**
 * A planet: quadtree selection, tile building, and the per-frame placement that
 * keeps precision rules 1 to 3.
 *
 * Every frame each drawn tile gets an object matrix built from two parts: the
 * body's own rotation, and a translation by `tileOriginWorld - cameraWorld`
 * computed in float64 and narrowed once. The camera sits at the origin, so the
 * model-view product never contains a large number, and the vertices it
 * multiplies are already tile-local. That is the entire precision story, and it
 * is a handful of lines in `update`.
 *
 * The rotation is the reason the tiles are built in the body's own frame rather
 * than in world coordinates: a tile covers the same piece of ground whatever
 * the time of day, so it is built once and turned, not rebuilt as the planet
 * spins. Only the matrix changes from frame to frame.
 */

import { Group, Matrix4, Mesh, Vector3, type BufferGeometry } from 'three/webgpu';
import { BodyPose, Vec3d, type Body } from '@planet/core';
import { LodScheduler, type LodConfig, type LodStats, type TileBuilder } from './lod-scheduler.ts';
import { buildTileMeshData, type TileMeshData } from './tile-mesh.ts';
import { createTileGeometry } from './tile-geometry.ts';
import { createPlanetMaterial, type PlanetMaterialHandle, type PlanetMaterialOptions } from './planet-material.ts';
import type { NodeKey } from './cube-sphere.ts';
import type { PlanetCamera } from './planet-camera.ts';

export interface PlanetTile {
  readonly data: TileMeshData;
  readonly geometry: BufferGeometry;
  readonly mesh: Mesh;
}

export interface PlanetOptions {
  /** World position of the body's centre, float64. Default: the origin. */
  readonly center?: Vec3d;
  /** Seconds past the epoch at construction. Fixes where the body is pointing. */
  readonly time?: number;
  readonly lod?: Partial<LodConfig>;
  /** Skirt depth as a fraction of one cell's arc length. */
  readonly skirtFactor?: number;
  readonly material?: PlanetMaterialOptions;
  /** Reports a tile build that threw, instead of swallowing it. */
  readonly onBuildError?: (error: unknown, key: NodeKey) => void;
}

export interface PlanetStats extends LodStats {
  /** Triangles submitted this frame. */
  triangles: number;
  /** Tile geometries currently held in GPU-visible buffers. */
  residentTiles: number;
  /** Times the floating origin has moved since startup. */
  rebases: number;
}

export class Planet {
  readonly body: Body;
  /** World position of the body's centre, float64. */
  readonly center: Vec3d;
  /** Scene node holding the tiles that are drawn this frame. */
  readonly group = new Group();
  readonly scheduler: LodScheduler<PlanetTile>;
  readonly materialHandle: PlanetMaterialHandle;
  /** Which way the body is pointing right now. Rebuilt from `time`. */
  readonly pose = new BodyPose();

  private readonly builder: GeometryTileBuilder;
  private readonly visible = new Set<Mesh>();
  private readonly scratchWorld = new Vec3d();
  private readonly scratchLocal = new Vec3d();
  private readonly scratchRelative = new Vector3();
  private readonly poseMatrix = new Matrix4();
  private seconds = 0;
  private readonly stat: PlanetStats;
  private residentTiles = 0;
  private disposed = false;

  constructor(body: Body, options: PlanetOptions = {}) {
    this.body = body;
    this.center = options.center ? options.center.clone() : Vec3d.zero();
    this.materialHandle = createPlanetMaterial(body, options.material);
    this.setTime(options.time ?? 0);

    const gridResolution = options.lod?.gridResolution ?? 32;
    this.builder = new GeometryTileBuilder(
      body,
      this.materialHandle,
      gridResolution,
      options.skirtFactor,
      () => {
        this.residentTiles++;
      },
      () => {
        this.residentTiles--;
      },
    );

    this.scheduler = new LodScheduler<PlanetTile>(
      body,
      this.builder,
      { ...options.lod, gridResolution },
      options.onBuildError,
    );

    this.group.matrixAutoUpdate = false;
    this.group.frustumCulled = false;

    this.stat = {
      ...this.scheduler.stats,
      triangles: 0,
      residentTiles: 0,
      rebases: 0,
    };
  }

  /**
   * Build the six root tiles. Await this before the first frame so there is
   * always something coarse to fall back to and never a hole.
   */
  async init(): Promise<void> {
    await this.scheduler.primeRoots();
  }

  /** Seconds past the epoch the body is currently posed for. */
  get time(): number {
    return this.seconds;
  }

  /**
   * Point the body at where it is at `seconds` past the epoch.
   *
   * Rebuilt from the absolute time rather than advanced by a delta, so the same
   * moment always gives the same picture no matter how the frames got there.
   */
  setTime(seconds: number): void {
    this.seconds = seconds;
    this.pose.update(this.body, seconds);
    const { x, y, z } = this.pose;
    // three's `set` takes its arguments row by row; the pose axes are columns.
    this.poseMatrix.set(
      x.x, y.x, z.x, 0,
      x.y, y.y, z.y, 0,
      x.z, y.z, z.z, 0,
      0, 0, 0, 1,
    );
  }

  /**
   * Select tiles and place them relative to the camera.
   *
   * `screenHeight` is in device pixels, because the LOD error budget is a pixel
   * count and half of it would be spent on nothing at dpr 2 otherwise.
   */
  update(camera: PlanetCamera, screenWidth: number, screenHeight: number): void {
    this.assertLive();

    this.scheduler.update({
      cameraPosition: camera.position,
      bodyCenter: this.center,
      pose: this.pose,
      forward: camera.forward(),
      fovY: camera.fovY,
      aspect: screenHeight > 0 ? screenWidth / screenHeight : 1,
      screenHeight,
    });

    let triangles = 0;
    const stillVisible = new Set<Mesh>();

    for (const node of this.scheduler.selected) {
      const tile = node.tile;
      if (!tile) continue;

      // Tile origin: body-fixed, turned into world axes by the pose, then
      // offset to the body's place, then made camera-relative. Every step in
      // float64; the narrowing to float32 happens on the way into the matrix.
      this.pose.toWorld(tile.data.origin, this.scratchLocal);
      this.scratchWorld.addVectors(this.center, this.scratchLocal);
      camera.cameraRelative(this.scratchWorld, this.scratchRelative);

      // Rotate first, then translate: the vertices are body-fixed offsets from
      // the tile origin, so they have to turn with the body before being moved
      // into place.
      tile.mesh.matrix.copy(this.poseMatrix);
      tile.mesh.matrix.setPosition(
        this.scratchRelative.x,
        this.scratchRelative.y,
        this.scratchRelative.z,
      );
      tile.mesh.matrixWorld.copy(tile.mesh.matrix);
      tile.mesh.matrixWorldNeedsUpdate = false;

      stillVisible.add(tile.mesh);
      triangles += tile.data.triangleCount;
    }

    for (const mesh of this.visible) {
      if (!stillVisible.has(mesh)) this.group.remove(mesh);
    }
    for (const mesh of stillVisible) {
      if (!this.visible.has(mesh)) this.group.add(mesh);
    }
    this.visible.clear();
    for (const mesh of stillVisible) this.visible.add(mesh);

    Object.assign(this.stat, this.scheduler.stats);
    this.stat.triangles = triangles;
    this.stat.residentTiles = this.residentTiles;
    this.stat.rebases = camera.frame.rebaseCount;
  }

  get stats(): Readonly<PlanetStats> {
    return this.stat;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler.dispose();
    for (const mesh of this.visible) this.group.remove(mesh);
    this.visible.clear();
    this.materialHandle.dispose();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Planet: already disposed');
  }
}

/**
 * Builds tile geometry off the frame.
 *
 * The yield before the work is what makes the per-frame budget mean something:
 * `update` starts at most `buildBudgetPerFrame` builds and returns immediately,
 * and the generation runs in a later task, after the current frame has been
 * submitted.
 *
 * Generation is still on the main thread. Moving it into a Worker is a drop-in
 * replacement for this class — `tile-mesh.ts` is deliberately free of `three`
 * and produces transferable typed arrays — and is listed as open in STATE.md.
 */
class GeometryTileBuilder implements TileBuilder<PlanetTile> {
  constructor(
    private readonly body: Body,
    private readonly materialHandle: PlanetMaterialHandle,
    private readonly gridResolution: number,
    private readonly skirtFactor: number | undefined,
    private readonly onCreate: () => void,
    private readonly onDispose: () => void,
  ) {}

  async build(key: NodeKey): Promise<PlanetTile> {
    await yieldToNextTask();

    const data = buildTileMeshData(key, this.body, {
      gridResolution: this.gridResolution,
      ...(this.skirtFactor !== undefined ? { skirtFactor: this.skirtFactor } : {}),
    });
    const geometry = createTileGeometry(data);
    const mesh = new Mesh(geometry, this.materialHandle.material);
    mesh.name = `tile-${data.key.face}-${data.key.depth}`;
    mesh.matrixAutoUpdate = false;
    // Culling is the scheduler's job, in float64, against the real node bounds.
    mesh.frustumCulled = false;
    // Every tile sits at a different camera-relative offset each frame, so
    // sorting by an object position that is rewritten anyway buys nothing.
    mesh.renderOrder = data.key.depth;

    this.onCreate();
    return { data, geometry, mesh };
  }

  dispose(tile: PlanetTile): void {
    tile.geometry.dispose();
    this.onDispose();
  }
}

/**
 * Hand control back to the event loop for one task.
 *
 * `MessageChannel` rather than `setTimeout`, because a timeout is clamped to
 * about 4 ms and would cap tile throughput at roughly 250 per second regardless
 * of how much headroom the frame has.
 */
function yieldToNextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (): void => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
