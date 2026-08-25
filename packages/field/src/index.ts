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
  pixelFootprint,
  footprintToAngle,
  createHeightUniforms,
  updateHeightUniforms,
  type HeightUniforms,
} from './height.ts';

export {
  applyPalette,
  climateSurface,
  elevationNode,
  humidityNode,
  surfaceTemperatureNode,
  temperatureAnomalyNode,
  uniformSurface,
  type SurfaceModel,
  type SurfacePoint,
} from './surface.ts';

export {
  HeightSampler,
  type HeightSamplerOptions,
  type DirectionInput,
  type ComputeCapableRenderer,
} from './sampler.ts';
