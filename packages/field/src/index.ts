/**
 * @planet/field — the terrain function.
 *
 * Written once in TSL, consumed by the renderer as a material node and by the
 * CPU as a compute kernel with readback. No second implementation.
 */

export {
  surfaceHeight,
  heightNode,
  surfaceNormalNode,
  createHeightUniforms,
  updateHeightUniforms,
  type HeightUniforms,
} from './height.ts';

export {
  HeightSampler,
  type HeightSamplerOptions,
  type DirectionInput,
  type ComputeCapableRenderer,
} from './sampler.ts';
