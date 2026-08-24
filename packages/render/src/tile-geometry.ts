/**
 * Wraps the plain typed arrays from `tile-mesh.ts` into a `BufferGeometry`.
 *
 * Kept apart from the generation so the geometry maths stays testable in Node
 * and so a Worker-based builder can later hand back transferable arrays without
 * touching the maths.
 */

import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three/webgpu';
import type { TileMeshData } from './tile-mesh.ts';

/**
 * Build the geometry for a tile.
 *
 * The bounding sphere is set by hand: `computeBoundingSphere` would run over
 * the positions again for a value we already know, and the positions are
 * tile-local so the sphere is centred on the origin.
 */
export function createTileGeometry(data: TileMeshData): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
  geometry.setAttribute('direction', new BufferAttribute(data.directions, 3));
  geometry.setAttribute('tileInfo', new BufferAttribute(data.tileInfo, 2));
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), data.localRadius);
  return geometry;
}
