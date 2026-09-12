import { Texture } from 'pixi.js';
import { TILE_W } from '../core/constants';
import { LEVEL_COUNT, ZONE_COUNT } from '../sim/buildings';
import { buildingArt, BUILDING_ART_VARIANTS } from './buildingArt';

/** Native pixel recipes: no resampling across tiers; variants are derived, not saved.
 * Bands L1 y=0, L2 y=64, L3 y=192. Each has 3 zones x 4 variants. */
export const BUILDING_VARIANTS = BUILDING_ART_VARIANTS;
export function buildingCellSize(level: number): number {
  return level * TILE_W;
}
export function buildingBandY(level: number): number {
  let y = 0;
  for (let l = 1; l < level; l++) y += buildingCellSize(l);
  return y;
}
export const BUILDING_ATLAS_W = buildingCellSize(LEVEL_COUNT) * ZONE_COUNT * BUILDING_VARIANTS;
export const BUILDING_ATLAS_H = buildingBandY(LEVEL_COUNT) + buildingCellSize(LEVEL_COUNT);
export interface BuildingAtlas {
  texture: Texture;
  placeholder: boolean;
  uv(level: number, zone: number, variant: number): [number, number, number, number];
}
export function drawBuildingAtlas(ctx: CanvasRenderingContext2D): void {
  for (let level = 1; level <= LEVEL_COUNT; level++)
    for (let zone = 0; zone < ZONE_COUNT; zone++)
      for (let variant = 0; variant < BUILDING_VARIANTS; variant++)
        buildingArt(level, zone, variant).paint(
          ctx,
          (zone * BUILDING_VARIANTS + variant) * buildingCellSize(level),
          buildingBandY(level),
        );
}
export async function loadBuildingAtlas(): Promise<BuildingAtlas> {
  const canvas = document.createElement('canvas');
  canvas.width = BUILDING_ATLAS_W;
  canvas.height = BUILDING_ATLAS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D 캔버스를 만들 수 없습니다');
  drawBuildingAtlas(ctx);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  texture.source.autoGenerateMipmaps = false;
  return {
    texture,
    placeholder: false,
    uv(level, zone, variant) {
      const size = buildingCellSize(level),
        x = (zone * BUILDING_VARIANTS + variant) * size,
        y = buildingBandY(level);
      return [
        x / canvas.width,
        y / canvas.height,
        (x + size) / canvas.width,
        (y + size) / canvas.height,
      ];
    },
  };
}
