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
  float,
  materialColor,
  mix,
  normalLocal,
  positionLocal,
  positionView,
  transformNormalToView,
  uniform,
  vec3,
} from 'three/tsl';
import {
  climateSurface,
  createHeightUniforms,
  footprintToAngle,
  heightNode,
  pixelFootprint,
  surfaceNormalNode,
  updateHeightUniforms,
  type HeightUniforms,
  type SurfaceModel,
  type SurfacePoint,
} from '@planet/field';
import { ALBEDO, seaLevel, type Body } from '@planet/core';
import type { Node } from 'three/webgpu';

export interface PlanetMaterialOptions {
  /**
   * One albedo for the whole body: the fraction of incoming light it reflects,
   * 0..1, in linear light. Not a colour picked to look nice — a measured
   * reflectance. See `ALBEDO` in `@planet/core`.
   *
   * Passing this switches the surface off and paints the body a single
   * reflectance. That is what the photometry test wants (it fits a line through
   * five known albedos and needs each render to have exactly one) and what the
   * acceptance run wants (it counts pixels, and an ocean next to a snowfield is
   * not a shape measurement). **Leave it out for a real picture**, and the
   * surface function decides the reflectance per place.
   *
   * Together with a directional light whose intensity is an illuminance in lux,
   * either way makes the framebuffer hold luminance in cd/m^2.
   */
  readonly albedo?: number | readonly [number, number, number];
  /**
   * One roughness for the whole body. Without it, the surface model decides —
   * and liquid being smooth while land is not is what a sun glint is made of.
   */
  readonly roughness?: number;
  readonly metalness?: number;
  /**
   * Who decides what the ground looks like.
   *
   * Defaults to `climateSurface(body)`, the procedural one. Hand in a different
   * model — an authored palette, or later measured Earth data — and nothing in
   * this file changes: the material asks the same question and does not know
   * who is answering.
   *
   * Ignored when `albedo` is given, which is a shorthand for "one reflectance,
   * no surface at all".
   */
  readonly surface?: SurfaceModel;
}

export interface PlanetMaterialHandle {
  readonly material: MeshStandardNodeMaterial;
  readonly heightUniforms: HeightUniforms;
  /** Who is deciding what the ground looks like. */
  readonly surface: SurfaceModel;
  /** Whether the ground varies from place to place, or is one flat reflectance. */
  readonly proceduralSurface: boolean;
  /** Retarget at another body without recompiling the shader. */
  setBody(body: Body): void;
  /** Blend in per-tile LOD depth colouring. 0 is off, 1 is full. */
  setLodDebug(amount: number): void;
  /**
   * How much of the ground's own reflectance to show. 1 is the real surface,
   * 0 is one flat albedo over the whole body. No effect on a material built
   * with a fixed `albedo`.
   */
  setSurfaceMix(amount: number): void;
  /** Scale the height field at runtime, 0 leaves an exact sphere. */
  setHeightScale(scale: number): void;
  dispose(): void;
}

export function createPlanetMaterial(
  body: Body,
  options: PlanetMaterialOptions = {},
): PlanetMaterialHandle {
  const proceduralSurface = options.albedo === undefined;
  const heightUniforms = createHeightUniforms(body);
  const surface = options.surface ?? climateSurface(body);
  const lodDebug = uniform(0, 'float');
  // How much of the ground's own reflectance to use, against the single
  // whole-body albedo. One is the real picture; zero is a plain grey body,
  // which is what the acceptance run measures geometry against — a coastline
  // is a large, legitimate difference between neighbouring pixels, and the
  // speckle test cannot tell that from depth flicker.
  const surfaceMix = uniform(proceduralSurface ? 1 : 0, 'float');
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
  // `tileInfo.y` is the tile's own vertex spacing in radians. The material no
  // longer reads it: shading takes its step from the pixel footprint instead,
  // for the reason given at `material.normalNode` below. The tile still carries
  // it because it describes the mesh, and the mesh is what the *vertex* stage
  // can represent — band-limiting the displacement to it is the next piece of
  // this, and is listed in STATE.md as open.

  // Where the liquid stands, in metres. The one number the material needs from
  // the climate, because elevation is measured from it and the surface model is
  // handed elevation rather than raw height.
  const seaLevelMetres = uniform(seaLevel(body.surface, body.terrain.amplitude), 'float');

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
  //
  // The step the gradient is taken over comes from the **pixel footprint**, not
  // from the tile's vertex spacing. A tile carries a fixed number of vertices
  // however close the camera gets, so vertex spacing stops shrinking once you
  // are nearer than the mesh is fine — and detail derived from it stops
  // improving exactly when it starts mattering. The footprint keeps shrinking
  // all the way down, and shading is the only place detail can still be added
  // once the geometry has run out.
  const footprint = pixelFootprint(positionView as Node<'vec3'>);
  const shadingStep = footprintToAngle(footprint, heightUniforms.radius);

  material.normalNode = transformNormalToView(
    surfaceNormalNode(direction, normalLocal as Node<'vec3'>, heightUniforms, shadingStep),
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

  // The question the material asks the surface. Everything past this point is
  // the model's business, not the material's: what the ground is made of, how
  // it varies, and later whether it comes from noise or from a satellite.
  //
  // `direction` is a varying here, so all of it runs per pixel.
  const point: SurfacePoint = {
    direction,
    elevation: heightNode(direction, heightUniforms).sub(seaLevelMetres),
    footprint,
  };

  // What comes back is a linear reflectance, not a colour: it multiplies the
  // illuminance the light delivers, so the framebuffer still holds cd/m^2.
  const groundColor = (
    proceduralSurface ? mix(materialColor, surface.albedo(point), surfaceMix) : materialColor
  ) as Node<'vec3'>;
  material.colorNode = mix(groundColor, lodColor, lodDebug);

  if (proceduralSurface && options.roughness === undefined) {
    material.roughnessNode = mix(
      float(material.roughness),
      surface.roughness(point),
      surfaceMix,
    );
  }

  return {
    material,
    heightUniforms,
    surface,
    proceduralSurface,
    setBody(next: Body): void {
      updateHeightUniforms(heightUniforms, next);
      seaLevelMetres.value = seaLevel(next.surface, next.terrain.amplitude);
      surface.update?.(next);
    },
    setLodDebug(amount: number): void {
      lodDebug.value = Math.min(1, Math.max(0, amount));
    },
    setSurfaceMix(amount: number): void {
      if (!proceduralSurface) return;
      surfaceMix.value = Math.min(1, Math.max(0, amount));
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
