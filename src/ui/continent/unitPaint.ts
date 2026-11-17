import { parseChunkKey } from '../../core/iso';
import { OCCUPY_SECONDS, UNIT_SPECS, VISION_CHUNKS } from '../../sim/config/military';
import { unitPosition, type Unit } from '../../sim/military/army';
import type { ArmySystem } from '../../sim/military/armySystem';
import { visionAt } from '../../sim/military/weather';
import type { MapView } from './mapView';
import { UNIT_LETTER, type MapSelection } from './shared';

/**
 * 대륙 지도의 부대: 점령지 칠하기, 내 부대, 보이는 적 부대.
 * 스냅숏 사이를 부드럽게 잇기 위해 부대가 그려진 자리를 기억한다.
 */
export class UnitPainter {
  /** 부대가 화면에 그려진 자리(청크 좌표). */
  private shown = new Map<string, { x: number; y: number }>();
  private lastFrameAt = 0;

  /** 그린다. 움직이는 부대(이동·전투·점령·수송)가 있으면 true. */
  paint(
    ctx: CanvasRenderingContext2D,
    view: MapView,
    army: ArmySystem,
    sel: MapSelection,
    now: number,
  ): boolean {
    const { s, X, Y } = view;
    const war = army.war;
    if (war) paintOccupied(ctx, view, war.occupied, army.uid);
    const dt = Math.min(0.2, (now - (this.lastFrameAt || now)) / 1000);
    this.lastFrameAt = now;
    const pulse = (Math.sin(now / 160) + 1) / 2;
    const r = Math.max(7, Math.min(14, s * 0.45));
    let moving = false;
    const seen = new Set<string>();

    /** 그릴 자리: 목표(계산된 위치) 쪽으로 미끄러지듯. 3청크 넘게 튀면 바로 옮긴다. */
    const place = (u: Unit, mine: boolean): { x: number; y: number } => {
      const target = unitPosition(u);
      const id = `${mine ? 'm' : 'e'}${u.id}`;
      seen.add(id);
      const cur = this.shown.get(id);
      if (!cur || Math.hypot(cur.x - target.x, cur.y - target.y) > 3) {
        this.shown.set(id, { ...target });
        return target;
      }
      const k = Math.min(1, dt * 6);
      cur.x += (target.x - cur.x) * k;
      cur.y += (target.y - cur.y) * k;
      if (Math.hypot(cur.x - target.x, cur.y - target.y) > 0.01) moving = true;
      return cur;
    };

    const drawUnit = (u: Unit, mine: boolean) => {
      if (u.airlift) {
        paintAirlift(ctx, view, u, r);
        moving = true;
        return;
      }
      const p = place(u, mine);
      if (u.state === 'moving' || u.state === 'retreating' || u.state === 'fighting') moving = true;
      const x = X(p.x - 0.5) + s / 2;
      const y = Y(p.y - 0.5) + s / 2;
      // 전투 중: 붉은 고리가 맥박치고 불꽃이 튄다.
      if (u.state === 'fighting') {
        ctx.strokeStyle = `rgba(255, 96, 64, ${0.35 + pulse * 0.5})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, r * (1.3 + pulse * 0.35), 0, Math.PI * 2);
        ctx.stroke();
        const a = (now / 90 + u.id.length) % (Math.PI * 2);
        ctx.fillStyle = '#ffd36b';
        ctx.fillRect(x + Math.cos(a) * r * 1.2 - 1.5, y + Math.sin(a) * r * 1.2 - 1.5, 3, 3);
      }
      // 후퇴: 흐릿하게 깜빡인다.
      ctx.globalAlpha = u.state === 'retreating' ? 0.55 + pulse * 0.35 : 1;
      if (mine && u.state === 'training' && u.readyAt) {
        const total = UNIT_SPECS[u.type].buildSec * 1000;
        progressRing(ctx, x, y, r * 1.35, 1 - (u.readyAt - Date.now()) / total, '#9fb3bd', 2);
      }
      if (mine && u.occupyAt !== undefined) {
        progressRing(
          ctx,
          x,
          y,
          r * 1.45,
          (Date.now() - u.occupyAt) / (OCCUPY_SECONDS * 1000),
          '#6fd3b8',
          3,
        );
        moving = true;
      }
      if (mine && u.id === sel.unit && u.path.length) paintPath(ctx, view, x, y, u.path);
      paintBadge(ctx, u, x, y, r, s, mine, mine && (u.id === sel.unit || sel.picked.has(u.id)));
      ctx.globalAlpha = 1;
    };

    for (const u of army.units) drawUnit(u, true);
    if (war) {
      const visible = enemyVisibility(army);
      for (const e of war.enemy.units) if (e.state !== 'training' && visible(e)) drawUnit(e, false);
    }
    for (const id of [...this.shown.keys()]) if (!seen.has(id)) this.shown.delete(id);
    return moving;
  }
}

/** 점령한(초록)·빼앗긴(빨강) 청크: 칠하고 사선 하나. */
function paintOccupied(
  ctx: CanvasRenderingContext2D,
  view: MapView,
  occupied: ReadonlyMap<string, string>,
  me: string,
): void {
  const { s, X, Y } = view;
  for (const [key, who] of occupied) {
    const { cx, cy } = parseChunkKey(key);
    ctx.fillStyle = who === me ? 'rgba(111, 211, 184, 0.55)' : 'rgba(226, 87, 76, 0.55)';
    ctx.fillRect(X(cx), Y(cy), s, s);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X(cx), Y(cy) + s);
    ctx.lineTo(X(cx) + s, Y(cy));
    ctx.stroke();
  }
}

/**
 * 적 부대가 보이는가: 내 부대·영토에서 시야(2청크, 밤에는 절반) 안, 또는 레이더 안.
 */
function enemyVisibility(army: ArmySystem): (e: Unit) => boolean {
  const radar = army.visionSources();
  const vis = visionAt(Date.now(), VISION_CHUNKS);
  const owned = army.mySide().owned;
  return (e) => {
    for (const u of army.units)
      if (u.state !== 'training' && Math.max(Math.abs(u.cx - e.cx), Math.abs(u.cy - e.cy)) <= vis)
        return true;
    for (let dy = -vis; dy <= vis; dy++)
      for (let dx = -vis; dx <= vis; dx++) if (owned.has(`${e.cx + dx},${e.cy + dy}`)) return true;
    for (const r of radar)
      if (Math.max(Math.abs(r.cx - e.cx), Math.abs(r.cy - e.cy)) <= r.r) return true;
    return false;
  };
}

/** 위에서부터 시계 방향으로 차오르는 진행 고리(f = 0~1). */
function progressRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  f: number,
  color: string,
  width: number,
): void {
  const k = Math.max(0, Math.min(1, f));
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
  ctx.stroke();
}

/** 고른 부대의 남은 경로(금색 점선). */
function paintPath(
  ctx: CanvasRenderingContext2D,
  view: MapView,
  x: number,
  y: number,
  path: readonly string[],
): void {
  const { s, X, Y } = view;
  ctx.strokeStyle = '#f2cf7a';
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  for (const k of path) {
    const c = parseChunkKey(k);
    ctx.lineTo(X(c.cx) + s / 2, Y(c.cy) + s / 2);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

/** 부대 표: 색 상자 + 병종 글자 + 조직력 막대 + 인원. */
function paintBadge(
  ctx: CanvasRenderingContext2D,
  u: Unit,
  x: number,
  y: number,
  r: number,
  s: number,
  mine: boolean,
  on: boolean,
): void {
  ctx.fillStyle = mine ? (u.state === 'training' ? '#5b6e78' : '#2f6fd0') : '#c8402f';
  ctx.strokeStyle = on ? '#f2cf7a' : '#0d1418';
  ctx.lineWidth = on ? 3 : 1.5;
  ctx.beginPath();
  ctx.rect(x - r, y - r * 0.75, r * 2, r * 1.5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.round(r * 0.95)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(UNIT_LETTER[u.type], x, y + 1);
  ctx.fillStyle = '#0d1418';
  ctx.fillRect(x - r, y + r * 0.75 + 2, r * 2, 3);
  ctx.fillStyle = u.org > 40 ? '#6fe08a' : '#e2a44c';
  ctx.fillRect(x - r, y + r * 0.75 + 2, (r * 2 * u.org) / 100, 3);
  if (s >= 6) {
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillStyle = '#f4f1e6';
    ctx.fillText(`${Math.round(u.men)}`, x, y + r * 0.75 + 12);
  }
  ctx.textBaseline = 'alphabetic';
}

/** 수송기: 출발지 → 도착지 점선 위를 나는 비행기. */
function paintAirlift(ctx: CanvasRenderingContext2D, view: MapView, u: Unit, r: number): void {
  const { s, X, Y } = view;
  const a = parseChunkKey(u.airlift!.from);
  const b = parseChunkKey(u.airlift!.to);
  const p = unitPosition(u);
  const x = X(p.x - 0.5) + s / 2;
  const y = Y(p.y - 0.5) + s / 2;
  ctx.strokeStyle = 'rgba(242, 207, 122, 0.6)';
  ctx.setLineDash([3, 4]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(X(a.cx) + s / 2, Y(a.cy) + s / 2);
  ctx.lineTo(X(b.cx) + s / 2, Y(b.cy) + s / 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.save();
  ctx.translate(x, y - 4);
  ctx.rotate(Math.atan2(b.cy - a.cy, b.cx - a.cx));
  ctx.fillStyle = '#e8eef2';
  ctx.strokeStyle = '#0d1418';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(-r * 0.8, -r * 0.25);
  ctx.lineTo(-r * 0.8, r * 0.25);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillRect(-r * 0.2, -r * 0.8, r * 0.35, r * 1.6);
  ctx.restore();
}
