import { Graphics } from 'pixi.js';
import { CHUNK_SIZE, TILE_HH } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import { isAnchor, levelOfCode } from '../sim/buildings';
import type { BuildingAlert } from '../sim/environment';
import type { MacroSim } from '../sim/macro';
import type { World } from '../world/world';

import type { Camera } from '../core/camera';
import { groupAlerts, type AlertPoint, type AlertGroup } from './alertLayout';

const COLORS: Record<BuildingAlert, number> = {
  road: 0xff7a59,
  power: 0xffd23f,
  water: 0x52cbff,
  sewer: 0xbc9164,
  pollution: 0xd0442c,
  fire: 0xf26b38,
  police: 0x7fa6ff,
  health: 0x7ee0a5,
  environment: 0xa9b4c0,
};

export class BuildingAlertLayer {
  readonly graphics = new Graphics();
  private stamp = '';
  private groups: AlertGroup[] = [];
  private zoom = 1;

  hitTest(wx: number, wy: number): AlertGroup | null {
    if (!this.graphics.visible) return null;
    const x = wx * this.zoom,
      y = (wy - this.graphics.position.y) * this.zoom;
    return (
      this.groups.find((g) => Math.abs(x - g.x) <= 19 && y >= g.y - 23 && y <= g.y + 18) ?? null
    );
  }

  private points: AlertPoint[] = [];
  private layoutStamp = '';
  private reducedMotion =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  draw(
    world: World,
    sim: MacroSim,
    range: { cx0: number; cy0: number; cx1: number; cy1: number },
    enabled: boolean,
    camera: Camera,
    now: number,
  ): void {
    const g = this.graphics;
    g.visible = enabled;
    if (!enabled) return;
    // Cancel the parent camera scale; all glyphs, stems and counters use CSS pixels.
    this.zoom = camera.zoom;
    g.scale.set(1 / camera.zoom);
    g.position.y = this.reducedMotion ? 0 : (Math.sin(now / 420) * 2.5) / camera.zoom;
    g.alpha = this.reducedMotion ? 1 : 0.88 + 0.12 * Math.cos(now / 420);
    const stamp = `${world.walkRevision}:${world.utilityRevision}:${sim.tick}:${range.cx0},${range.cy0},${range.cx1},${range.cy1}`;
    if (this.stamp !== stamp) {
      this.stamp = stamp;
      this.points = [];
      for (let cy = range.cy0; cy <= range.cy1; cy++) {
        for (let cx = range.cx0; cx <= range.cx1; cx++) {
          if (!world.isExplored(cx, cy)) continue;
          const p = world.peekParcel(cx, cy);
          if (!p?.bld) continue;
          for (let i = 0; i < p.bld.length; i++) {
            const code = p.bld[i];
            if (!isAnchor(code)) continue;
            const tx = cx * CHUNK_SIZE + (i % CHUNK_SIZE);
            const ty = cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
            const alerts = sim.buildingAlerts(tx, ty);
            if (!alerts.length) continue;
            const span = levelOfCode(code);
            const mx = tx + (span - 1) / 2,
              my = ty + (span - 1) / 2;
            this.points.push({
              x: tileToWorldX(mx, my),
              y: tileToWorldY(mx, my, world.sampleHeight(tx, ty)) - TILE_HH * span * 1.6,
              alerts,
            });
          }
        }
      }
    }
    const phase = Math.floor(now / 2200);
    const layoutStamp = `${stamp}:${camera.zoom}:${camera.x}:${camera.y}:${camera.screenW}:${camera.screenH}:${phase}`;
    if (this.layoutStamp === layoutStamp) return;
    this.layoutStamp = layoutStamp;
    g.clear();
    const points = this.points
      .filter((p) => {
        const { sx, sy } = camera.worldToScreen(p.x, p.y);
        return sx >= -48 && sy >= -48 && sx <= camera.screenW + 48 && sy <= camera.screenH + 48;
      })
      .map((p) => ({ ...p, x: p.x * camera.zoom, y: p.y * camera.zoom - 12 }));
    this.groups = groupAlerts(points, camera.zoom);
    for (const group of this.groups) {
      const { x, y, alerts, count } = group;
      // Most urgent first, then each remaining issue in the same slot.
      const alert = alerts[phase % alerts.length];
      const color = COLORS[alert];
      g.moveTo(x, y + 12)
        .lineTo(x, y + 20)
        .stroke({ color: 0x101820, width: 4 });
      g.circle(x, y, 12)
        .fill({ color: 0x17212d, alpha: 0.96 })
        .stroke({ color: 0xffffff, width: 3 });
      g.circle(x, y, 11).stroke({ color, width: 2 });
      glyph(g, x, y, alert, color);
      if (count > 1) counter(g, x + 6, y - 18, count);
      if (alerts.length > 1) {
        // Multiple issue indicator, distinct from the building-count counter.
        for (let i = 0; i < alerts.length; i++)
          g.rect(x - (alerts.length * 3 - 1) / 2 + i * 3, y + 15, 2, 2).fill(
            i === phase % alerts.length ? 0xffffff : 0x667788,
          );
      }
    }
  }
}

const DIGITS = [
  '111101101101111',
  '010110010010111',
  '111001111100111',
  '111001111001111',
  '101101111001001',
  '111100111001111',
  '111100111101111',
  '111001001001001',
  '111101111101111',
  '111101111001111',
];
function counter(g: Graphics, x: number, y: number, count: number): void {
  const label = count > 99 ? '99+' : String(count);
  g.roundRect(x - 3, y - 3, label.length * 8 + 4, 16, 4)
    .fill(0xf4f0dd)
    .stroke({ color: 0x17212d, width: 1 });
  for (let n = 0; n < label.length; n++) {
    const bits = label[n] === '+' ? '000010111010000' : DIGITS[Number(label[n])];
    for (let i = 0; i < 15; i++)
      if (bits[i] === '1')
        g.rect(x + n * 8 + (i % 3) * 2, y + Math.floor(i / 3) * 2, 2, 2).fill(0x17212d);
  }
}

/**
 * 아이콘 한 개. 스프라이트를 쓰지 않는 이유는 한 Graphics 안에서 배치되어야
 * draw call 이 늘지 않기 때문이다.
 */
function glyph(g: Graphics, x: number, y: number, alert: BuildingAlert, color: number): void {
  switch (alert) {
    case 'road':
      // 끊어진 길
      g.rect(x - 6, y - 1.5, 4, 3).fill(color);
      g.rect(x + 2, y - 1.5, 4, 3).fill(color);
      break;
    case 'power':
      // 번개
      g.poly([
        x + 1,
        y - 7,
        x - 4,
        y + 1,
        x - 0.5,
        y + 1,
        x - 1,
        y + 7,
        x + 4,
        y - 1,
        x + 0.5,
        y - 1,
      ]).fill(color);
      break;
    case 'water':
      // 물방울
      g.poly([x, y - 7, x + 4.5, y + 1.5, x, y + 6, x - 4.5, y + 1.5]).fill(color);
      break;
    case 'sewer':
      // 배관 두 토막
      g.rect(x - 6, y - 3, 12, 2.5).fill(color);
      g.rect(x - 6, y + 1, 12, 2.5).fill(color);
      break;
    case 'pollution':
      // 해골 대신 경고 삼각형
      g.poly([x, y - 7, x + 7, y + 5, x - 7, y + 5]).fill(color);
      g.rect(x - 1, y - 3, 2, 5).fill(0x17212d);
      break;
    case 'fire':
      g.poly([x, y - 7, x + 5, y + 2, x + 2, y + 6, x - 3, y + 6, x - 5, y + 1]).fill(color);
      break;
    case 'police':
      // 방패
      g.poly([x, y - 7, x + 5, y - 4, x + 4, y + 4, x, y + 7, x - 4, y + 4, x - 5, y - 4]).fill(
        color,
      );
      break;
    case 'health':
      g.rect(x - 1.8, y - 6, 3.6, 12).fill(color);
      g.rect(x - 6, y - 1.8, 12, 3.6).fill(color);
      break;
    default:
      // 환경도: 시든 잎
      g.ellipse(x, y, 6, 3.5).fill(color);
      g.rect(x - 0.8, y - 6, 1.6, 6).fill(color);
      break;
  }
}
