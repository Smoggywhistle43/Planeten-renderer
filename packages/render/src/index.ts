/**
 * @planet/render — three/webgpu, the cube-sphere quadtree, and the precision
 * rules that let a camera fly from 1e9 m to 1e3 m without the world shaking.
 */

export {
  CUBE_FACES,
  FACE_COUNT,
  assertValidKey,
  childKey,
  directionToFaceUv,
  faceUvToDirection,
  keysEqual,
  nodeArcLength,
  nodeBounds,
  nodeCenterDirection,
  nodeCornerDirections,
  nodeGeometricError,
  nodeId,
  nodeUvBounds,
  parentKey,
  parseNodeId,
  rootKeys,
  unresolvedRelief,
  unwarp,
  warp,
  type FaceBasis,
  type FaceIndex,
  type FaceUv,
  type NodeBounds,
  type NodeKey,
} from './cube-sphere.ts';

export {
  buildTileMeshData,
  perimeterIndices,
  type TileMeshData,
  type TileMeshOptions,
} from './tile-mesh.ts';

export { createTileGeometry } from './tile-geometry.ts';

export {
  DEFAULT_LOD_CONFIG,
  LodScheduler,
  type LodConfig,
  type LodNode,
  type LodStats,
  type NodeState,
  type TileBuilder,
  type ViewParams,
} from './lod-scheduler.ts';

export { PlanetCamera, type PlanetCameraOptions } from './planet-camera.ts';

export {
  TILE_ATTRIBUTES,
  createPlanetMaterial,
  type PlanetMaterialHandle,
  type PlanetMaterialOptions,
} from './planet-material.ts';

export {
  assertHighPrecisionModelView,
  assertLinearOutput,
  assertReversedDepth,
  createPlanetRenderer,
  describeDepth,
  describeModelViewPrecision,
  type DepthConfiguration,
  type ModelViewPrecision,
  type PlanetRendererOptions,
} from './renderer.ts';

export {
  createPostPipeline,
  type PostPipelineHandle,
  type PostPipelineOptions,
  type ToneMapper,
} from './post.ts';

export { Planet, type PlanetOptions, type PlanetStats, type PlanetTile } from './planet.ts';
