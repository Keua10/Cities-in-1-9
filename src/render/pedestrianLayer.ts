import { Graphics } from 'pixi.js';
import { CHUNK_SIZE, TILE_HH, TILE_W, WORLD_SEED } from '../core/constants';
import { chunkIndexOf, tileToWorldX, tileToWorldY } from '../core/iso';
import {
  isAnyAnchor,
  isFacilityAnchor,
  facilityKindOfCode,
  levelOfCode,
  zoneOfCode,
  simHash,
} from '../sim/buildings';
import { facilitySpan } from '../sim/facilities';
import type { Pedestrian } from '../sim/pedestrians';
import { surfaceHeightAt } from '../world/slope';
import type { World } from '../world/world';
import { BUILDING_VARIANTS, type BuildingAtlas } from './buildingAtlas';
import type { FacilityAtlas } from './facilityAtlas';

interface Occluder {
  maxTx: number;
  maxTy: number;
  x: number;
  y: number;
  size: number;
  u: number;
  v: number;
  pixels: ImageData;
}

/** 앞쪽 건물의 실제 불투명 픽셀에 몸/머리가 겹치는 경우만 숨긴다. */
export function pedestrianHidden(
  p: Pick<Pedestrian, 'x' | 'y'>,
  x: number,
  y: number,
  b: Occluder,
): boolean {
  if (p.x >= b.maxTx || p.y >= b.maxTy) return false;
  const px = Math.floor(x - b.x);
  if (px < 0 || px >= b.size) return false;
  for (const height of [1, 4, 7]) {
    const py = Math.floor(y - height - b.y);
    if (py < 0 || py >= b.size) continue;
    if (b.pixels.data[((b.v + py) * b.pixels.width + b.u + px) * 4 + 3] > 32) return true;
  }
  return false;
}

/** 화면에 보이는 보행 데이터만 한 Graphics 배치로 그린다. 시민별 Sprite는 없다. */
export class PedestrianLayer {
  readonly graphics = new Graphics();
  private buildings: ImageData;
  private facilities: ImageData;
  private occluders: Occluder[] = [];
  private cacheKey = '';
  constructor(
    private buildingAtlas: BuildingAtlas,
    private facilityAtlas: FacilityAtlas,
  ) {
    const read = (atlas: BuildingAtlas | FacilityAtlas) => {
      const canvas = atlas.texture.source.resource as HTMLCanvasElement;
      return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    };
    this.buildings = read(buildingAtlas);
    this.facilities = read(facilityAtlas);
  }
  draw(
    world: World,
    walkers: readonly Pedestrian[],
    showFog: boolean,
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
  ): void {
    const g = this.graphics;
    g.clear();
    if (!walkers.length) return;
    const cx0 = Math.min(...walkers.map((p) => chunkIndexOf(p.x))) - 1;
    const cy0 = Math.min(...walkers.map((p) => chunkIndexOf(p.y))) - 1;
    const cx1 = Math.max(...walkers.map((p) => chunkIndexOf(p.x))) + 1;
    const cy1 = Math.max(...walkers.map((p) => chunkIndexOf(p.y))) + 1;
    const cacheKey = `${world.walkRevision},${cx0},${cy0},${cx1},${cy1}`;
    if (cacheKey !== this.cacheKey) {
      this.cacheKey = cacheKey;
      this.occluders = [];
      for (const parcel of world.developedParcels()) {
        if (!parcel.bld || parcel.cx < cx0 || parcel.cx > cx1 || parcel.cy < cy0 || parcel.cy > cy1)
          continue;
        for (let i = 0; i < parcel.bld.length; i++) {
          const code = parcel.bld[i];
          if (!isAnyAnchor(code)) continue;
          const tx = parcel.cx * CHUNK_SIZE + (i % CHUNK_SIZE),
            ty = parcel.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
          const facility = isFacilityAnchor(code),
            kind = facilityKindOfCode(code);
          const span = facility ? facilitySpan(kind) : levelOfCode(code),
            size = span * TILE_W;
          const uv = facility
            ? this.facilityAtlas.uv(kind)
            : this.buildingAtlas.uv(
                span,
                zoneOfCode(code),
                simHash(WORLD_SEED, tx, ty, span) % BUILDING_VARIANTS,
              );
          const pixels = facility ? this.facilities : this.buildings;
          this.occluders.push({
            maxTx: tx + span - 0.5,
            maxTy: ty + span - 0.5,
            x: tileToWorldX(tx + span - 1, ty + span - 1) - size / 2,
            y:
              tileToWorldY(tx + span - 1, ty + span - 1, world.sampleHeight(tx, ty)) +
              TILE_HH -
              size,
            size,
            pixels,
            u: Math.round(uv[0] * pixels.width),
            v: Math.round(uv[1] * pixels.height),
          });
        }
      }
    }
    for (const p of walkers) {
      if (
        showFog &&
        !world.isExplored(chunkIndexOf(Math.round(p.x)), chunkIndexOf(Math.round(p.y)))
      )
        continue;
      const x = tileToWorldX(p.x, p.y),
        y = tileToWorldY(p.x, p.y, surfaceHeightAt(world, p.x, p.y));
      if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) continue;
      if (this.occluders.some((b) => pedestrianHidden(p, x, y, b))) continue;
      const stride = Math.sin(p.progress * Math.PI * 5) * 0.8;
      g.ellipse(x, y, 2.2, 1).fill({ color: 0x101820, alpha: 0.3 });
      g.rect(x - 1.3, y - 3, 1, 2 + stride).fill(0x263340);
      g.rect(x + 0.3, y - 3, 1, 2 - stride).fill(0x263340);
      g.rect(x - 1.5, y - 6, 3, 3.5).fill(p.color);
      g.circle(x, y - 7, 1.4).fill(0xf0c7a0);
    }
  }
}
