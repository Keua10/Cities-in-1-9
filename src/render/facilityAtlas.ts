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
  0, 1, 0, 1, 0, 2, 2, 3, 4, 5, 3, 6, 4, 5, 6, 7, 7, 1, 8, 9, 10, 11, 0, 0, 1, 1,
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
export async function loadFacilityAtlas(): Promise<FacilityAtlas> {
  const canvas = document.createElement('canvas');
  canvas.width = FACILITY_ATLAS_W;
  canvas.height = FACILITY_ATLAS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D 캔버스를 만들 수 없습니다');
  drawFacilityAtlas(ctx);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  texture.source.autoGenerateMipmaps = false;
  return {
    texture,
    placeholder: false,
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
