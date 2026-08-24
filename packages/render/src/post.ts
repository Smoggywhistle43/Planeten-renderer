/**
 * The step that turns physical light into a picture.
 *
 * The scene renders into a half-float buffer holding real luminance in cd/m^2:
 * sunlit ground lands around 1.2e4, a moonless night below 1e-3. No display
 * shows that range, so something has to choose. That is exactly what a camera
 * or an eye does, and it is what this file is.
 *
 * Two steps, in order:
 *
 *   exposure     multiply by 1 / (1.2 * 2^EV100). Picks *which* slice of the
 *                range to keep. This is the aperture, the shutter and the ISO.
 *   tone mapping fold the surviving highlights back into the display range
 *                without them turning into flat white. AgX by default, because
 *                it keeps hue as things clip instead of sliding everything
 *                towards yellow-white the way Reinhard and ACES do.
 *
 * Both live in the TSL node graph rather than in `renderer.toneMapping`, so the
 * exposure can later be driven by a compute pass that measures the frame,
 * without a read back to the CPU.
 *
 * `EffectComposer` is not used and is blocked by `pnpm check:deps`.
 */

import { RenderPipeline, type Node, type Scene, type WebGPURenderer } from 'three/webgpu';
import {
  acesFilmicToneMapping,
  agxToneMapping,
  neutralToneMapping,
  pass,
  uniform,
  vec4,
} from 'three/tsl';
import {
  ev100FromCamera,
  exposureFromEv100,
  type CameraSettings,
} from '@planet/core';
import type { PlanetCamera } from './planet-camera.ts';

/**
 * How the highlights get folded back into the display range.
 *
 * `agx`     — keeps hue as things clip. A red-hot highlight stays red instead
 *             of turning white. The default, and the closest to film.
 * `aces`    — the film-industry standard. Contrastier, and it pushes bright
 *             saturated colours towards yellow.
 * `neutral` — Khronos PBR neutral. Barely touches anything below the clip
 *             point, which makes it the honest choice for comparing against a
 *             reference image.
 * `none`    — exposure only, then a hard clip. For debugging what the renderer
 *             actually produced.
 */
export type ToneMapper = 'agx' | 'aces' | 'neutral' | 'none';

export interface PostPipelineOptions {
  /** Starting exposure value at ISO 100. Ignored if `camera` is given. */
  readonly ev100?: number;
  /** Starting exposure as real camera settings. Wins over `ev100`. */
  readonly camera?: CameraSettings;
  readonly toneMapper?: ToneMapper;
}

export interface PostPipelineHandle {
  readonly pipeline: RenderPipeline;
  /** Current exposure value at ISO 100. */
  readonly ev100: number;
  /** The multiplier the scene luminance is scaled by before tone mapping. */
  readonly exposure: number;
  readonly toneMapper: ToneMapper;
  setEv100(ev100: number): void;
  /** Set the exposure the way a photographer would. */
  setCameraSettings(settings: CameraSettings): void;
  render(): void;
  dispose(): void;
}

/** Default: expose for a sunlit Earth-like surface seen from space. */
const DEFAULT_EV100 = 16.6;

export function createPostPipeline(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: PlanetCamera,
  options: PostPipelineOptions = {},
): PostPipelineHandle {
  const toneMapper = options.toneMapper ?? 'agx';

  let ev100 = options.camera
    ? ev100FromCamera(options.camera)
    : (options.ev100 ?? DEFAULT_EV100);

  const exposureUniform = uniform(exposureFromEv100(ev100), 'float');

  const scenePass = pass(scene, camera.three);
  const linear = scenePass.rgb;

  // `agxToneMapping` and friends take the exposure as an argument and apply it
  // themselves, so the multiply happens inside the same node.
  // The tone-mapping nodes are typed loosely because their return type is a
  // runtime string; this is the only place the vec3 is asserted.
  const mapped = (
    toneMapper === 'agx'
      ? agxToneMapping(linear, exposureUniform)
      : toneMapper === 'aces'
        ? acesFilmicToneMapping(linear, exposureUniform)
        : toneMapper === 'neutral'
          ? neutralToneMapping(linear, exposureUniform)
          : linear.mul(exposureUniform)
  ) as Node<'vec3'>;

  const pipeline = new RenderPipeline(renderer, vec4(mapped, 1));
  // Leave the linear-to-sRGB conversion to three. Its tone mapping is switched
  // off in `createPlanetRenderer`, so nothing maps twice.
  pipeline.outputColorTransform = true;

  const handle: PostPipelineHandle = {
    pipeline,
    get ev100(): number {
      return ev100;
    },
    get exposure(): number {
      return exposureUniform.value;
    },
    toneMapper,
    setEv100(next: number): void {
      if (!Number.isFinite(next)) return;
      ev100 = next;
      exposureUniform.value = exposureFromEv100(next);
    },
    setCameraSettings(settings: CameraSettings): void {
      handle.setEv100(ev100FromCamera(settings));
    },
    render(): void {
      pipeline.render();
    },
    dispose(): void {
      pipeline.dispose();
    },
  };

  return handle;
}
