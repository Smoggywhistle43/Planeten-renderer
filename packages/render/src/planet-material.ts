/**
 * The tile material. All shading is TSL — no GLSL, no `ShaderMaterial`, no
 * `onBeforeCompile`.
 *
 * One material serves every tile. That works because a tile's place on the
 * planet is carried by its object matrix — the body's rotation, then a
 * camera-relative translation, see `Planet.update` — rather than by a per-tile
 * uniform, so the node graph is identical for all of them and compiles once.
 *
 * The vertex stage does two things:
 *   - displaces along the vertex direction by the height field, and
 *   - derives the surface normal from the same field.
 * Both call into `@planet/field`. There is no second copy of the terrain
 * function here.
 */

import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  attribute,
  materialColor,
  mix,
  normalLocal,
  positionLocal,
  transformNormalToView,
  uniform,
  vec3,
} from 'three/tsl';
import {
  createHeightUniforms,
  heightNode,
  surfaceNormalNode,
  updateHeightUniforms,
  type HeightUniforms,
} from '@planet/field';
import { ALBEDO, type Body } from '@planet/core';
import type { Node } from 'three/webgpu';

export interface PlanetMaterialOptions {
  /**
   * Albedo: the fraction of incoming light the surface reflects, 0..1, in
   * linear light. Not a colour picked to look nice — a measured reflectance.
   * See `ALBEDO` in `@planet/core`. Defaults to Earth's mean, 0.30.
   *
   * Together with a directional light whose intensity is an illuminance in
   * lux, this makes the framebuffer hold luminance in cd/m^2.
   */
  readonly albedo?: number | readonly [number, number, number];
  readonly roughness?: number;
  readonly metalness?: number;
}

export interface PlanetMaterialHandle {
  readonly material: MeshStandardNodeMaterial;
  readonly heightUniforms: HeightUniforms;
  /** Retarget at another body without recompiling the shader. */
  setBody(body: Body): void;
  /** Blend in per-tile LOD depth colouring. 0 is off, 1 is full. */
  setLodDebug(amount: number): void;
  /** Scale the height field at runtime, 0 leaves an exact sphere. */
  setHeightScale(scale: number): void;
  dispose(): void;
}

export function createPlanetMaterial(
  body: Body,
  options: PlanetMaterialOptions = {},
): PlanetMaterialHandle {
  const heightUniforms = createHeightUniforms(body);
  const lodDebug = uniform(0, 'float');
  const heightScale = uniform(1, 'float');

  const material = new MeshStandardNodeMaterial();
  const albedo = options.albedo ?? ALBEDO.earthMean;
  // `setRGB` without a colour space writes linear values straight through.
  // `setHex` would treat them as sRGB and silently apply a gamma curve, which
  // would turn a measured 0.30 reflectance into 0.07.
  if (typeof albedo === 'number') {
    material.color.setRGB(albedo, albedo, albedo);
  } else {
    material.color.setRGB(albedo[0], albedo[1], albedo[2]);
  }
  material.roughness = options.roughness ?? 1;
  material.metalness = options.metalness ?? 0;

  // `attribute()` is typed loosely because the node type is a runtime string;
  // these two casts are the only place the tile vertex layout is asserted.
  const direction = attribute('direction', 'vec3') as Node<'vec3'>;
  const tileInfo = attribute('tileInfo', 'vec2') as Node<'vec2'>;
  const depth = tileInfo.x;
  const angularStep = tileInfo.y;

  const displacement = heightNode(direction, heightUniforms).mul(heightScale);

  // Positions arrive relative to the tile origin; the displacement is metres.
  // Both are small, so this addition happens well inside float32's comfortable
  // range. No absolute world coordinate appears anywhere in this expression.
  material.positionNode = positionLocal.add(direction.mul(displacement));

  // Everything in the vertex stage is body-fixed: the tile grid, the direction
  // the height field is sampled along, and the `normal` attribute, which holds
  // which way the undisplaced ground faces. On a flattened body that is not the
  // same as the direction from the centre, so it is carried as its own
  // attribute rather than reconstructed.
  //
  // `normalNode` wants view space. The object matrix now carries the body's
  // rotation as well as the camera-relative translation, so handing the
  // body-fixed normal to `transformNormalToView` applies the body's turn and
  // the camera's orientation in one step — which is what makes the terrain turn
  // with the planet instead of sliding across it.
  material.normalNode = transformNormalToView(
    surfaceNormalNode(direction, normalLocal as Node<'vec3'>, heightUniforms, angularStep),
  );

  // Debug colouring rides a uniform rather than a second shader, so toggling it
  // costs nothing and cannot drift from what is actually rendered.
  //
  // Fully saturated hues, stepped by the golden ratio so consecutive depths land
  // far apart on the wheel. Pastels would wash out under the lighting and two
  // neighbouring levels would look the same, which defeats the point.
  const hue = depth.mul(0.618034).fract();
  const lodColor = vec3(
    hue.add(1).fract().mul(6).sub(3).abs().sub(1).clamp(0, 1),
    hue.add(2 / 3).fract().mul(6).sub(3).abs().sub(1).clamp(0, 1),
    hue.add(1 / 3).fract().mul(6).sub(3).abs().sub(1).clamp(0, 1),
  );
  material.colorNode = mix(materialColor, lodColor, lodDebug);

  return {
    material,
    heightUniforms,
    setBody(next: Body): void {
      updateHeightUniforms(heightUniforms, next);
    },
    setLodDebug(amount: number): void {
      lodDebug.value = Math.min(1, Math.max(0, amount));
    },
    setHeightScale(scale: number): void {
      heightScale.value = scale;
    },
    dispose(): void {
      material.dispose();
    },
  };
}

/** Exposed for tests: the attribute names the material expects on a tile. */
export const TILE_ATTRIBUTES = Object.freeze({
  position: 'position',
  normal: 'normal',
  direction: 'direction',
  tileInfo: 'tileInfo',
} as const);
