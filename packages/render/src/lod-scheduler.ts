/**
 * Quadtree selection with a hard per-frame build budget.
 *
 * The rule from the handoff: never recurse until the tree is "finished". Each
 * frame the scheduler walks the quadtree, draws the best tiles it already has,
 * and starts at most `buildBudgetPerFrame` new tiles — two, by default. A tile
 * that is not ready yet simply is not drawn; its parent is drawn instead, which
 * is coarser but never a hole.
 *
 * Builds run asynchronously. A build that finishes after its node has been
 * pruned is thrown away rather than inserted, so a fast camera cannot leave
 * stale geometry behind.
 *
 * Generic over the tile type and free of `three`, so the whole selection
 * strategy is testable in Node against a fake builder.
 */

import { Vec3d, type Body } from '@planet/core';
import {
  childKey,
  distanceToPatch,
  nodeBounds,
  nodeGeometricError,
  nodeId,
  rootKeys,
  type NodeBounds,
  type NodeKey,
} from './cube-sphere.ts';

export type NodeState = 'unloaded' | 'building' | 'ready' | 'failed';

export interface LodNode<T> {
  readonly key: NodeKey;
  readonly id: string;
  readonly bounds: NodeBounds;
  /** Metres of deviation from the true surface if this node is drawn. */
  readonly geometricError: number;
  children: LodNode<T>[] | null;
  state: NodeState;
  tile: T | null;
  /** Guards against a completed build landing on a node that has moved on. */
  buildToken: number;
  /** Frame index this node was last part of the traversal. */
  lastUsedFrame: number;
}

/** Builds and disposes the renderable payload for a node. */
export interface TileBuilder<T> {
  build(key: NodeKey): Promise<T>;
  dispose(tile: T): void;
}

export interface LodConfig {
  /** Cells per tile edge. Feeds the geometric error. */
  readonly gridResolution: number;
  /** Deepest node the scheduler will ask for. */
  readonly maxDepth: number;
  /** Split a node once drawing it would cost more than this many pixels. */
  readonly errorThresholdPixels: number;
  /** Hard cap on builds started per frame. The handoff starts this at 2. */
  readonly buildBudgetPerFrame: number;
  /** Frames a subtree may go untouched before it is released. */
  readonly unloadDelayFrames: number;
  readonly horizonCulling: boolean;
  readonly frustumCulling: boolean;
}

export const DEFAULT_LOD_CONFIG: LodConfig = Object.freeze({
  gridResolution: 32,
  maxDepth: 22,
  errorThresholdPixels: 2,
  buildBudgetPerFrame: 2,
  unloadDelayFrames: 120,
  horizonCulling: true,
  frustumCulling: true,
});

export interface ViewParams {
  /** Camera position in world coordinates, float64. */
  readonly cameraPosition: Vec3d;
  /** Body centre in world coordinates, float64. */
  readonly bodyCenter: Vec3d;
  /** Unit forward vector of the camera, world axes. */
  readonly forward: Vec3d;
  /** Vertical field of view, radians. */
  readonly fovY: number;
  /** Viewport width / height. */
  readonly aspect: number;
  /** Viewport height in device pixels. Errors are measured against this. */
  readonly screenHeight: number;
}

export interface LodStats {
  frame: number;
  /** Builds started during the last `update`. Must never exceed the budget. */
  buildsStartedThisFrame: number;
  /** Builds that completed since the previous `update`. */
  buildsCompletedThisFrame: number;
  /** Builds in flight right now. */
  buildsPending: number;
  /** Nodes that wanted building this frame but did not fit in the budget. */
  buildsDeferredThisFrame: number;
  /** Tiles handed to the renderer this frame. */
  selectedNodes: number;
  /** Deepest node drawn this frame. */
  maxSelectedDepth: number;
  /** Nodes in the tree, drawn or not. */
  residentNodes: number;
  /** Tiles disposed since the previous `update`. */
  releasedThisFrame: number;
  /** Builds discarded on arrival because their node had been pruned. */
  discardedBuilds: number;
  failedBuilds: number;
  /** Largest screen-space error among the drawn tiles, pixels. */
  maxSelectedErrorPixels: number;
}

interface Candidate<T> {
  node: LodNode<T>;
  priority: number;
}

export class LodScheduler<T> {
  readonly body: Body;
  readonly config: LodConfig;

  private readonly builder: TileBuilder<T>;
  private readonly roots: LodNode<T>[];
  private readonly selectedNodes: LodNode<T>[] = [];
  private readonly candidates: Candidate<T>[] = [];
  private readonly onError: (error: unknown, key: NodeKey) => void;

  private frame = 0;
  private tokenCounter = 0;
  private pending = 0;
  private completedSinceUpdate = 0;
  private releasedSinceUpdate = 0;
  private discarded = 0;
  private failed = 0;
  private residentCount = 0;
  private disposed = false;
  /** Floor on the distance used for the error, so a grazing tile stays finite. */
  private readonly minDistance: number;

  private readonly stat: LodStats = {
    frame: 0,
    buildsStartedThisFrame: 0,
    buildsCompletedThisFrame: 0,
    buildsPending: 0,
    buildsDeferredThisFrame: 0,
    selectedNodes: 0,
    maxSelectedDepth: 0,
    residentNodes: 0,
    releasedThisFrame: 0,
    discardedBuilds: 0,
    failedBuilds: 0,
    maxSelectedErrorPixels: 0,
  };

  private readonly scratchToNode = new Vec3d();
  private readonly scratchToCam = new Vec3d();
  private readonly cameraLocal = new Vec3d();

  constructor(
    body: Body,
    builder: TileBuilder<T>,
    config: Partial<LodConfig> = {},
    onError: (error: unknown, key: NodeKey) => void = () => {},
  ) {
    this.body = body;
    this.builder = builder;
    this.config = { ...DEFAULT_LOD_CONFIG, ...config };
    this.onError = onError;
    if (this.config.buildBudgetPerFrame < 1) {
      throw new RangeError('LodScheduler: buildBudgetPerFrame must be at least 1');
    }
    // One metre, or a hundredth of the deepest tile, whichever is smaller.
    this.minDistance = Math.min(1, (Math.PI * body.radius) / 2 ** (this.config.maxDepth + 8));
    this.roots = rootKeys().map((key) => this.createNode(key));
    this.residentCount = this.roots.length;
  }

  /** The six depth-0 nodes. Build these before the first frame. */
  get rootNodes(): readonly LodNode<T>[] {
    return this.roots;
  }

  /** Tiles to draw this frame, in traversal order. */
  get selected(): readonly LodNode<T>[] {
    return this.selectedNodes;
  }

  get stats(): Readonly<LodStats> {
    // These three keep counting between frames, so read them live rather than
    // from the last `update` — a test (or an overlay) that looks after an
    // awaited build should see it.
    this.stat.buildsPending = this.pending;
    this.stat.discardedBuilds = this.discarded;
    this.stat.failedBuilds = this.failed;
    return this.stat;
  }

  /**
   * Build the six root tiles and wait for them.
   *
   * This is the one place the budget does not apply: without a resident root a
   * frame would have nothing to fall back to, and there would be a hole in the
   * planet rather than a coarse patch. It happens once, before the first frame.
   */
  async primeRoots(): Promise<void> {
    await Promise.all(
      this.roots.map(async (node) => {
        if (node.state === 'ready') return;
        node.state = 'building';
        const token = ++this.tokenCounter;
        node.buildToken = token;
        const tile = await this.builder.build(node.key);
        node.tile = tile;
        node.state = 'ready';
      }),
    );
  }

  /**
   * One frame of selection. Cheap: it walks only the resident tree, does no
   * geometry work, and starts at most `buildBudgetPerFrame` builds.
   */
  update(view: ViewParams): void {
    this.assertLive();
    this.frame++;
    this.selectedNodes.length = 0;
    this.candidates.length = 0;

    const pixelsPerRadian = view.screenHeight / (2 * Math.tan(view.fovY / 2));
    const halfDiagonal = Math.atan(
      Math.hypot(Math.tan(view.fovY / 2) * view.aspect, Math.tan(view.fovY / 2)),
    );

    // Node bounds are body-centred, so the camera moves into that space once,
    // in float64, instead of every node moving into world space.
    const cameraLocal = this.cameraLocal.subVectors(view.cameraPosition, view.bodyCenter);
    const cameraDistanceFromCentre = cameraLocal.length();

    const ctx: TraversalContext = {
      view,
      cameraLocal,
      pixelsPerRadian,
      halfDiagonal,
      cameraDistanceFromCentre,
      maxErrorPixels: 0,
      maxDepth: 0,
    };

    for (const root of this.roots) {
      root.lastUsedFrame = this.frame;
      if (root.state !== 'ready') continue;
      if (!this.isVisible(root, ctx)) continue;
      this.visit(root, ctx);
    }

    // Highest screen-space error first: fix the worst-looking tile first.
    this.candidates.sort((a, b) => b.priority - a.priority);
    let started = 0;
    for (const candidate of this.candidates) {
      if (started >= this.config.buildBudgetPerFrame) break;
      if (candidate.node.state !== 'unloaded') continue;
      this.startBuild(candidate.node);
      started++;
    }

    this.prune();

    this.stat.frame = this.frame;
    this.stat.buildsStartedThisFrame = started;
    this.stat.buildsCompletedThisFrame = this.completedSinceUpdate;
    this.stat.buildsPending = this.pending;
    this.stat.buildsDeferredThisFrame = Math.max(0, this.candidates.length - started);
    this.stat.selectedNodes = this.selectedNodes.length;
    this.stat.maxSelectedDepth = ctx.maxDepth;
    this.stat.residentNodes = this.residentCount;
    this.stat.releasedThisFrame = this.releasedSinceUpdate;
    this.stat.discardedBuilds = this.discarded;
    this.stat.failedBuilds = this.failed;
    this.stat.maxSelectedErrorPixels = ctx.maxErrorPixels;
    this.completedSinceUpdate = 0;
    this.releasedSinceUpdate = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const root of this.roots) this.releaseSubtree(root, true);
    this.selectedNodes.length = 0;
    this.candidates.length = 0;
  }

  // ------------------------------------------------------------ internals --

  /** Precondition: `node.state === 'ready'` and the node is visible. */
  private visit(node: LodNode<T>, ctx: TraversalContext): void {
    node.lastUsedFrame = this.frame;

    const errorPixels = this.screenError(node, ctx);
    const canSplit = node.key.depth < this.config.maxDepth;

    if (!canSplit || errorPixels <= this.config.errorThresholdPixels) {
      this.select(node, errorPixels, ctx);
      return;
    }

    const children = this.ensureChildren(node);

    let allVisibleChildrenReady = true;
    for (const child of children) {
      child.lastUsedFrame = this.frame;
      if (!this.isVisible(child, ctx)) continue;
      if (child.state === 'ready') continue;
      if (child.state === 'unloaded') this.candidates.push({ node: child, priority: errorPixels });
      allVisibleChildrenReady = false;
    }

    if (!allVisibleChildrenReady) {
      // Draw the parent this frame. Coarse, never a hole.
      this.select(node, errorPixels, ctx);
      return;
    }

    for (const child of children) {
      if (this.isVisible(child, ctx)) this.visit(child, ctx);
    }
  }

  private select(node: LodNode<T>, errorPixels: number, ctx: TraversalContext): void {
    this.selectedNodes.push(node);
    if (errorPixels > ctx.maxErrorPixels) ctx.maxErrorPixels = errorPixels;
    if (node.key.depth > ctx.maxDepth) ctx.maxDepth = node.key.depth;
  }

  private ensureChildren(node: LodNode<T>): LodNode<T>[] {
    if (node.children) return node.children;
    const children = [0, 1, 2, 3].map((i) => this.createNode(childKey(node.key, i)));
    node.children = children;
    this.residentCount += 4;
    return children;
  }

  private createNode(key: NodeKey): LodNode<T> {
    return {
      key,
      id: nodeId(key),
      bounds: nodeBounds(key, this.body),
      geometricError: nodeGeometricError(key, this.body, this.config.gridResolution),
      children: null,
      state: 'unloaded',
      tile: null,
      buildToken: 0,
      lastUsedFrame: -1,
    };
  }

  /**
   * Screen-space error in pixels: how far the drawn surface would sit from the
   * true surface, projected at the node's nearest approach to the camera.
   *
   * The distance comes from the patch samples rather than the bounding sphere.
   * A bounding sphere that swallows the camera would drive this to infinity and
   * split a node the viewer is nowhere near.
   */
  private screenError(node: LodNode<T>, ctx: TraversalContext): number {
    const distance = Math.max(
      this.minDistance,
      distanceToPatch(node.bounds, this.body.radius, ctx.cameraLocal) -
        this.body.terrain.amplitude,
    );
    return (node.geometricError * ctx.pixelsPerRadian) / distance;
  }

  private isVisible(node: LodNode<T>, ctx: TraversalContext): boolean {
    const toNode = this.scratchToNode.subVectors(node.bounds.center, ctx.cameraLocal);
    const distance = toNode.length();

    // Inside the bounding sphere: no useful angle to test against.
    if (distance <= node.bounds.radius) return true;

    if (this.config.frustumCulling) {
      const angularRadius = Math.asin(Math.min(1, node.bounds.radius / distance));
      const cosAngle = Math.min(1, Math.max(-1, toNode.dot(ctx.view.forward) / distance));
      if (Math.acos(cosAngle) - angularRadius > ctx.halfDiagonal) return false;
    }

    if (this.config.horizonCulling) {
      const d = ctx.cameraDistanceFromCentre;
      if (d > this.body.radius) {
        // The horizon circle sits at R^2 / d above the centre, along the
        // camera direction. Everything below that plane is on the far side.
        const toCam = this.scratchToCam.copy(ctx.cameraLocal).scale(1 / d);
        const projection = node.bounds.center.dot(toCam);
        const horizon = (this.body.radius * this.body.radius) / d;
        if (projection + node.bounds.radius < horizon) return false;
      }
    }

    return true;
  }

  private startBuild(node: LodNode<T>): void {
    node.state = 'building';
    const token = ++this.tokenCounter;
    node.buildToken = token;
    this.pending++;

    this.builder.build(node.key).then(
      (tile) => {
        this.pending--;
        if (this.disposed || node.buildToken !== token) {
          this.discarded++;
          this.builder.dispose(tile);
          return;
        }
        node.tile = tile;
        node.state = 'ready';
        this.completedSinceUpdate++;
      },
      (error: unknown) => {
        this.pending--;
        if (node.buildToken === token) node.state = 'failed';
        this.failed++;
        this.onError(error, node.key);
      },
    );
  }

  /** Release subtrees nobody has looked at for a while. */
  private prune(): void {
    const cutoff = this.frame - this.config.unloadDelayFrames;
    for (const root of this.roots) this.pruneNode(root, cutoff);
  }

  private pruneNode(node: LodNode<T>, cutoff: number): void {
    if (!node.children) return;
    let anyChildRecent = false;
    for (const child of node.children) {
      if (child.lastUsedFrame > cutoff) anyChildRecent = true;
      this.pruneNode(child, cutoff);
    }
    if (!anyChildRecent) {
      for (const child of node.children) this.releaseSubtree(child, true);
      this.residentCount -= countNodes(node.children);
      node.children = null;
    }
  }

  private releaseSubtree(node: LodNode<T>, includeSelf: boolean): void {
    if (node.children) {
      for (const child of node.children) this.releaseSubtree(child, true);
      node.children = null;
    }
    if (!includeSelf) return;
    // Invalidate any build in flight; its result will be discarded on arrival.
    node.buildToken = ++this.tokenCounter;
    if (node.tile !== null) {
      this.builder.dispose(node.tile);
      node.tile = null;
      this.releasedSinceUpdate++;
    }
    node.state = 'unloaded';
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('LodScheduler: already disposed');
  }
}

interface TraversalContext {
  readonly view: ViewParams;
  /** Camera position relative to the body's centre, float64. */
  readonly cameraLocal: Vec3d;
  /** Pixels subtended by one radian at the centre of the viewport. */
  readonly pixelsPerRadian: number;
  /** Half-angle of the view cone's diagonal, radians. */
  readonly halfDiagonal: number;
  readonly cameraDistanceFromCentre: number;
  maxErrorPixels: number;
  maxDepth: number;
}

function countNodes<T>(nodes: LodNode<T>[]): number {
  let total = 0;
  for (const node of nodes) {
    total += 1;
    if (node.children) total += countNodes(node.children);
  }
  return total;
}
