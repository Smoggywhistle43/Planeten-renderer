/**
 * The camera that keeps precision rule 3: the camera is at (0, 0, 0) and the
 * world moves.
 *
 * `PlanetCamera` holds a float64 world position. The `three` camera it drives
 * never leaves the origin — only its orientation is set. Everything drawn is
 * positioned relative to this camera, so the float32 numbers that reach the GPU
 * are distances to the viewer, which are small where it matters and only large
 * where nobody can tell.
 */

import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';
import { Frame, Vec3d } from '@planet/core';

export interface PlanetCameraOptions {
  /** Vertical field of view, radians. Default 50 degrees. */
  readonly fovY?: number;
  /**
   * Near plane, metres. Can be small: with reversed-Z and a float32 depth
   * buffer, depth precision barely depends on the near/far ratio.
   */
  readonly near?: number;
  /** Far plane, metres. Effectively infinity under reversed-Z. */
  readonly far?: number;
  readonly aspect?: number;
  /** Drift before the floating origin follows the camera, metres. */
  readonly rebaseThreshold?: number;
}

const DEG = 180 / Math.PI;

export class PlanetCamera {
  /** World position, float64. The only authoritative camera position. */
  readonly position = new Vec3d();

  /** World orientation. Applied to the `three` camera as-is. */
  readonly orientation = new Quaternion();

  /** Floating origin. Follows the camera once it drifts past the threshold. */
  readonly frame: Frame;

  /** The `three` camera. Always at the origin; never move it directly. */
  readonly three: PerspectiveCamera;

  private readonly scratchVec = new Vec3d();
  private readonly scratchMatrix = new Matrix4();
  private readonly scratchThreeVec = new Vector3();

  constructor(options: PlanetCameraOptions = {}) {
    const fovY = options.fovY ?? (50 / DEG);
    this.three = new PerspectiveCamera(
      fovY * DEG,
      options.aspect ?? 1,
      options.near ?? 0.05,
      options.far ?? 1e12,
    );
    this.frame = new Frame({ threshold: options.rebaseThreshold ?? 4096 });
    this.update();
  }

  /** Vertical field of view, radians. */
  get fovY(): number {
    return this.three.fov / DEG;
  }

  set fovY(radians: number) {
    this.three.fov = radians * DEG;
    this.three.updateProjectionMatrix();
  }

  get aspect(): number {
    return this.three.aspect;
  }

  get near(): number {
    return this.three.near;
  }

  get far(): number {
    return this.three.far;
  }

  setViewport(width: number, height: number): void {
    const aspect = height > 0 ? width / height : 1;
    if (aspect === this.three.aspect) return;
    this.three.aspect = aspect;
    this.three.updateProjectionMatrix();
  }

  /**
   * Push the float64 state into the `three` camera and let the floating origin
   * catch up. Call once per frame, before rendering.
   *
   * Returns true if the origin rebased this frame.
   */
  update(): boolean {
    const rebased = this.frame.update(this.position);
    // Position stays at zero. This is the whole point: the view matrix is a
    // pure rotation, so nothing large ever enters the model-view product.
    this.three.position.set(0, 0, 0);
    this.three.quaternion.copy(this.orientation);
    this.three.scale.set(1, 1, 1);
    this.three.updateMatrix();
    this.three.updateMatrixWorld(true);
    return rebased;
  }

  /** Unit forward vector (the camera looks down its local -Z), world axes. */
  forward(out: Vec3d = new Vec3d()): Vec3d {
    const v = this.scratchThreeVec.set(0, 0, -1).applyQuaternion(this.orientation);
    return out.set(v.x, v.y, v.z);
  }

  /** Unit up vector, world axes. */
  up(out: Vec3d = new Vec3d()): Vec3d {
    const v = this.scratchThreeVec.set(0, 1, 0).applyQuaternion(this.orientation);
    return out.set(v.x, v.y, v.z);
  }

  /** Unit right vector, world axes. */
  right(out: Vec3d = new Vec3d()): Vec3d {
    const v = this.scratchThreeVec.set(1, 0, 0).applyQuaternion(this.orientation);
    return out.set(v.x, v.y, v.z);
  }

  /**
   * Aim at a world position. The direction is computed in float64 first, so
   * aiming at a point one metre away from 1e9 metres out still works.
   */
  lookAt(targetWorld: Vec3d, upHint: Vec3d = WORLD_UP): void {
    const dir = this.scratchVec.subVectors(targetWorld, this.position);
    if (dir.lengthSq() === 0) return;
    dir.normalize();

    // Degenerate when the hint is parallel to the view direction; nudge it.
    let ux = upHint.x;
    let uy = upHint.y;
    let uz = upHint.z;
    if (Math.abs(dir.x * ux + dir.y * uy + dir.z * uz) > 0.9999) {
      ux = 0;
      uy = 0;
      uz = 1;
      if (Math.abs(dir.z) > 0.9999) {
        ux = 1;
        uy = 0;
        uz = 0;
      }
    }

    this.scratchMatrix.lookAt(
      this.scratchThreeVec.set(0, 0, 0),
      TEMP_TARGET.set(dir.x, dir.y, dir.z),
      TEMP_UP.set(ux, uy, uz),
    );
    this.orientation.setFromRotationMatrix(this.scratchMatrix);
  }

  /**
   * Camera-relative position, float32. The single narrowing in the render path;
   * see `Frame.toCameraRelative32`.
   */
  cameraRelative(world: Vec3d, out: Vector3 = new Vector3()): Vector3 {
    out.set(
      world.x - this.position.x,
      world.y - this.position.y,
      world.z - this.position.z,
    );
    return out;
  }

  /** Distance from a body's centre, metres. */
  distanceFromCentre(bodyCenter: Vec3d): number {
    return this.position.distanceTo(bodyCenter);
  }

  /** Height above a body's mean surface, metres. Negative below it. */
  altitudeAbove(bodyCenter: Vec3d, radius: number): number {
    return this.distanceFromCentre(bodyCenter) - radius;
  }

  /**
   * Place the camera on a radial from a body's centre at a given altitude, and
   * point it at the centre. Used by the scripted acceptance flight, where the
   * camera has to land on an exact altitude rather than approximately one.
   */
  placeAtAltitude(
    bodyCenter: Vec3d,
    direction: Vec3d,
    altitude: number,
    radius: number,
  ): void {
    const unit = direction.clone().normalize();
    this.position.set(
      bodyCenter.x + unit.x * (radius + altitude),
      bodyCenter.y + unit.y * (radius + altitude),
      bodyCenter.z + unit.z * (radius + altitude),
    );
    this.lookAt(bodyCenter, unit);
  }

  /** Pixels subtended by one radian at the centre of the viewport. */
  pixelsPerRadian(screenHeight: number): number {
    return screenHeight / (2 * Math.tan(this.fovY / 2));
  }
}

const TEMP_TARGET = /*@__PURE__*/ new Vector3();
const TEMP_UP = /*@__PURE__*/ new Vector3();
const WORLD_UP = /*@__PURE__*/ new Vec3d(0, 1, 0);
