/**
 * Double-precision 3-vector.
 *
 * Deliberately not `THREE.Vector3`: world coordinates run to 1e9 m and beyond,
 * and float32 gives up around 1e2 m of resolution there. Everything that lives
 * in world space — camera position, body centres, tile origins — is a `Vec3d`.
 * The conversion to float32 happens exactly once, at the last possible moment,
 * and always on a difference that is already small (see `Frame`).
 *
 * Mutating methods return `this` so chains do not allocate. Every one of them
 * has a non-mutating counterpart on the module (`add`, `sub`, ...) that returns
 * a fresh vector, for the places where clarity beats allocation.
 */
export class Vec3d {
  x: number;
  y: number;
  z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static zero(): Vec3d {
    return new Vec3d(0, 0, 0);
  }

  static from(v: { x: number; y: number; z: number }): Vec3d {
    return new Vec3d(v.x, v.y, v.z);
  }

  static fromArray(a: ArrayLike<number>, offset = 0): Vec3d {
    return new Vec3d(a[offset] ?? 0, a[offset + 1] ?? 0, a[offset + 2] ?? 0);
  }

  clone(): Vec3d {
    return new Vec3d(this.x, this.y, this.z);
  }

  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  copy(v: { x: number; y: number; z: number }): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  add(v: Vec3d): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  addScaled(v: Vec3d, s: number): this {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  sub(v: Vec3d): this {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  /** this = a - b. The workhorse for camera-relative positions. */
  subVectors(a: Vec3d, b: Vec3d): this {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    return this;
  }

  addVectors(a: Vec3d, b: Vec3d): this {
    this.x = a.x + b.x;
    this.y = a.y + b.y;
    this.z = a.z + b.z;
    return this;
  }

  scale(s: number): this {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  negate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  dot(v: Vec3d): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  crossVectors(a: Vec3d, b: Vec3d): this {
    const x = a.y * b.z - a.z * b.y;
    const y = a.z * b.x - a.x * b.z;
    const z = a.x * b.y - a.y * b.x;
    return this.set(x, y, z);
  }

  cross(v: Vec3d): this {
    return this.crossVectors(this, v);
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  distanceToSq(v: Vec3d): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    const dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }

  distanceTo(v: Vec3d): number {
    return Math.sqrt(this.distanceToSq(v));
  }

  normalize(): this {
    const len = this.length();
    if (len === 0) return this;
    return this.scale(1 / len);
  }

  setLength(len: number): this {
    return this.normalize().scale(len);
  }

  lerpVectors(a: Vec3d, b: Vec3d, t: number): this {
    this.x = a.x + (b.x - a.x) * t;
    this.y = a.y + (b.y - a.y) * t;
    this.z = a.z + (b.z - a.z) * t;
    return this;
  }

  equals(v: Vec3d): boolean {
    return this.x === v.x && this.y === v.y && this.z === v.z;
  }

  isFinite(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z);
  }

  toArray(out: number[] = [], offset = 0): number[] {
    out[offset] = this.x;
    out[offset + 1] = this.y;
    out[offset + 2] = this.z;
    return out;
  }

  /**
   * Write into a float32 target. Only ever call this on a vector that is
   * already a small difference — never on an absolute world position.
   */
  writeFloat32(out: Float32Array, offset = 0): Float32Array {
    out[offset] = this.x;
    out[offset + 1] = this.y;
    out[offset + 2] = this.z;
    return out;
  }

  toJSON(): [number, number, number] {
    return [this.x, this.y, this.z];
  }

  toString(): string {
    return `Vec3d(${this.x}, ${this.y}, ${this.z})`;
  }
}

// ---------------------------------------------------------- free functions --

export function add(a: Vec3d, b: Vec3d): Vec3d {
  return new Vec3d(a.x + b.x, a.y + b.y, a.z + b.z);
}

export function sub(a: Vec3d, b: Vec3d): Vec3d {
  return new Vec3d(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function scale(a: Vec3d, s: number): Vec3d {
  return new Vec3d(a.x * s, a.y * s, a.z * s);
}

export function dot(a: Vec3d, b: Vec3d): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3d, b: Vec3d): Vec3d {
  return new Vec3d(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
  );
}

export function normalize(a: Vec3d): Vec3d {
  return a.clone().normalize();
}

export function distance(a: Vec3d, b: Vec3d): number {
  return a.distanceTo(b);
}

/**
 * An orthonormal pair tangent to `n`, chosen without a branch on a
 * near-degenerate axis. Used for local surface frames.
 */
export function tangentBasis(n: Vec3d): { t: Vec3d; b: Vec3d } {
  const sign = n.z >= 0 ? 1 : -1;
  const a = -1 / (sign + n.z);
  const b0 = n.x * n.y * a;
  const t = new Vec3d(1 + sign * n.x * n.x * a, sign * b0, -sign * n.x);
  const b = new Vec3d(b0, sign + n.y * n.y * a, -n.y);
  return { t, b };
}
