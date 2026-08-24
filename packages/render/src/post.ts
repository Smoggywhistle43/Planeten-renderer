/**
 * Post-processing through the TSL node stack.
 *
 * `RenderPipeline` (what `PostProcessing` was renamed to in r183) takes a
 * single output node. That node is an ordinary TSL expression over the scene
 * pass, so effects compose as nodes rather than as passes in a composer.
 * `EffectComposer` is not used and is blocked by `pnpm check:deps`.
 *
 * Stage 01 needs no effects. What it needs is the seam to exist and to be
 * exercised, so that adding an atmosphere later is a node in this graph and not
 * a rewrite of the frame loop.
 */

import { RenderPipeline, type Scene, type WebGPURenderer } from 'three/webgpu';
import { pass, uniform } from 'three/tsl';
import type { PlanetCamera } from './planet-camera.ts';

export interface PostPipelineOptions {
  /** Linear exposure multiplier applied to the scene colour. */
  readonly exposure?: number;
}

export interface PostPipelineHandle {
  readonly pipeline: RenderPipeline;
  setExposure(value: number): void;
  render(): void;
  dispose(): void;
}

export function createPostPipeline(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: PlanetCamera,
  options: PostPipelineOptions = {},
): PostPipelineHandle {
  const exposure = uniform(options.exposure ?? 1, 'float');

  const scenePass = pass(scene, camera.three);
  const output = scenePass.mul(exposure);

  const pipeline = new RenderPipeline(renderer, output);

  return {
    pipeline,
    setExposure(value: number): void {
      exposure.value = value;
    },
    render(): void {
      pipeline.render();
    },
    dispose(): void {
      pipeline.dispose();
    },
  };
}
