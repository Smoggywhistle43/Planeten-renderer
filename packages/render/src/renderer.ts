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

import { NoToneMapping, WebGPURenderer } from 'three/webgpu';

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

  // The scene buffer holds real luminance in cd/m^2, so nothing may squash it
  // on the way out. Exposure and tone mapping happen in the node graph instead
  // (see `post.ts`), where a compute pass can later drive the exposure without
  // a read back. Leaving three's own tone mapping on would map twice.
  renderer.toneMapping = NoToneMapping;

  // Compute the model-view matrix on the CPU, in float64, and narrow the
  // product once — instead of narrowing the view and world matrices separately
  // and multiplying them in float32 in the shader.
  //
  // three defaults to the shader-side product (`mediumpModelViewMatrix`). For
  // this engine that default happens to be nearly harmless, because the camera
  // matrix is a pure rotation and the object matrix is already camera-relative,
  // so neither operand is ever large. But "happens to be" is an invariant
  // nobody enforces: the moment a tile is parented under a transformed group,
  // or the camera is allowed off the origin, the shader-side product starts
  // multiplying large float32 numbers and the error is invisible until it is
  // not. Measured on a tile 1 km away, the CPU path is 14x more accurate
  // (5 um vs 70 um); see `model-view-precision.test.ts`.
  //
  // Costs nothing here: the flag is incompatible only with InstancedMesh and
  // SkinnedMesh, and this engine uses neither. It also moves the normal matrix
  // onto the same CPU path, which `transformNormalToView` picks up.
  renderer.highPrecision = true;

  await renderer.init();
  assertReversedDepth(renderer);
  assertHighPrecisionModelView(renderer);
  return renderer;
}

/**
 * Fail if the model-view matrix is being formed in the shader rather than on
 * the CPU. See the note in `createPlanetRenderer`.
 */
export function assertHighPrecisionModelView(renderer: WebGPURenderer): void {
  if (renderer.highPrecision !== true) {
    throw new Error(
      'createPlanetRenderer: high-precision model-view is not active. The ' +
        'model-view matrix would be formed from two separately narrowed float32 ' +
        'matrices in the shader, which silently loses precision as soon as either ' +
        'of them stops being small.',
    );
  }
}

/** Which arithmetic produces the model-view matrix the shader receives. */
export interface ModelViewPrecision {
  readonly highPrecision: boolean;
  /**
   * `cpu-float64` — the product is formed in JS in float64 and narrowed once.
   * `gpu-float32` — view and world are narrowed separately and multiplied in
   * the shader, so the error scales with whichever of them is larger.
   */
  readonly path: 'cpu-float64' | 'gpu-float32';
}

export function describeModelViewPrecision(renderer: WebGPURenderer): ModelViewPrecision {
  const high = renderer.highPrecision === true;
  return { highPrecision: high, path: high ? 'cpu-float64' : 'gpu-float32' };
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

/**
 * Fail if something switched three's own tone mapping back on. It would run
 * after the node graph's, and the result looks like a washed-out bug rather
 * than a configuration mistake.
 */
export function assertLinearOutput(renderer: WebGPURenderer): void {
  if (renderer.toneMapping !== NoToneMapping) {
    throw new Error(
      'createPlanetRenderer: renderer.toneMapping must stay NoToneMapping. ' +
        'Exposure and tone mapping belong to the node graph in post.ts; leaving ' +
        'the renderer to do it as well maps the image twice.',
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
