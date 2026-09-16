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
  for (const height of [1, 4, 7, 9]) {
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
  prepare(world: World, range: { cx0: number; cy0: number; cx1: number; cy1: number }): void {
    const { cx0, cy0, cx1, cy1 } = range;
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
              size +
              (facility ? 0 : 1),
            size,
            pixels,
            u: Math.round(uv[0] * pixels.width),
            v: Math.round(uv[1] * pixels.height),
          });
        }
      }
    }
  }
  maskFor(tx: number, ty: number, x: number, y: number): (x: number, y: number) => boolean {
    const candidates = this.occluders.filter(
      (b) =>
        tx < b.maxTx &&
        ty < b.maxTy &&
        b.x < x + 48 &&
        b.x + b.size > x - 48 &&
        b.y < y + 4 &&
        b.y + b.size > y - 48,
    );
    return (x, y) =>
      candidates.some((b) => {
        if (tx >= b.maxTx || ty >= b.maxTy) return false;
        const px = Math.floor(x - b.x),
          py = Math.floor(y - b.y);
        return (
          px >= 0 &&
          py >= 0 &&
          px < b.size &&
          py < b.size &&
          b.pixels.data[((b.v + py) * b.pixels.width + b.u + px) * 4 + 3] > 32
        );
      });
  }
  draw(
    world: World,
    walkers: readonly Pedestrian[],
    showFog: boolean,
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
  ): void {
    const g = this.graphics;
    g.clear();
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
      drawPixelWalker(
        g,
        Math.round(x),
        Math.round(y),
        p.color,
        Math.floor(p.progress * 10) % 2,
        walkingDirection(p),
      );
    }
  }
}

export function walkingDirection(p: Pick<Pedestrian, 'path' | 'progress'>): number {
  const length = p.path.length - 1;
  if (length < 1) return 0;
  const progress = ((p.progress % (length * 2)) + length * 2) % (length * 2);
  const forward = progress < length;
  const distance = forward ? progress : length * 2 - progress;
  const i = Math.max(
    0,
    Math.min(length - 1, forward ? Math.floor(distance) : Math.ceil(distance) - 1),
  );
  const dx = (p.path[i + 1][0] - p.path[i][0]) * (forward ? 1 : -1);
  const dy = (p.path[i + 1][1] - p.path[i][1]) * (forward ? 1 : -1);
  return dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3;
}

/** Native integer pixels: hair, skin, jacket, arms, trousers and two walking poses. */
export function drawPixelWalker(
  g: Graphics,
  x: number,
  y: number,
  color: number,
  stride: number,
  direction = 0,
): void {
  g.rect(x - 2, y, 5, 1).fill({ color: 0x182327, alpha: 0.3 });
  g.rect(x - 1, y - 3, 1, stride ? 3 : 2).fill(0x293642);
  g.rect(x + 1, y - 3, 1, stride ? 2 : 3).fill(0x293642);
  g.rect(x - 2, y - (stride ? 1 : 2), 2, 1).fill(0x1b272c);
  g.rect(x + 1, y - (stride ? 2 : 1), 2, 1).fill(0x1b272c);
  g.rect(x - 1, y - 6, 3, 3).fill(color);
  g.rect(x - 2, y - 5, 1, 2).fill(color);
  const right = direction === 0 || direction === 3;
  const back = direction >= 2;
  g.rect(x + (right ? 2 : -2), y - 5, 1, 2).fill(back ? color : 0xd5ac87);
  g.rect(x - 1, y - 8, 3, 2).fill(back ? 0x48382e : 0xd5ac87);
  g.rect(x - 1, y - 9, 3, 1).fill(0x48382e);
  g.rect(x + (right ? -1 : 1), y - 8, 1, 1).fill(0x48382e);
  g.rect(x + (right ? 1 : -1), y - 7, 1, 1).fill(back ? 0xb99576 : 0x423e37);
}
