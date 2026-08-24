/**
 * Renderer setup, with reversed-Z.
 *
 * The handoff asks for a 0..1 depth range, `depthCompare: 'greater'` and a
 * clear depth of 0. Three r185 does all three behind `reversedDepthBuffer`:
 * the projection matrix maps near to 1 and far to 0, the clear value flips to
 * 0, `LessEqualDepth` maps to `GreaterEqual` in the pipeline descriptor, and
 * the depth attachment becomes `depth32float`.
 *
 * Combined with a camera at the origin, that removes the two usual sources of
 * z-fighting at planetary scale: the 1/z bunching of a conventional depth
 * buffer, and the float32 blow-up of large view-space coordinates.
 *
 * `assertReversedDepth` exists because the flag can silently fall back. A
 * silent fallback would look like a rendering bug days later.
 */

import { WebGPURenderer } from 'three/webgpu';

/**
 * `isWebGPUBackend` is a runtime flag three sets on the backend; the published
 * type definitions do not carry it. One cast, in one place.
 */
function isWebGpuBackend(renderer: WebGPURenderer): boolean {
  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean } | undefined;
  return backend?.isWebGPUBackend === true;
}

export interface PlanetRendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly antialias?: boolean;
  /** Device pixel ratio. The acceptance target is 2 on the reference machine. */
  readonly pixelRatio?: number;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Create and initialise the renderer. Throws if the backend is not WebGPU or if
 * reversed-Z did not take — no quiet WebGL fallback.
 */
export async function createPlanetRenderer(
  options: PlanetRendererOptions,
): Promise<WebGPURenderer> {
  const renderer = new WebGPURenderer({
    canvas: options.canvas,
    antialias: options.antialias ?? true,
    reversedDepthBuffer: true,
  });

  renderer.setPixelRatio(options.pixelRatio ?? globalThis.devicePixelRatio ?? 1);
  if (options.width !== undefined && options.height !== undefined) {
    renderer.setSize(options.width, options.height, false);
  }
  renderer.setClearColor(0x000000, 1);

  await renderer.init();
  assertReversedDepth(renderer);
  return renderer;
}

/**
 * Fail loudly if the renderer is not the one this engine is built for.
 *
 * `forceWebGL` and the automatic WebGL fallback both produce a working picture
 * with the wrong depth behaviour, which is exactly the kind of thing that gets
 * mistaken for a precision bug in the tile code.
 */
export function assertReversedDepth(renderer: WebGPURenderer): void {
  if (!isWebGpuBackend(renderer)) {
    throw new Error(
      'createPlanetRenderer: the backend is not WebGPU. This engine targets ' +
        'three/webgpu with reversed-Z; a WebGL fallback is not supported.',
    );
  }
  if (renderer.reversedDepthBuffer !== true) {
    throw new Error(
      'createPlanetRenderer: reversed depth buffer is not active. Depth ' +
        'precision at planetary scale depends on it; refusing to run without.',
    );
  }
}

/** What the depth configuration actually resolved to. For the overlay. */
export interface DepthConfiguration {
  readonly backend: string;
  readonly reversedDepth: boolean;
  /** Clear value the renderer will use. 0 under reversed-Z. */
  readonly clearDepth: number;
  /** Comparison the pipeline will use for an opaque material. */
  readonly depthCompare: 'greater-equal' | 'less-equal';
}

export function describeDepth(renderer: WebGPURenderer): DepthConfiguration {
  const reversed = renderer.reversedDepthBuffer === true;
  return {
    backend: isWebGpuBackend(renderer) ? 'webgpu' : 'unknown',
    reversedDepth: reversed,
    clearDepth: renderer.getClearDepth(),
    depthCompare: reversed ? 'greater-equal' : 'less-equal',
  };
}
