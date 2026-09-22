import { Graphics } from 'pixi.js';
import { CHUNK_SIZE, TILE_HH } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import { isAnchor, levelOfCode } from '../sim/buildings';
import type { BuildingAlert } from '../sim/environment';
import type { MacroSim } from '../sim/macro';
import type { World } from '../world/world';

/**
 * 문제가 있는 건물 위에 아이콘을 띄운다 (수정사항 14).
 *
 * 테오타운·시티즈가 하는 그것이다. 도시 전체 통계만 보여주면 플레이어는
 * "전력 78%" 를 읽고도 **어느 건물이** 안 켜지는지 찾을 방법이 없다. 아이콘이
 * 떠 있으면 화면을 훑는 것만으로 다음에 할 일이 보인다.
 *
 * 판정은 MacroSim.buildingAlerts 가 한다. 여기서는 그리기만 한다 — 화면과 규칙이
 * 어긋나지 않게 하려면 판정이 한 곳에만 있어야 한다.
 *
 * 한 건물에 여러 문제가 겹쳐도 **가장 급한 하나만** 띄운다. 아이콘 세 개가
 * 겹쳐 뜨면 무엇부터 해야 하는지가 오히려 안 보인다.
 */
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

/** 한 화면에 띄우는 최대 개수. 넘으면 그리지 않는다 — 아이콘 밭이 되면 못 읽는다. */
const MAX_BADGES = 120;

export class BuildingAlertLayer {
  readonly graphics = new Graphics();
  private stamp = '';

  draw(
    world: World,
    sim: MacroSim,
    range: { cx0: number; cy0: number; cx1: number; cy1: number },
    enabled: boolean,
  ): void {
    this.graphics.visible = enabled;
    if (!enabled) return;
    const stamp = `${world.walkRevision}:${world.utilityRevision}:${sim.tick}:${range.cx0},${range.cy0},${range.cx1},${range.cy1}`;
    if (this.stamp === stamp) return;
    this.stamp = stamp;

    const g = this.graphics;
    g.clear();
    let drawn = 0;
    for (let cy = range.cy0; cy <= range.cy1 && drawn < MAX_BADGES; cy++) {
      for (let cx = range.cx0; cx <= range.cx1 && drawn < MAX_BADGES; cx++) {
        if (!world.isExplored(cx, cy)) continue;
        const p = world.peekParcel(cx, cy);
        if (!p?.bld) continue;
        for (let i = 0; i < p.bld.length && drawn < MAX_BADGES; i++) {
          const code = p.bld[i];
          if (!isAnchor(code)) continue;
          const tx = cx * CHUNK_SIZE + (i % CHUNK_SIZE);
          const ty = cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
          const alert = sim.buildingAlerts(tx, ty)[0];
          if (!alert) continue;
          this.badge(world, tx, ty, levelOfCode(code), alert);
          drawn++;
        }
      }
    }
  }

  private badge(world: World, tx: number, ty: number, span: number, alert: BuildingAlert): void {
    const g = this.graphics;
    const midX = tx + (span - 1) / 2;
    const midY = ty + (span - 1) / 2;
    const x = tileToWorldX(midX, midY);
    const y = tileToWorldY(midX, midY, world.sampleHeight(tx, ty)) - TILE_HH * span * 1.6;
    const color = COLORS[alert];
    g.moveTo(x, y + 9)
      .lineTo(x, y + 20)
      .stroke({ color, width: 2, alpha: 0.9 });
    g.circle(x, y, 10).fill({ color: 0x17212d, alpha: 0.92 }).stroke({ color, width: 2 });
    glyph(g, x, y, alert, color);
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
