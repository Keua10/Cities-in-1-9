import { Texture } from 'pixi.js';
import { TILE_W } from '../core/constants';
import { FACILITY_COUNT } from '../sim/buildings';
import { FACILITY_SPECS } from '../sim/facilities';
import { facilityArt } from './facilityArt';

export const FACILITY_SPANS = [1, 2, 3, 5, 7] as const;
export function facilityCellSize(span: number): number {
  return span * TILE_W;
}
export function facilityBandY(span: number): number {
  let y = 0;
  for (const s of FACILITY_SPANS) {
    if (s >= span) break;
    y += facilityCellSize(s);
  }
  return y;
}
/** Retain existing atlas coordinates/IDs for all 26 facilities. */
export const FACILITY_ATLAS_COLUMN: readonly number[] = [
  0, 1, 0, 1, 0, 2, 2, 3, 4, 5, 3, 6, 4, 5, 6, 7, 7, 1, 8, 9, 10, 11, 0, 0, 1, 1, 2,
];
export const FACILITY_ATLAS_W = Math.max(
  ...FACILITY_SPECS.map((s) => (FACILITY_ATLAS_COLUMN[s.kind] + 1) * facilityCellSize(s.span)),
);
export const FACILITY_ATLAS_H = FACILITY_SPANS.reduce(
  (sum, span) => sum + facilityCellSize(span),
  0,
);
export interface FacilityAtlas {
  texture: Texture;
  placeholder: boolean;
  uv(kind: number): [number, number, number, number];
}
function drawRange(ctx: CanvasRenderingContext2D, start: number, end: number): void {
  for (let kind = start; kind < end; kind++) {
    const span = FACILITY_SPECS[kind].span;
    facilityArt(kind).paint(
      ctx,
      FACILITY_ATLAS_COLUMN[kind] * facilityCellSize(span),
      facilityBandY(span),
    );
  }
}
export function drawFacilityAtlas(ctx: CanvasRenderingContext2D): void {
  drawRange(ctx, 0, FACILITY_COUNT);
}
// Compatibility entry points used by atlas tooling.
export function drawWaterFacilities(ctx: CanvasRenderingContext2D): void {
  drawRange(ctx, 7, 11);
}
export function drawPowerFacilities(ctx: CanvasRenderingContext2D): void {
  drawRange(ctx, 11, 14);
}
export function drawSanitationFacilities(ctx: CanvasRenderingContext2D): void {
  drawRange(ctx, 14, 17);
}
export function drawSpecialFacilities(ctx: CanvasRenderingContext2D): void {
  drawRange(ctx, 17, FACILITY_COUNT);
}
export const FACILITY_SPRITE_SOURCE = '/sprites/facilities-v2.png?v=1';
const sheetCache = new Map<string, Promise<HTMLImageElement>>();
export function loadFacilitySpriteSheet(
  source = FACILITY_SPRITE_SOURCE,
): Promise<HTMLImageElement> {
  let pending = sheetCache.get(source);
  if (!pending) {
    pending = (async () => {
      const image = new Image();
      image.src = source;
      await image.decode();
      if (image.naturalWidth !== FACILITY_ATLAS_W || image.naturalHeight !== FACILITY_ATLAS_H)
        throw new Error(`시설 아틀라스 규격 오류: ${image.naturalWidth}x${image.naturalHeight}`);
      return image;
    })();
    sheetCache.set(source, pending);
    void pending.catch(() => sheetCache.delete(source));
  }
  return pending;
}

/** Catalog and live city consume the same native sprite cells. */
export async function paintFacilityThumbnail(
  ctx: CanvasRenderingContext2D,
  kind: number,
): Promise<void> {
  const size = facilityCellSize(FACILITY_SPECS[kind].span);
  if (kind === 26) {
    facilityArt(kind).paint(ctx);
    return;
  }
  try {
    const image = await loadFacilitySpriteSheet();
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      image,
      FACILITY_ATLAS_COLUMN[kind] * size,
      facilityBandY(FACILITY_SPECS[kind].span),
      size,
      size,
      0,
      0,
      size,
      size,
    );
  } catch {
    facilityArt(kind).paint(ctx);
  }
}

export async function loadFacilityAtlas(source = FACILITY_SPRITE_SOURCE): Promise<FacilityAtlas> {
  const canvas = document.createElement('canvas');
  canvas.width = FACILITY_ATLAS_W;
  canvas.height = FACILITY_ATLAS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D 캔버스를 만들 수 없습니다');
  ctx.imageSmoothingEnabled = false;
  let placeholder = false;
  try {
    ctx.drawImage(await loadFacilitySpriteSheet(source), 0, 0);
  } catch (error) {
    placeholder = true;
    console.warn('시설 아틀라스를 읽지 못해 기존 코드 그림으로 대체합니다.', error);
    drawFacilityAtlas(ctx);
  }
  facilityArt(26).paint(ctx, FACILITY_ATLAS_COLUMN[26] * 64, 0);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  texture.source.autoGenerateMipmaps = false;
  return {
    texture,
    placeholder,
    uv(kind) {
      const size = facilityCellSize(FACILITY_SPECS[kind].span),
        x = FACILITY_ATLAS_COLUMN[kind] * size,
        y = facilityBandY(FACILITY_SPECS[kind].span);
      return [
        x / canvas.width,
        y / canvas.height,
        (x + size) / canvas.width,
        (y + size) / canvas.height,
      ];
    },
  };
}
