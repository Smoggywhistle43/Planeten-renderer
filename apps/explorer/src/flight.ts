/**
 * The scripted descent from acceptance criterion 4: 1e9 m down to 1e3 m above
 * the surface.
 *
 * Altitude is interpolated geometrically, not linearly — a linear ramp would
 * spend 99.9% of its time above 1e6 m and cross the interesting six decades in
 * the last fraction of a second. Geometrically, every decade gets the same
 * share of the flight, which is also what makes the precision behaviour easy to
 * watch.
 *
 * State is a handful of numbers with no hidden time dependence, so the
 * acceptance harness can jump straight to any point of the flight and get
 * exactly the frame the interactive run would have shown.
 */

import { Vec3d } from '@planet/core';
import type { PlanetCamera } from '@planet/render';

export interface FlightOptions {
  readonly startAltitude?: number;
  readonly endAltitude?: number;
  /** Seconds for the full descent. */
  readonly duration?: number;
  /** Radians of longitude travelled over the full descent. */
  readonly sweep?: number;
}

export class Flight {
  startAltitude: number;
  endAltitude: number;
  duration: number;
  sweep: number;

  /** 0 at the start of the descent, 1 at the end. */
  progress = 0;
  running = true;
  /** Playback rate, for slowing the interesting part down by hand. */
  rate = 1;

  /** 0 looks straight down, 1 looks at the horizon. */
  tilt = 0;
  /** Extra yaw from the mouse, radians. */
  yaw = 0;
  /** Extra pitch from the mouse, radians. */
  pitch = 0;

  private readonly latitude = 0.34;

  constructor(options: FlightOptions = {}) {
    this.startAltitude = options.startAltitude ?? 1e9;
    this.endAltitude = options.endAltitude ?? 1e3;
    this.duration = options.duration ?? 90;
    this.sweep = options.sweep ?? 0.9;
  }

  /** Altitude for the current progress, metres. */
  get altitude(): number {
    return this.altitudeAt(this.progress);
  }

  altitudeAt(progress: number): number {
    const t = Math.min(1, Math.max(0, progress));
    return this.startAltitude * (this.endAltitude / this.startAltitude) ** t;
  }

  /** Progress that lands on a given altitude. Inverse of `altitudeAt`. */
  progressFor(altitude: number): number {
    const span = Math.log(this.endAltitude / this.startAltitude);
    if (span === 0) return 0;
    return Math.min(1, Math.max(0, Math.log(altitude / this.startAltitude) / span));
  }

  /** Jump to an exact altitude. Used by the acceptance harness. */
  setAltitude(altitude: number): void {
    this.progress = this.progressFor(altitude);
  }

  advance(deltaSeconds: number): void {
    if (!this.running || this.duration <= 0) return;
    this.progress = Math.min(1, this.progress + (deltaSeconds * this.rate) / this.duration);
  }

  restart(): void {
    this.progress = 0;
    this.running = true;
  }

  /**
   * Place the camera for the current state.
   *
   * Below 1e6 m the view tilts towards the horizon on its own, because looking
   * straight down at a grey sphere from a kilometre up shows nothing that could
   * reveal jitter, and the silhouette is exactly what criterion 4 is about.
   */
  applyTo(camera: PlanetCamera, bodyCenter: Vec3d, radius: number): void {
    const altitude = this.altitude;
    const longitude = this.sweep * this.progress;

    const up = new Vec3d(
      Math.cos(this.latitude) * Math.cos(longitude),
      Math.sin(this.latitude),
      Math.cos(this.latitude) * Math.sin(longitude),
    ).normalize();

    camera.position.set(
      bodyCenter.x + up.x * (radius + altitude),
      bodyCenter.y + up.y * (radius + altitude),
      bodyCenter.z + up.z * (radius + altitude),
    );

    const autoTilt = smoothstep(1e6, 1e4, altitude) * 0.85;
    const tilt = Math.min(1, Math.max(0, this.tilt + autoTilt));

    // East at this point on the sphere: the axis the tilt swings the view along.
    const east = new Vec3d(0, 1, 0).cross(up);
    if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
    east.normalize();

    const down = up.clone().negate();
    const look = down.scale(1 - tilt).addScaled(east, tilt).normalize();

    // Mouse look rides on top of the scripted direction.
    if (this.yaw !== 0) look.copy(rotateAbout(look, up, this.yaw));
    if (this.pitch !== 0) {
      const axis = look.clone().cross(up).normalize();
      if (axis.isFinite() && axis.lengthSq() > 0.5) look.copy(rotateAbout(look, axis, this.pitch));
    }

    const reach = Math.max(1e3, altitude * 4 + radius * 0.1);
    const target = camera.position.clone().addScaled(look, reach);
    camera.lookAt(target, up);
  }
}

/** Rodrigues rotation of `v` about the unit axis `axis`. */
function rotateAbout(v: Vec3d, axis: Vec3d, angle: number): Vec3d {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const cross = axis.clone().cross(v);
  const dot = axis.dot(v);
  return new Vec3d(
    v.x * c + cross.x * s + axis.x * dot * (1 - c),
    v.y * c + cross.y * s + axis.y * dot * (1 - c),
    v.z * c + cross.z * s + axis.z * dot * (1 - c),
  );
}

/** 0 below `edge1`, 1 above `edge0`, smooth in between. Works either way round. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
