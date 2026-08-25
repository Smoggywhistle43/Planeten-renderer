/**
 * The height field. One implementation, written once, in TSL.
 *
 * Two consumers use *this exact node*:
 *   1. `@planet/render` calls it from the tile vertex stage.
 *   2. `HeightSampler` in this package compiles it into a compute kernel and
 *      reads the result back, for whenever the CPU needs a height.
 *
 * There is deliberately no TypeScript version of the noise. If the CPU wants a
 * number it goes through the GPU, because the moment there are two
 * implementations they drift and the terrain stops matching the collision.
 */

import { Fn, float, mx_fractal_noise_float, normalize, select, uniform, vec3 } from 'three/tsl';
import { Vector3, type Node } from 'three/webgpu';
import { ellipsoidMeanRadius, type Body } from '@planet/core';

/** Shorthand for a TSL expression of the given type. */
export type Vec3Node = Node<'vec3'>;
export type FloatNode = Node<'float'>;
export type UintNode = Node<'uint'>;

/**
 * Uniform bundle for one body. Created once, updated in place — swapping bodies
 * must not recompile the material.
 */
export function createHeightUniforms(body: Body) {
  const t = body.terrain;
  return {
    /** Peak displacement in metres, already divided by the fBm gain sum. */
    amplitude: uniform(normalizedAmplitude(body), 'float'),
    /** Cycles per unit sphere radius at the base octave. */
    frequency: uniform(t.frequency, 'float'),
    /** fBm octave count. `uint` because the MaterialX node converts it to int. */
    octaves: uniform(t.octaves, 'uint'),
    /** Frequency multiplier per octave. */
    lacunarity: uniform(t.lacunarity, 'float'),
    /** Amplitude multiplier per octave. */
    gain: uniform(t.gain, 'float'),
    /** Domain offset, so two bodies with the same shape parameters differ. */
    offset: uniform(new Vector3(t.offset[0], t.offset[1], t.offset[2])),
    /** Mean radius in metres. Needed to turn a height gradient into a normal. */
    radius: uniform(ellipsoidMeanRadius(body), 'float'),
  };
}

export type HeightUniforms = ReturnType<typeof createHeightUniforms>;

/**
 * Sum of the fBm octave amplitudes, so the raw noise lands in roughly [-1, 1]
 * and `terrain.amplitude` means metres of relief rather than "some multiple of
 * metres that depends on the octave count".
 */
function gainSum(octaves: number, gain: number): number {
  if (gain === 1) return octaves;
  return (1 - gain ** octaves) / (1 - gain);
}

function normalizedAmplitude(body: Body): number {
  const t = body.terrain;
  const sum = gainSum(t.octaves, t.gain);
  return sum === 0 ? 0 : t.amplitude / sum;
}

/** Point the uniform bundle at a different body, without recompiling anything. */
export function updateHeightUniforms(u: HeightUniforms, body: Body): void {
  const t = body.terrain;
  u.amplitude.value = normalizedAmplitude(body);
  u.frequency.value = t.frequency;
  u.octaves.value = t.octaves;
  u.lacunarity.value = t.lacunarity;
  u.gain.value = t.gain;
  u.offset.value.set(t.offset[0], t.offset[1], t.offset[2]);
  u.radius.value = ellipsoidMeanRadius(body);
}

/**
 * Displacement above the mean radius, in metres, for a unit direction.
 *
 * Mirrors `sampleHeight(dirOnUnitSphere, bodyParams)` from the handoff. The
 * body parameters arrive as loose nodes rather than a struct so that one
 * compiled shader serves every body — see `heightNode` for the ergonomic form.
 */
export const surfaceHeight = /*@__PURE__*/ Fn(
  ([dir, amplitude, frequency, octaves, lacunarity, gain, offset]: [
    Vec3Node,
    FloatNode,
    FloatNode,
    UintNode,
    FloatNode,
    FloatNode,
    Vec3Node,
  ]) => {
    const p = vec3(dir).mul(frequency).add(offset);
    return mx_fractal_noise_float(p, octaves, lacunarity, gain).mul(amplitude);
  },
);

/** `surfaceHeight` with the uniform bundle spread for you. Metres. */
export function heightNode(dir: Vec3Node, u: HeightUniforms): FloatNode {
  return surfaceHeight(
    dir,
    u.amplitude,
    u.frequency,
    u.octaves,
    u.lacunarity,
    u.gain,
    u.offset,
  ) as FloatNode;
}

/**
 * A tangent to `dir`, chosen from whichever cardinal axis is least aligned with
 * it. One `select`, no degenerate cases: both branches keep the cross product
 * above 0.43 in magnitude.
 */
function tangentTo(dir: Vec3Node): Vec3Node {
  const axis = select(dir.z.abs().lessThan(0.9), vec3(0, 0, 1), vec3(1, 0, 0)) as Vec3Node;
  return normalize(vec3(dir).cross(axis)) as Vec3Node;
}

/**
 * Surface normal including the height gradient.
 *
 * Four extra taps of `surfaceHeight` along two tangents give the tangential
 * gradient, converted from "metres of height per radian" to "metres per metre
 * of arc" by dividing through the radius. With `amplitude` at zero every tap
 * returns zero and this collapses to `baseNormal` exactly — which is why a body
 * with no relief comes out perfectly smooth.
 *
 * `dir` is the direction from the centre, which is what the height field is a
 * function of. `baseNormal` is which way the ground faces before any relief:
 * the same thing on a sphere, but tilted away from `dir` by up to 11.5
 * arcminutes on Earth and a degree and a half on Saturn. The gradient is built
 * in the plane across `dir` and applied to `baseNormal`; the two planes differ
 * by that same fraction of a degree, which is far below the accuracy of a
 * four-tap difference.
 *
 * `angularStep` should be about one vertex spacing, in radians.
 */
export function surfaceNormalNode(
  dir: Vec3Node,
  baseNormal: Vec3Node,
  u: HeightUniforms,
  angularStep: FloatNode,
): Vec3Node {
  const d = vec3(dir).toVar();
  const t1 = tangentTo(d).toVar();
  const t2 = normalize(vec3(d).cross(t1)).toVar();
  const step = float(angularStep).toVar();

  const hx = heightNode(normalize(d.add(t1.mul(step))) as Vec3Node, u).sub(
    heightNode(normalize(d.sub(t1.mul(step))) as Vec3Node, u),
  );
  const hy = heightNode(normalize(d.add(t2.mul(step))) as Vec3Node, u).sub(
    heightNode(normalize(d.sub(t2.mul(step))) as Vec3Node, u),
  );

  const arc = step.mul(2).mul(u.radius);
  const grad = t1.mul(hx.div(arc)).add(t2.mul(hy.div(arc)));
  return normalize(vec3(baseNormal).sub(grad)) as Vec3Node;
}
