import { CONTINENT_H, CONTINENT_W, CONTINENT_X0, CONTINENT_Y0 } from '../../world/continent';

/** 배율 1 에서 청크 하나의 화면 크기(px). */
export const PX_PER_CHUNK = 2;
/** 가장 크게 확대하면 청크 하나가 96px(타일 하나 3px) — 밝혀진 청크를 자세히 본다. */
const MAX_SCALE = 48;

/**
 * 대륙 지도의 시점(확대·이동). 청크 좌표 ↔ 화면 좌표 변환은 전부 여기서 한다.
 * 화면 좌표는 캔버스 CSS 픽셀(devicePixelRatio 적용 전).
 */
export class MapView {
  scale = 1;
  private fitScale = 1;
  ox = 0;
  oy = 0;

  constructor(private canvas: HTMLCanvasElement) {}

  /** 청크 한 칸의 화면 크기. */
  get s(): number {
    return this.scale * PX_PER_CHUNK;
  }
  get width(): number {
    return this.canvas.clientWidth || 640;
  }
  get height(): number {
    return this.canvas.clientHeight || 448;
  }
  /** 대륙 전체의 화면 크기. */
  get mapWidth(): number {
    return CONTINENT_W * this.s;
  }
  get mapHeight(): number {
    return CONTINENT_H * this.s;
  }

  /** 청크 좌표(실수 가능)의 화면 x·y. */
  X = (cx: number): number => this.ox + (cx - CONTINENT_X0) * this.s;
  Y = (cy: number): number => this.oy + (cy - CONTINENT_Y0) * this.s;

  /** 화면 점이 있는 청크. */
  chunkAt(px: number, py: number): { cx: number; cy: number } {
    return {
      cx: Math.floor(CONTINENT_X0 + (px - this.ox) / this.s),
      cy: Math.floor(CONTINENT_Y0 + (py - this.oy) / this.s),
    };
  }

  /** 캔버스 크기를 화면에 맞추고, 대륙 전체가 들어오는 배율을 최소로 둔다. */
  fit(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.width;
    const h = this.height;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.fitScale = Math.min(w / (CONTINENT_W * PX_PER_CHUNK), h / (CONTINENT_H * PX_PER_CHUNK));
    if (this.scale < this.fitScale) this.scale = this.fitScale;
    this.clampPan();
  }

  /** (x, y) 청크를 화면 가운데로, 최소 minScale 배율로. */
  centerOn(x: number, y: number, minScale: number, keepZoom = false): void {
    this.scale = keepZoom ? Math.max(this.scale, minScale) : Math.max(this.fitScale, minScale);
    this.ox = this.width / 2 - (x - CONTINENT_X0) * this.s;
    this.oy = this.height / 2 - (y - CONTINENT_Y0) * this.s;
    this.clampPan();
  }

  zoomAt(factor: number, px: number, py: number): void {
    const next = Math.min(MAX_SCALE, Math.max(this.fitScale, this.scale * factor));
    const k = next / this.scale;
    this.ox = px - (px - this.ox) * k;
    this.oy = py - (py - this.oy) * k;
    this.scale = next;
    this.clampPan();
  }

  pan(dx: number, dy: number): void {
    this.ox += dx;
    this.oy += dy;
    this.clampPan();
  }

  private clampPan(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const mw = this.mapWidth;
    const mh = this.mapHeight;
    this.ox = mw <= w ? (w - mw) / 2 : Math.min(0, Math.max(w - mw, this.ox));
    this.oy = mh <= h ? (h - mh) / 2 : Math.min(0, Math.max(h - mh, this.oy));
  }
}
