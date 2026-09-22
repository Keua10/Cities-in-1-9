import { Graphics } from 'pixi.js';
import { TILE_HH, TILE_HW } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import type { StructureEvent } from '../world/world';
import type { World } from '../world/world';

/**
 * 건설·철거·신축 애니메이션 (수정사항 2).
 *
 * 화면에서 무슨 일이 일어났는지 **보이게** 하는 것이 전부다. 예전에는 탭을
 * 하면 타일 색만 바뀌어서, 지어진 것인지 아무 일도 없었던 것인지 구분이 안 됐다.
 *
 * 청크 메시와 건물 메시는 건드리지 않는다. 효과는 전부 이 Graphics 하나에
 * 그려지므로 draw call 이 늘지 않고, 하나도 없으면 아무것도 그리지 않는다.
 *
 *   build     놓은 칸에서 퍼지는 고리 + 밝은 마름모
 *   grow      바닥에서 올라오는 상자 윤곽 (건물이 서는 모습)
 *   demolish  먼지 구름처럼 퍼지며 흩어지는 점들
 */
interface Effect extends StructureEvent {
  startedAt: number;
}

const DURATION: Record<StructureEvent['kind'], number> = {
  build: 420,
  grow: 900,
  demolish: 620,
};

/** 한 번에 살아 있는 효과의 최대 수. 도시가 한꺼번에 자랄 때 화면이 죽지 않게. */
const MAX_EFFECTS = 80;

export class EffectLayer {
  readonly graphics = new Graphics();
  private effects: Effect[] = [];
  enabled = true;

  push(e: StructureEvent, now: number): void {
    if (!this.enabled) return;
    if (this.effects.length >= MAX_EFFECTS) this.effects.shift();
    this.effects.push({ ...e, startedAt: now });
  }

  /** 프레임마다 부른다. 남은 효과가 없으면 곧바로 빠져나온다. */
  update(world: World, now: number): void {
    if (this.effects.length === 0) {
      if (this.graphics.visible) {
        this.graphics.clear();
        this.graphics.visible = false;
      }
      return;
    }
    this.graphics.visible = true;
    const g = this.graphics;
    g.clear();
    const alive: Effect[] = [];
    for (const e of this.effects) {
      const t = (now - e.startedAt) / DURATION[e.kind];
      if (t >= 1) continue;
      alive.push(e);
      const mid = (e.span - 1) / 2;
      const x = tileToWorldX(e.tx + mid, e.ty + mid);
      const y = tileToWorldY(e.tx + mid, e.ty + mid, world.sampleHeight(e.tx, e.ty));
      if (e.kind === 'build') ring(g, x, y, e.span, t);
      else if (e.kind === 'grow') rise(g, x, y, e.span, t);
      else dust(g, x, y, e.span, t);
    }
    this.effects = alive;
  }
}

/** 놓은 칸에서 한 번 퍼지는 고리. */
function ring(g: Graphics, x: number, y: number, span: number, t: number): void {
  const grow = 0.6 + t * 0.9;
  const w = TILE_HW * span * grow;
  const h = TILE_HH * span * grow;
  g.poly([x, y - h, x + w, y, x, y + h, x - w, y]);
  g.stroke({ color: 0xd8f1ff, width: 2, alpha: (1 - t) * 0.9 });
  g.poly([
    x,
    y - TILE_HH * span,
    x + TILE_HW * span,
    y,
    x,
    y + TILE_HH * span,
    x - TILE_HW * span,
    y,
  ]);
  g.fill({ color: 0xffffff, alpha: (1 - t) * 0.22 });
}

/**
 * 바닥에서 올라오는 상자 윤곽.
 *
 * 실제 건물 메시는 완성형으로 한 번에 나타난다(메시 구조를 바꾸지 않기로 한
 * 결정 때문이다). 그래서 **그 위에 올라오는 윤곽을 덧그려** 서는 과정을 만든다 —
 * 윤곽이 다 올라오는 순간 건물과 겹쳐지며 사라진다.
 */
function rise(g: Graphics, x: number, y: number, span: number, t: number): void {
  const eased = t * t * (3 - 2 * t);
  const full = TILE_HH * span * 3.2;
  const top = y - full * eased;
  const w = TILE_HW * span;
  const h = TILE_HH * span;
  const alpha = (1 - t) * 0.85;
  // 올라온 만큼의 기둥 네 모서리
  for (const [dx, dy] of [
    [0, -h],
    [w, 0],
    [0, h],
    [-w, 0],
  ]) {
    g.moveTo(x + dx, y + dy).lineTo(x + dx, top + dy);
  }
  g.stroke({ color: 0xffe9a8, width: 1.6, alpha });
  // 올라온 높이의 윗면
  g.poly([x, top - h, x + w, top, x, top + h, x - w, top]);
  g.stroke({ color: 0xffe9a8, width: 2, alpha });
  g.fill({ color: 0xffd76a, alpha: alpha * 0.18 });
}

/** 먼지 구름. 점 여덟 개가 바깥으로 퍼지며 옅어진다. */
function dust(g: Graphics, x: number, y: number, span: number, t: number): void {
  const spread = TILE_HW * span * (0.3 + t * 1.1);
  const lift = TILE_HH * span * t * 1.4;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const px = x + Math.cos(a) * spread;
    const py = y + Math.sin(a) * spread * 0.5 - lift;
    g.circle(px, py, 3 + span + t * 3);
  }
  g.fill({ color: 0xcfc4b2, alpha: (1 - t) * 0.55 });
}
