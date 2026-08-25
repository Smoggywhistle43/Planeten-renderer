/**
 * The surface seam: what the renderer asks, and who may answer.
 *
 * The material does not know what the ground is made of. It knows how to ask —
 * "at this direction, this far above sea level, with one pixel covering this
 * much ground, what is the reflectance and how rough is it" — and hands that
 * question to a `SurfaceModel`. Everything about *appearance* lives behind that
 * seam, which is what makes an authored design a thing you can drop in rather
 * than a shader you have to edit.
 *
 * Three answers exist today, and a fourth is the point of the exercise:
 *
 *   `uniformSurface`   one reflectance everywhere. What a measurement wants: the
 *                      acceptance run counts pixels, and a coastline is a large,
 *                      legitimate jump between neighbours that its speckle test
 *                      cannot tell from depth flicker.
 *   `climateSurface`   the procedural one. Temperature and elevation pick a
 *                      role; a `SurfacePalette` says what the role looks like,
 *                      and the palette is uniforms, so it can be swapped between
 *                      frames.
 *   a custom model     anything satisfying the interface.
 *   (later)            measured data: Copernicus elevation, Sentinel-2
 *                      reflectance. It answers the same question, so nothing
 *                      above the seam changes.
 *
 * The `footprint` in the question is the part that is easy to leave out and
 * expensive to add later. It is how much ground one pixel covers, in metres, and
 * it is what lets an answer be *right at the scale it is asked about*: which
 * octaves of relief still matter, and later, which mip level of a texture to
 * read. Without it a surface is either aliased from orbit or blurred on the
 * ground, and there is no way to be both.
 */

import { Fn, float, mix, mx_fractal_noise_float, smoothstep, uniform, vec3 } from 'three/tsl';
import { Vector3 } from 'three/webgpu';
import {
  EARTH_PALETTE,
  FREEZING_POINT,
  ellipsoidMeanRadius,
  seaLevel,
  type Body,
  type SurfacePalette,
} from '@planet/core';
import { heightNode, type FloatNode, type HeightUniforms, type Vec3Node } from './height.ts';

/**
 * Everything a surface model is allowed to know about a place.
 *
 * Deliberately small. A model that needs more than this is reaching for
 * something the renderer has not agreed to provide, and the seam is the right
 * place to have that argument.
 */
export interface SurfacePoint {
  /** Unit direction from the centre, in the body's own frame. */
  readonly direction: Vec3Node;
  /** Metres above sea level. Negative is under the liquid. */
  readonly elevation: FloatNode;
  /**
   * How much ground one pixel covers here, metres.
   *
   * From orbit this is kilometres; standing on the surface it is centimetres.
   * An answer that ignores it is wrong at one end or the other.
   */
  readonly footprint: FloatNode;
}

/**
 * Something that can say what the ground is.
 *
 * Two required questions. `update` points an existing model at a different body
 * without rebuilding the node graph — rebuilding would recompile the shader and
 * stall the frame.
 */
export interface SurfaceModel {
  /** Name, for the overlay and for reports. */
  readonly name: string;
  /** Linear reflectance, RGB. Not a colour — a fraction of incoming light. */
  albedo(point: SurfacePoint): Vec3Node;
  /** 0 is a mirror, 1 is fully diffuse. */
  roughness(point: SurfacePoint): FloatNode;
  /** Push changed body parameters. Must not change the graph's shape. */
  update?(body: Body): void;
  /** Swap the look. Only models that have a palette offer this. */
  setPalette?(palette: SurfacePalette): void;
}

// ------------------------------------------------------------- uniform ------

/**
 * One reflectance over the whole body.
 *
 * Not a placeholder: it is what every geometric measurement in the acceptance
 * run needs, and it is the control that says whether a difference in a picture
 * came from the surface or from somewhere else.
 */
export function uniformSurface(
  albedo: number | readonly [number, number, number] = 0.3,
  roughnessValue = 1,
): SurfaceModel {
  const rgb =
    typeof albedo === 'number'
      ? new Vector3(albedo, albedo, albedo)
      : new Vector3(albedo[0], albedo[1], albedo[2]);
  const colour = uniform(rgb);
  const rough = uniform(roughnessValue, 'float');
  return {
    name: 'uniform',
    albedo: () => vec3(colour) as Vec3Node,
    roughness: () => float(rough) as FloatNode,
  };
}

// ------------------------------------------------------------- climate ------

/**
 * The scale of a regional climate anomaly, in radians of arc.
 *
 * A current or a continental interior is an ocean-basin-sized thing: the Gulf
 * Stream's warm anomaly is a few thousand kilometres across, about 0.4 radians
 * on Earth. Anything much broader only slides the whole ice cap north or south
 * instead of giving its edge a shape — which is what a first attempt at 0.9 did,
 * and the cap stayed a perfect circle.
 */
const ANOMALY_FREQUENCY = 3.2;

function paletteUniforms(palette: SurfacePalette) {
  const rgb = (role: keyof SurfacePalette['roles']): Vector3 => {
    const [r, g, b] = palette.roles[role].albedo;
    return new Vector3(r, g, b);
  };
  return {
    water: uniform(rgb('water')),
    ice: uniform(rgb('ice')),
    snow: uniform(rgb('snow')),
    barren: uniform(rgb('barren')),
    arid: uniform(rgb('arid')),
    fertile: uniform(rgb('fertile')),

    waterRoughness: uniform(palette.roles.water.roughness, 'float'),
    landRoughness: uniform(palette.roles.barren.roughness, 'float'),

    coastBlend: uniform(palette.thresholds.coastBlendMetres, 'float'),
    snowBlend: uniform(palette.thresholds.snowBlendKelvin, 'float'),
    iceBlend: uniform(palette.thresholds.iceBlendKelvin, 'float'),
    aridBelow: uniform(palette.thresholds.aridBelow, 'float'),
    fertileAbove: uniform(palette.thresholds.fertileAbove, 'float'),
    fertileNeeds: uniform(palette.thresholds.fertileNeedsKelvin, 'float'),
  };
}

type PaletteUniforms = ReturnType<typeof paletteUniforms>;

function writePalette(u: PaletteUniforms, palette: SurfacePalette): void {
  const set = (target: { value: Vector3 }, role: keyof SurfacePalette['roles']): void => {
    const [r, g, b] = palette.roles[role].albedo;
    target.value.set(r, g, b);
  };
  set(u.water, 'water');
  set(u.ice, 'ice');
  set(u.snow, 'snow');
  set(u.barren, 'barren');
  set(u.arid, 'arid');
  set(u.fertile, 'fertile');
  u.waterRoughness.value = palette.roles.water.roughness;
  u.landRoughness.value = palette.roles.barren.roughness;
  u.coastBlend.value = palette.thresholds.coastBlendMetres;
  u.snowBlend.value = palette.thresholds.snowBlendKelvin;
  u.iceBlend.value = palette.thresholds.iceBlendKelvin;
  u.aridBelow.value = palette.thresholds.aridBelow;
  u.fertileAbove.value = palette.thresholds.fertileAbove;
  u.fertileNeeds.value = palette.thresholds.fertileNeedsKelvin;
}

function climateUniforms(body: Body) {
  const s = body.surface;
  return {
    equatorTemperature: uniform(s.equatorTemperature, 'float'),
    poleTemperature: uniform(s.poleTemperature, 'float'),
    lapseRate: uniform(s.lapseRate, 'float'),
    humidityFrequency: uniform(s.humidityFrequency, 'float'),
    humidityOffset: uniform(
      new Vector3(s.humidityOffset[0], s.humidityOffset[1], s.humidityOffset[2]),
    ),
    temperatureAnomaly: uniform(s.temperatureAnomaly, 'float'),
    anomalyOffset: uniform(
      new Vector3(s.anomalyOffset[0], s.anomalyOffset[1], s.anomalyOffset[2]),
    ),
    radius: uniform(ellipsoidMeanRadius(body), 'float'),
  };
}

type ClimateUniforms = ReturnType<typeof climateUniforms>;

function writeClimate(u: ClimateUniforms, body: Body): void {
  const s = body.surface;
  u.equatorTemperature.value = s.equatorTemperature;
  u.poleTemperature.value = s.poleTemperature;
  u.lapseRate.value = s.lapseRate;
  u.humidityFrequency.value = s.humidityFrequency;
  u.humidityOffset.value.set(s.humidityOffset[0], s.humidityOffset[1], s.humidityOffset[2]);
  u.temperatureAnomaly.value = s.temperatureAnomaly;
  u.anomalyOffset.value.set(s.anomalyOffset[0], s.anomalyOffset[1], s.anomalyOffset[2]);
  u.radius.value = ellipsoidMeanRadius(body);
}

/**
 * Mean surface temperature at a place, kelvin.
 *
 * The shader's copy of `surfaceTemperature` from `@planet/core`. Two copies of a
 * formula is what this project refuses to do for the *noise*, where drift would
 * be invisible; here the formula is four operations, the TypeScript version
 * exists so it can be checked against real climatology in Node, and
 * `surface.gpu.test.ts` pins the two together across latitudes and altitudes so
 * they cannot part company unnoticed.
 */
export const surfaceTemperatureNode = /*@__PURE__*/ Fn(
  ([sinLatitude, elevation, equator, pole, lapseRate]: [
    FloatNode,
    FloatNode,
    FloatNode,
    FloatNode,
    FloatNode,
  ]) => {
    const drop = float(equator).sub(pole);
    // Fourth power of the sine — see `surfaceTemperature` in @planet/core for
    // why it is not the square.
    const s2 = float(sinLatitude).mul(sinLatitude);
    const atSeaLevel = float(equator).sub(drop.mul(s2).mul(s2));
    return atSeaLevel.sub(float(lapseRate).mul(float(elevation).max(0)));
  },
);

/**
 * How far the local climate departs from its latitude, kelvin.
 *
 * Three octaves: an ocean-basin scale, and two finer ones so a coastline is not
 * a single smooth curve. Not more — past that it stops looking like a climate
 * and starts looking like noise.
 */
export const temperatureAnomalyNode = /*@__PURE__*/ Fn(
  ([dir, amplitude, offset]: [Vec3Node, FloatNode, Vec3Node]) => {
    const p = vec3(dir).mul(ANOMALY_FREQUENCY).add(offset);
    return mx_fractal_noise_float(p, 3, 2.0, 0.5).mul(amplitude);
  },
);

/**
 * How wet a place is, 0 to 1.
 *
 * Its own field, offset away from the terrain, so that dry and wet do not simply
 * track altitude — otherwise every mountain range would be desert and every
 * plain forest, which is not how a planet looks.
 */
export const humidityNode = /*@__PURE__*/ Fn(
  ([dir, frequency, offset]: [Vec3Node, FloatNode, Vec3Node]) => {
    const p = vec3(dir).mul(frequency).add(offset);
    return mx_fractal_noise_float(p, 3, 2.1, 0.5).mul(0.5).add(0.5).clamp(0, 1);
  },
);

/**
 * The procedural surface: temperature and elevation choose a role, the palette
 * says what the role looks like.
 *
 * The rule, in one sentence: **temperature decides.** It falls towards the poles
 * and falls with altitude, and the rest follows — liquid below sea level, ice
 * where the liquid freezes, snow above the snow line, and otherwise land running
 * from arid to fertile with how wet it is. One physical idea rather than a stack
 * of masks, which is why ice sits at the poles *and* on the peaks without
 * anything being told to put it there.
 *
 * Everything blends with `smoothstep` rather than switching. A hard threshold on
 * a height field gives a coastline one pixel wide that crawls when the camera
 * moves, and a snow line that looks drawn with a ruler. The blend widths come
 * from the palette and are in the units of the thing they blend — metres of
 * elevation, kelvin of temperature — so they mean something to whoever sets
 * them.
 */
export function climateSurface(
  body: Body,
  palette: SurfacePalette = EARTH_PALETTE,
): SurfaceModel {
  const climate = climateUniforms(body);
  const p = paletteUniforms(palette);
  let currentBody = body;
  let currentName = palette.name;

  /** Temperature and humidity at a point. Shared by both answers. */
  const conditions = (point: SurfacePoint): { temperature: FloatNode; humidity: FloatNode } => {
    const zonal = surfaceTemperatureNode(
      point.direction.y,
      point.elevation,
      climate.equatorTemperature,
      climate.poleTemperature,
      climate.lapseRate,
    ) as FloatNode;
    // Latitude alone would draw every ice edge as a circle. The anomaly is what
    // makes a place differ from its latitude — see `SurfaceParams`.
    const temperature = zonal.add(
      temperatureAnomalyNode(point.direction, climate.temperatureAnomaly, climate.anomalyOffset),
    ) as FloatNode;
    const humidity = humidityNode(
      point.direction,
      climate.humidityFrequency,
      climate.humidityOffset,
    ) as FloatNode;
    return { temperature, humidity };
  };

  const model: SurfaceModel = {
    get name() {
      return `climate:${currentName}`;
    },

    albedo(point: SurfacePoint): Vec3Node {
      const { temperature, humidity } = conditions(point);

      // ---- land: dry to wet ----------------------------------------------
      const dryness = smoothstep(p.fertileAbove, p.aridBelow, humidity);
      const wetness = smoothstep(p.aridBelow, p.fertileAbove, humidity);
      // Nothing grows in the cold, however wet it is. Without this, tundra
      // looks like jungle.
      const warmEnough = smoothstep(
        float(FREEZING_POINT).sub(5),
        float(FREEZING_POINT).add(p.fertileNeeds),
        temperature,
      );
      const land = mix(
        mix(vec3(p.barren), vec3(p.arid), dryness),
        vec3(p.fertile),
        wetness.mul(warmEnough),
      );

      // ---- liquid: flowing or frozen --------------------------------------
      const frozen = smoothstep(
        float(FREEZING_POINT),
        float(FREEZING_POINT).sub(p.iceBlend),
        temperature,
      );
      const liquid = mix(vec3(p.water), vec3(p.ice), frozen);

      // ---- coastline -------------------------------------------------------
      const onLand = smoothstep(0, p.coastBlend, point.elevation);
      const ground = mix(liquid, land, onLand);

      // ---- snow, on land only ----------------------------------------------
      // The liquid already has its own frozen form, so this is masked to land,
      // or the ice caps would be covered twice and come out brighter than snow
      // can be.
      const snowCover = smoothstep(
        float(FREEZING_POINT),
        float(FREEZING_POINT).sub(p.snowBlend),
        temperature,
      ).mul(onLand);
      return mix(ground, vec3(p.snow), snowCover) as Vec3Node;
    },

    roughness(point: SurfacePoint): FloatNode {
      // One distinction matters at this scale and it is a large one: liquid is
      // smooth and everything else is not. A smooth surface returns light in a
      // direction rather than in all of them, which is what puts a glint on an
      // ocean and nothing on a continent.
      const onLand = smoothstep(0, p.coastBlend, point.elevation);
      return mix(p.waterRoughness, p.landRoughness, onLand) as FloatNode;
    },

    update(next: Body): void {
      currentBody = next;
      writeClimate(climate, next);
    },

    setPalette(next: SurfacePalette): void {
      currentName = next.name;
      writePalette(p, next);
    },
  };

  void currentBody;
  return model;
}

/**
 * Swap the look of a running model without recompiling anything.
 *
 * The whole point of keeping the palette in uniforms: an authored design drops
 * in between frames, and the difference is visible immediately instead of after
 * a rebuild. Returns false for a model that has no palette to swap.
 */
export function applyPalette(model: SurfaceModel, palette: SurfacePalette): boolean {
  if (typeof model.setPalette !== 'function') return false;
  model.setPalette(palette);
  return true;
}

/** Metres above sea level at a direction. */
export function elevationNode(dir: Vec3Node, h: HeightUniforms, body: Body): FloatNode {
  return heightNode(dir, h).sub(seaLevel(body.surface, body.terrain.amplitude)) as FloatNode;
}
