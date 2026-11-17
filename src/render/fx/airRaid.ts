import { Graphics } from 'pixi.js';
import { CHUNK_SIZE, TILE_HH, TILE_HW } from '../../core/constants';
import { parseChunkKey, tileToWorldX, tileToWorldY } from '../../core/iso';
import { reducedMotion } from '../../core/motion';
import type { World } from '../../world/world';

/** 경보 테두리가 켜져 있는 시간(ms). */
const ALERT_MS = 6000;
/** 폭격기 그림자가 화면을 가로지르는 시간(ms). */
const FLY_MS = 3800;
const MAX_SHADOWS = 3;

interface Flight {
  /** 목표 청크 가운데(월드 좌표). */
  x: number;
  y: number;
  at: number;
}

/**
 * 공습: 화면 가장자리가 붉게 깜빡이는 경보(DOM 한 겹) + 맞은 청크 위를 지나가는 폭격기 그림자(월드 좌표).
 * 미사일·레이더 경보는 테두리만, 폭격은 그림자도.
 */
export class AirRaidLayer {
  readonly graphics = new Graphics();
  private vignette = document.createElement('div');
  private flights: Flight[] = [];
  private offTimer = 0;

  constructor() {
    this.graphics.eventMode = 'none';
    this.vignette.className = 'raid-vignette';
    this.vignette.setAttribute('aria-hidden', 'true');
    document.body.append(this.vignette);
  }

  /** 경보를 켠다. bomberAt = 폭격당한 청크 키(그림자를 띄운다). */
  trigger(world: World, bomberAt: string | null, now: number): void {
    this.vignette.classList.remove('on');
    void this.vignette.offsetWidth; // 애니메이션을 처음부터 다시
    this.vignette.classList.add('on');
    clearTimeout(this.offTimer);
    this.offTimer = window.setTimeout(() => this.vignette.classList.remove('on'), ALERT_MS);
    if (!bomberAt || reducedMotion()) return;
    const { cx, cy } = parseChunkKey(bomberAt);
    const tx = cx * CHUNK_SIZE + CHUNK_SIZE / 2;
    const ty = cy * CHUNK_SIZE + CHUNK_SIZE / 2;
    this.flights.push({
      x: tileToWorldX(tx, ty),
      y: tileToWorldY(tx, ty, world.sampleHeight(tx, ty)),
      at: now,
    });
    if (this.flights.length > MAX_SHADOWS) this.flights.shift();
  }

  draw(now: number): void {
    const g = this.graphics;
    g.clear();
    this.flights = this.flights.filter((f) => now - f.at < FLY_MS);
    g.visible = this.flights.length > 0;
    for (const f of this.flights) {
      // 왼쪽 위에서 들어와 목표 위를 지나 오른쪽 아래로.
      const k = (now - f.at) / FLY_MS;
      const span = TILE_HW * 26;
      const x = f.x + (k - 0.5) * span;
      const y = f.y + (k - 0.5) * span * 0.5;
      const fade = Math.min(1, k * 5, (1 - k) * 5);
      planeShadow(g, x, y, 0.32 * fade);
      planeShadow(g, x - TILE_HW * 3, y + TILE_HH * 2.5, 0.24 * fade);
    }
  }
}

/** 동체·날개·꼬리날개 실루엣(진행 방향 = 오른쪽 아래). */
function planeShadow(g: Graphics, x: number, y: number, alpha: number): void {
  const ang = Math.atan2(0.5, 1);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const pt = (px: number, py: number) => [x + px * c - py * s, y + px * s + py * c];
  const poly = (pts: number[][]) => g.poly(pts.flatMap(([px, py]) => pt(px, py)));
  poly([
    [60, 0],
    [40, -6],
    [-50, -5],
    [-50, 5],
    [40, 6],
  ]).fill({ color: 0x0b0d10, alpha });
  poly([
    [18, -6],
    [-12, -62],
    [-26, -62],
    [-8, -6],
  ]).fill({ color: 0x0b0d10, alpha });
  poly([
    [18, 6],
    [-12, 62],
    [-26, 62],
    [-8, 6],
  ]).fill({ color: 0x0b0d10, alpha });
  poly([
    [-40, -4],
    [-52, -22],
    [-58, -22],
    [-50, -4],
  ]).fill({ color: 0x0b0d10, alpha });
  poly([
    [-40, 4],
    [-52, 22],
    [-58, 22],
    [-50, 4],
  ]).fill({ color: 0x0b0d10, alpha });
}
