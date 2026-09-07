import './minimap.css';
import type { Camera } from '../core/camera';
import { CHUNK_SIZE } from '../core/constants';
import { parseChunkKey, tileToWorldX, tileToWorldY, worldToTileF } from '../core/iso';
import type { World } from '../world/world';
import { Build } from '../world/build';
import { isWelfareKind } from '../sim/buildings';
import type { ServiceField } from '../sim/services';

/**
 * 시설 도구를 든 동안 미니맵에 얹는 레이어.
 *
 * 월드 오버레이는 3.3단계 범위 밖이다(청크 메시 UV 를 건드려야 해서 비싸다).
 * 대신 이미 도시를 축약해 그리고 있는 미니맵에 얹는다.
 */
export interface CoverageOverlay {
  field: ServiceField;
  /** 지금 고른 시설 종류. 이 값에 맞는 그림을 그린다. */
  kind: number;
}

interface TileBounds {
  minTx: number;
  minTy: number;
  maxTx: number;
  maxTy: number;
}

const MAP_RES = 512;
const REDRAW_MS = 500;

/**
 * 좌하단 미니맵 + 거의 전체 화면 지도.
 * 작은 지도 탭: 그 위치로 카메라 이동 + 큰 지도 열기.
 * 큰 지도 탭/드래그: 카메라 중심 이동. 흰 사각형은 현재 화면 범위다.
 */
export class Minimap {
  private shell: HTMLDivElement;
  private small: HTMLCanvasElement;
  private modal: HTMLDivElement;
  private large: HTMLCanvasElement;
  private close: HTMLButtonElement;
  private base = document.createElement('canvas');
  private bounds: TileBounds;
  private lastBasePaint = -Infinity;
  private dragging = false;
  /** 지금 그려진 오버레이 종류. 바뀌면 다시 칠한다. */
  private overlayKey = '';

  constructor(
    private world: World,
    private camera: Camera,
  ) {
    this.bounds = exploredBounds(world);
    this.base.width = MAP_RES;
    this.base.height = MAP_RES;

    this.shell = document.createElement('div');
    this.shell.id = 'minimap-shell';
    this.small = makeCanvas();
    this.shell.appendChild(this.small);

    this.modal = document.createElement('div');
    this.modal.id = 'minimap-modal';
    this.large = makeCanvas();
    this.close = document.createElement('button');
    this.close.id = 'minimap-close';
    this.close.type = 'button';
    this.close.textContent = '×';
    this.close.setAttribute('aria-label', '지도 닫기');
    const hint = document.createElement('div');
    hint.id = 'minimap-hint';
    hint.textContent = '지도를 눌러 시점을 이동 · 흰 사각형 = 현재 화면';
    this.modal.append(this.large, this.close, hint);
    document.body.append(this.shell, this.modal);

    this.bindSmall();
    this.bindLarge();
    this.close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.modal.classList.remove('open');
    });
  }

  update(nowMs: number, overlay: CoverageOverlay | null = null): void {
    const nextBounds = exploredBounds(this.world);
    if (!sameBounds(nextBounds, this.bounds)) {
      this.bounds = nextBounds;
      this.lastBasePaint = -Infinity;
    }
    // 오버레이가 바뀌면(도구를 들거나 종류를 바꾸면) 바로 다시 칠한다.
    const key = overlay ? String(overlay.kind) : '';
    if (key !== this.overlayKey) {
      this.overlayKey = key;
      this.lastBasePaint = -Infinity;
    }
    if (nowMs - this.lastBasePaint >= REDRAW_MS) {
      this.paintBase(overlay);
      this.lastBasePaint = nowMs;
    }
    this.paintView(this.small);
    if (this.modal.classList.contains('open')) this.paintView(this.large);
  }

  private bindSmall(): void {
    this.small.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.moveFromPointer(this.small, e);
    });
    this.small.addEventListener('pointerup', (e) => {
      e.preventDefault();
      this.moveFromPointer(this.small, e);
      this.modal.classList.add('open');
      this.paintView(this.large);
    });
  }

  private bindLarge(): void {
    this.large.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.dragging = true;
      this.large.setPointerCapture(e.pointerId);
      this.moveFromPointer(this.large, e);
    });
    this.large.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      e.preventDefault();
      this.moveFromPointer(this.large, e);
    });
    const end = (e: PointerEvent): void => {
      if (!this.dragging) return;
      this.dragging = false;
      if (this.large.hasPointerCapture(e.pointerId)) this.large.releasePointerCapture(e.pointerId);
    };
    this.large.addEventListener('pointerup', end);
    this.large.addEventListener('pointercancel', end);
  }

  private moveFromPointer(canvas: HTMLCanvasElement, e: PointerEvent): void {
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const u = clamp((e.clientX - r.left) / r.width, 0, 1);
    const v = clamp((e.clientY - r.top) / r.height, 0, 1);
    const tx = this.bounds.minTx + u * (this.bounds.maxTx - this.bounds.minTx);
    const ty = this.bounds.minTy + v * (this.bounds.maxTy - this.bounds.minTy);
    const itx = Math.floor(tx);
    const ity = Math.floor(ty);
    this.camera.centerOnWorld(
      tileToWorldX(tx, ty),
      tileToWorldY(tx, ty, this.world.sampleHeight(itx, ity)),
    );
  }

  private paintBase(overlay: CoverageOverlay | null = null): void {
    const ctx = this.base.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, MAP_RES, MAP_RES);
    ctx.fillStyle = '#182228';
    ctx.fillRect(0, 0, MAP_RES, MAP_RES);

    // 개척된 청크를 먼저 깔아 맵의 실제 사용 범위를 보여준다.
    ctx.fillStyle = '#27343a';
    for (const key of this.world.exploredKeys()) {
      const { cx, cy } = parseChunkKey(key);
      const x0 = this.mapX(cx * CHUNK_SIZE);
      const y0 = this.mapY(cy * CHUNK_SIZE);
      const x1 = this.mapX((cx + 1) * CHUNK_SIZE);
      const y1 = this.mapY((cy + 1) * CHUNK_SIZE);
      ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    }

    // 저장 레이어만 읽으므로 미니맵 때문에 지형 청크를 새로 생성하지 않는다.
    for (const p of this.world.developedParcels()) {
      if (!p.build) continue;
      const baseTx = p.cx * CHUNK_SIZE;
      const baseTy = p.cy * CHUNK_SIZE;
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const b = p.build[ly * CHUNK_SIZE + lx];
          if (b === Build.None) continue;
          ctx.fillStyle = buildColor(b);
          const x0 = this.mapX(baseTx + lx);
          const y0 = this.mapY(baseTy + ly);
          const x1 = this.mapX(baseTx + lx + 1);
          const y1 = this.mapY(baseTy + ly + 1);
          ctx.fillRect(x0, y0, Math.max(1, x1 - x0 + 0.25), Math.max(1, y1 - y0 + 0.25));
        }
      }
    }

    if (overlay) this.paintOverlay(ctx, overlay);
  }

  /**
   * 시설 레이어.
   *
   * **두 가족이 다르게 생겨야 두 가족이 다르다는 게 UI 에서도 읽힌다.**
   *
   *   필수 서비스 — 그 종류가 커버하는 **도로 칸** 을 밝게. 이진이다(닿거나
   *                 안 닿거나). 학생이 "여기가 비었구나" 를 한눈에 본다.
   *   복지        — **복지 점수 격자** 를 농도로. 진할수록 점수가 높다.
   *                 히트맵이라 "여기는 이미 충분하고 저기가 비었다" 가 보인다.
   */
  private paintOverlay(ctx: CanvasRenderingContext2D, overlay: CoverageOverlay): void {
    const welfare = isWelfareKind(overlay.kind);

    for (const p of this.world.developedParcels()) {
      if (!p.build) continue;
      const baseTx = p.cx * CHUNK_SIZE;
      const baseTy = p.cy * CHUNK_SIZE;
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const tx = baseTx + lx;
          const ty = baseTy + ly;

          if (welfare) {
            // 요구 최대치(고소득 1.8)를 기준으로 농도를 잡는다. 그 위는 이미
            // 모두를 충족한 자리라 더 진해질 이유가 없다.
            const score = overlay.field.amenityScoreAt(tx, ty);
            if (score <= 0) continue;
            const a = Math.min(1, score / 1.8) * 0.62;
            ctx.fillStyle = `rgba(126, 226, 142, ${a.toFixed(3)})`;
          } else {
            if (p.build[ly * CHUNK_SIZE + lx] !== Build.Road) continue;
            if (!overlay.field.roadCoveredAt(tx, ty, overlay.kind)) continue;
            ctx.fillStyle = 'rgba(126, 206, 240, 0.85)';
          }

          const x0 = this.mapX(tx);
          const y0 = this.mapY(ty);
          const x1 = this.mapX(tx + 1);
          const y1 = this.mapY(ty + 1);
          ctx.fillRect(x0, y0, Math.max(1, x1 - x0 + 0.25), Math.max(1, y1 - y0 + 0.25));
        }
      }
    }
  }

  private paintView(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, MAP_RES, MAP_RES);
    ctx.drawImage(this.base, 0, 0);

    const halfW = this.camera.screenW / 2 / this.camera.zoom;
    const halfH = this.camera.screenH / 2 / this.camera.zoom;
    const corners = [
      worldToTileF(this.camera.x - halfW, this.camera.y - halfH),
      worldToTileF(this.camera.x + halfW, this.camera.y - halfH),
      worldToTileF(this.camera.x - halfW, this.camera.y + halfH),
      worldToTileF(this.camera.x + halfW, this.camera.y + halfH),
    ];
    let minTx = Infinity;
    let maxTx = -Infinity;
    let minTy = Infinity;
    let maxTy = -Infinity;
    for (const c of corners) {
      minTx = Math.min(minTx, c.tx);
      maxTx = Math.max(maxTx, c.tx);
      minTy = Math.min(minTy, c.ty);
      maxTy = Math.max(maxTy, c.ty);
    }

    const x = this.mapX(minTx);
    const y = this.mapY(minTy);
    const w = this.mapX(maxTx) - x;
    const h = this.mapY(maxTy) - y;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = canvas === this.small ? 4 : 2;
    ctx.strokeRect(x, y, Math.max(4, w), Math.max(4, h));
  }

  private mapX(tx: number): number {
    return ((tx - this.bounds.minTx) / Math.max(1, this.bounds.maxTx - this.bounds.minTx)) * MAP_RES;
  }

  private mapY(ty: number): number {
    return ((ty - this.bounds.minTy) / Math.max(1, this.bounds.maxTy - this.bounds.minTy)) * MAP_RES;
  }
}

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = MAP_RES;
  canvas.height = MAP_RES;
  return canvas;
}

function exploredBounds(world: World): TileBounds {
  let minCx = Infinity;
  let minCy = Infinity;
  let maxCx = -Infinity;
  let maxCy = -Infinity;
  for (const key of world.exploredKeys()) {
    const { cx, cy } = parseChunkKey(key);
    minCx = Math.min(minCx, cx);
    minCy = Math.min(minCy, cy);
    maxCx = Math.max(maxCx, cx);
    maxCy = Math.max(maxCy, cy);
  }
  if (!Number.isFinite(minCx)) {
    minCx = world.baseCx;
    minCy = world.baseCy;
    maxCx = world.baseCx + 3;
    maxCy = world.baseCy + 3;
  }
  const pad = CHUNK_SIZE * 0.15;
  return {
    minTx: minCx * CHUNK_SIZE - pad,
    minTy: minCy * CHUNK_SIZE - pad,
    maxTx: (maxCx + 1) * CHUNK_SIZE + pad,
    maxTy: (maxCy + 1) * CHUNK_SIZE + pad,
  };
}

function buildColor(build: number): string {
  if (build === Build.Road) return '#d1d4d3';
  if (build === Build.ZoneR) return '#4f9b62';
  if (build === Build.ZoneC) return '#4f86b8';
  if (build === Build.ZoneI) return '#b2944a';
  return '#27343a';
}

function sameBounds(a: TileBounds, b: TileBounds): boolean {
  return a.minTx === b.minTx && a.minTy === b.minTy && a.maxTx === b.maxTx && a.maxTy === b.maxTy;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
