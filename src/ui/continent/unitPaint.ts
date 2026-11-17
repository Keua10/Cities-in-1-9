import { parseChunkKey } from '../../core/iso';
import { reducedMotion } from '../../core/motion';
import { OCCUPY_SECONDS, UNIT_SPECS, VISION_CHUNKS } from '../../sim/config/military';
import { unitPosition, type Unit } from '../../sim/military/army';
import type { ArmySystem } from '../../sim/military/armySystem';
import { visionAt } from '../../sim/military/weather';
import type { MapView } from './mapView';
import { UNIT_LETTER, type MapSelection } from './shared';

/** 화면에 그린 부대 표 하나(누르기·이름표 피하기에 쓴다). */
export interface UnitHit {
  x: number;
  y: number;
  /** 이 표에 묶인 내 부대 id(적이면 빈 배열). */
  ids: string[];
  r: number;
}

/** 맞았을 때 흔들리는 시간(ms). */
const HIT_MS = 260;
/** 조직력 막대의 빨간 꼬리가 줄어드는 속도(%/초). */
const LAG_DECAY = 18;

const MINE = '#2f6fd0';
const MINE_TRAINING = '#5b6e78';
const ENEMY = '#c8402f';
const GOLD = '#f2cf7a';
const INK = '#0d1418';

/** 한 자리에 그리는 부대 묶음. */
interface Group {
  mine: boolean;
  units: Unit[];
  /** 청크 좌표(실수). */
  x: number;
  y: number;
  /** 같은 청크에 상대 진영이 있다(좌우로 벌려 그린다). */
  contested: boolean;
  fighting: boolean;
}

/**
 * 대륙 지도의 부대: 점령지, 내 부대, 보이는 적 부대.
 *
 * - 멈춰 있는 부대는 청크마다 진영별로 표 하나로 묶고 ×n 을 붙인다.
 * - 한 청크에 두 진영이 있으면 내 쪽은 왼쪽, 적은 오른쪽으로 벌리고 사이에 총탄이 오간다.
 * - 조직력이 줄면 표가 잠깐 흔들리고 막대에 빨간 꼬리가 남는다.
 * - 움직이는 부대는 앞에 화살촉, 내 부대는 목적지에 표식.
 * - 점령 중이면 그 청크 테두리가 시계 방향으로 채워진다.
 */
export class UnitPainter {
  /** 부대가 화면에 그려진 자리(청크 좌표). 스냅숏 사이를 부드럽게 잇는다. */
  private shown = new Map<string, { x: number; y: number }>();
  /** 지난 프레임 조직력(맞았는지 판단). */
  private lastOrg = new Map<string, number>();
  /** 빨간 꼬리가 따라 내려오는 조직력. */
  private lagOrg = new Map<string, number>();
  private hitUntil = new Map<string, number>();
  private lastFrameAt = 0;
  /** 이번 프레임에 그린 표들. */
  hits: UnitHit[] = [];

  /** 그린다. 움직이는 것(이동·전투·점령·수송·흔들림)이 있으면 true. */
  paint(
    ctx: CanvasRenderingContext2D,
    view: MapView,
    army: ArmySystem,
    sel: MapSelection,
    now: number,
  ): boolean {
    const still = reducedMotion();
    const { s, X, Y } = view;
    const war = army.war;
    if (war) paintOccupied(ctx, view, war.occupied, army.uid);
    const dt = Math.min(0.2, (now - (this.lastFrameAt || now)) / 1000);
    this.lastFrameAt = now;
    const pulse = still ? 0.6 : (Math.sin(now / 160) + 1) / 2;
    const r = Math.max(7, Math.min(14, s * 0.45));
    let moving = false;
    const seen = new Set<string>();
    this.hits = [];

    /** 그릴 자리: 목표(계산된 위치) 쪽으로 미끄러지듯. 3청크 넘게 튀면 바로 옮긴다. */
    const place = (u: Unit, mine: boolean): { x: number; y: number } => {
      const target = unitPosition(u);
      const id = `${mine ? 'm' : 'e'}${u.id}`;
      if (seen.has(id)) return this.shown.get(id) ?? target;
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
    /** 조직력 변화를 보고 흔들림·빨간 꼬리를 갱신한다. */
    const track = (u: Unit, mine: boolean) => {
      const id = `${mine ? 'm' : 'e'}${u.id}`;
      const prev = this.lastOrg.get(id);
      if (prev !== undefined && u.org < prev - 0.3) this.hitUntil.set(id, now + HIT_MS);
      this.lastOrg.set(id, u.org);
      const lag = Math.max(u.org, (this.lagOrg.get(id) ?? u.org) - LAG_DECAY * dt);
      this.lagOrg.set(id, lag);
      if (lag > u.org + 0.1) moving = true;
      return { hit: (this.hitUntil.get(id) ?? 0) > now, lag };
    };

    // 1) 그릴 부대 모으기(적은 보이는 것만). 수송기는 따로.
    for (const u of army.units)
      if (u.airlift) {
        paintAirlift(ctx, view, u, r);
        moving = true;
      }
    const mine = army.units.filter((u) => !u.airlift);
    const visible = war ? enemyVisibility(army) : null;
    const enemy = war
      ? war.enemy.units.filter((e) => e.state !== 'training' && !e.airlift && visible!(e))
      : [];
    const groups = groupUnits(mine, enemy, place);

    // 2) 경로·목적지(표보다 아래).
    for (const u of mine) {
      if (!u.path.length) continue;
      const p = place(u, true);
      if (u.id === sel.unit) paintPath(ctx, view, X(p.x), Y(p.y), u.path);
      paintDestination(ctx, view, u.path[u.path.length - 1], u.id === sel.unit);
    }
    // 3) 점령 진행: 청크 테두리.
    for (const u of mine)
      if (u.occupyAt !== undefined) {
        const f = (Date.now() - u.occupyAt) / (OCCUPY_SECONDS * 1000);
        paintOccupyBorder(ctx, view, u.cx, u.cy, f);
        moving = true;
      }
    // 4) 교전: 두 진영을 감싸는 고리와 그 사이 총탄.
    const offset = r + 2;
    const contested = new Map<string, { x: number; y: number; fighting: boolean }>();
    for (const g of groups)
      if (g.contested) {
        const key = `${Math.floor(g.x)},${Math.floor(g.y)}`;
        const c = contested.get(key) ?? { x: X(g.x), y: Y(g.y), fighting: false };
        c.fighting ||= g.fighting;
        contested.set(key, c);
      }
    for (const c of contested.values()) {
      if (!c.fighting) continue;
      moving = true;
      ctx.strokeStyle = `rgba(255, 90, 60, ${0.55 + pulse * 0.4})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, offset + r * 1.5 + pulse * 3, r * 1.4 + pulse * 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      paintTracers(ctx, c.x - offset, c.x + offset, c.y, now, still);
    }
    // 5) 표.
    for (const g of groups) {
      const lead = g.units.find((u) => u.id === sel.unit) ?? g.units[0];
      let x = X(g.x);
      const y = Y(g.y);
      if (g.contested) x += g.mine ? -offset : offset;
      let hit = false;
      let org = 0;
      let lag = 0;
      let men = 0;
      for (const u of g.units) {
        const t = track(u, g.mine);
        hit ||= t.hit;
        org += u.org * u.men;
        lag += t.lag * u.men;
        men += u.men;
      }
      org = men ? org / men : lead.org;
      lag = men ? lag / men : org;
      if (hit && !still) {
        x += Math.sin(now / 18) * 2.5;
        moving = true;
      }
      if (!g.contested && g.fighting) {
        // 상대가 안 보이는 전투(시야 밖 포격 등)도 고리는 그린다.
        ctx.strokeStyle = `rgba(255, 90, 60, ${0.55 + pulse * 0.4})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, r * (1.35 + pulse * 0.25), 0, Math.PI * 2);
        ctx.stroke();
      }
      const retreating = g.units.every((u) => u.state === 'retreating');
      ctx.globalAlpha = retreating ? 0.55 + pulse * 0.35 : 1;
      if (g.mine && lead.state === 'training' && lead.readyAt) {
        const total = UNIT_SPECS[lead.type].buildSec * 1000;
        progressRing(ctx, x, y, r * 1.35, 1 - (lead.readyAt - Date.now()) / total, '#9fb3bd', 2);
      }
      if (lead.path.length && (lead.state === 'moving' || lead.state === 'retreating')) {
        paintArrowhead(ctx, view, x, y, lead, r, g.mine);
        moving = true;
      }
      const on = g.mine && g.units.some((u) => u.id === sel.unit || sel.picked.has(u.id));
      paintBadge(ctx, lead.type, x, y, r, s, {
        fill: g.mine ? (lead.state === 'training' ? MINE_TRAINING : MINE) : ENEMY,
        on,
        count: g.units.length,
        men,
        org,
        lag,
      });
      ctx.globalAlpha = 1;
      this.hits.push({ x, y, r, ids: g.mine ? g.units.map((u) => u.id) : [] });
    }
    for (const id of [...this.shown.keys()])
      if (!seen.has(id)) {
        this.shown.delete(id);
        this.lastOrg.delete(id);
        this.lagOrg.delete(id);
        this.hitUntil.delete(id);
      }
    return moving;
  }
}

/**
 * 멈춘 부대는 (진영, 청크)로 묶는다. 청크 사이를 가는 부대는 혼자 그린다.
 * 같은 청크에 두 진영이 멈춰 있으면 양쪽 모두 contested.
 */
function groupUnits(
  mine: readonly Unit[],
  enemy: readonly Unit[],
  place: (u: Unit, mine: boolean) => { x: number; y: number },
): Group[] {
  const out: Group[] = [];
  const still = new Map<string, Group>();
  const sides = new Map<string, Set<boolean>>();
  const add = (u: Unit, isMine: boolean) => {
    const p = place(u, isMine);
    const fighting = u.state === 'fighting';
    if (u.path.length > 0 && u.progress > 0) {
      out.push({ mine: isMine, units: [u], x: p.x, y: p.y, contested: false, fighting });
      return;
    }
    const key = `${u.cx},${u.cy}`;
    const set = sides.get(key) ?? new Set<boolean>();
    set.add(isMine);
    sides.set(key, set);
    const gk = `${isMine ? 'm' : 'e'}${key}`;
    const g = still.get(gk);
    if (g) {
      g.units.push(u);
      g.fighting ||= fighting;
    } else {
      const grp: Group = { mine: isMine, units: [u], x: p.x, y: p.y, contested: false, fighting };
      still.set(gk, grp);
      out.push(grp);
    }
  };
  for (const u of mine) add(u, true);
  for (const e of enemy) add(e, false);
  for (const g of still.values()) {
    const u = g.units[0];
    g.contested = (sides.get(`${u.cx},${u.cy}`)?.size ?? 0) > 1;
    // 묶음·교전은 청크 가운데에.
    if (g.units.length > 1 || g.contested) {
      g.x = u.cx + 0.5;
      g.y = u.cy + 0.5;
    }
  }
  return out;
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

/** 적 부대가 보이는가: 내 부대·영토에서 시야(2청크, 밤에는 절반) 안, 또는 레이더 안. */
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

/** 점령 진행: 청크 테두리가 왼쪽 위에서 시계 방향으로 채워진다. */
function paintOccupyBorder(
  ctx: CanvasRenderingContext2D,
  view: MapView,
  cx: number,
  cy: number,
  f: number,
): void {
  const { s, X, Y } = view;
  const x0 = X(cx);
  const y0 = Y(cy);
  const corners = [
    [x0, y0],
    [x0 + s, y0],
    [x0 + s, y0 + s],
    [x0, y0 + s],
    [x0, y0],
  ];
  ctx.fillStyle = 'rgba(111, 211, 184, 0.12)';
  ctx.fillRect(x0, y0, s, s);
  ctx.strokeStyle = 'rgba(13, 20, 24, 0.6)';
  ctx.lineWidth = 4;
  ctx.strokeRect(x0, y0, s, s);
  let left = Math.max(0, Math.min(1, f)) * 4 * s;
  ctx.strokeStyle = '#6fd3b8';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  for (let i = 1; i < corners.length && left > 0; i++) {
    const [ax, ay] = corners[i - 1];
    const [bx, by] = corners[i];
    const d = Math.min(s, left);
    ctx.lineTo(ax + ((bx - ax) * d) / s, ay + ((by - ay) * d) / s);
    left -= s;
  }
  ctx.stroke();
}

/** 두 표 사이로 오가는 총탄: 흐르는 점선 + 양쪽에서 날아가는 탄. */
function paintTracers(
  ctx: CanvasRenderingContext2D,
  xa: number,
  xb: number,
  y: number,
  now: number,
  still: boolean,
): void {
  ctx.strokeStyle = 'rgba(255, 220, 140, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 4]);
  ctx.lineDashOffset = still ? 0 : -now / 25;
  ctx.beginPath();
  ctx.moveTo(xa, y);
  ctx.lineTo(xb, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  if (still) return;
  const k = (now / 320) % 1;
  ctx.fillStyle = '#ffe9a8';
  ctx.fillRect(xa + (xb - xa) * k - 2, y - 3.5, 4, 2.5);
  ctx.fillStyle = '#ffb08a';
  ctx.fillRect(xb - (xb - xa) * ((k + 0.5) % 1) - 2, y + 1, 4, 2.5);
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
  ctx.strokeStyle = GOLD;
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

/** 목적지 표식: 금색 과녁. 고르지 않은 부대는 옅게. */
function paintDestination(
  ctx: CanvasRenderingContext2D,
  view: MapView,
  key: string,
  strong: boolean,
): void {
  const { s, X, Y } = view;
  const c = parseChunkKey(key);
  const x = X(c.cx) + s / 2;
  const y = Y(c.cy) + s / 2;
  const R = Math.max(4, Math.min(9, s * 0.3));
  const cross = () => {
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.moveTo(x - R * 1.5, y);
    ctx.lineTo(x - R * 0.5, y);
    ctx.moveTo(x + R * 0.5, y);
    ctx.lineTo(x + R * 1.5, y);
    ctx.moveTo(x, y - R * 1.5);
    ctx.lineTo(x, y - R * 0.5);
    ctx.moveTo(x, y + R * 0.5);
    ctx.lineTo(x, y + R * 1.5);
    ctx.stroke();
  };
  ctx.globalAlpha = strong ? 1 : 0.55;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3.5;
  cross();
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 1.5;
  cross();
  ctx.globalAlpha = 1;
}

/** 가는 방향을 가리키는 작은 화살촉(표 앞쪽). */
function paintArrowhead(
  ctx: CanvasRenderingContext2D,
  view: MapView,
  x: number,
  y: number,
  u: Unit,
  r: number,
  mine: boolean,
): void {
  const n = parseChunkKey(u.path[0]);
  const dx = view.X(n.cx + 0.5) - x;
  const dy = view.Y(n.cy + 0.5) - y;
  if (Math.hypot(dx, dy) < 0.5) return;
  const ang = Math.atan2(dy, dx);
  const d = r * 1.55;
  ctx.save();
  ctx.translate(x + Math.cos(ang) * d, y + Math.sin(ang) * d);
  ctx.rotate(ang);
  ctx.fillStyle = mine ? '#cfe2ff' : '#ffc7bd';
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(5, 0);
  ctx.lineTo(-3, -4.5);
  ctx.lineTo(-3, 4.5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** 부대 표: 색 상자 + 병종 글자 + ×n + 조직력 막대(빨간 꼬리) + 인원. */
function paintBadge(
  ctx: CanvasRenderingContext2D,
  type: Unit['type'],
  x: number,
  y: number,
  r: number,
  s: number,
  o: { fill: string; on: boolean; count: number; men: number; org: number; lag: number },
): void {
  ctx.fillStyle = o.fill;
  ctx.strokeStyle = o.on ? GOLD : INK;
  ctx.lineWidth = o.on ? 3 : 1.5;
  ctx.beginPath();
  ctx.rect(x - r, y - r * 0.75, r * 2, r * 1.5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.round(r * 0.95)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(UNIT_LETTER[type], x, y + 1);
  if (o.count > 1) {
    const bx = x + r;
    const by = y - r * 0.75;
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(bx, by, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = GOLD;
    ctx.font = '700 9px system-ui, sans-serif';
    ctx.fillText(`×${o.count}`, bx, by + 0.5);
  }
  const barY = y + r * 0.75 + 2;
  const w = r * 2;
  ctx.fillStyle = INK;
  ctx.fillRect(x - r, barY, w, 3);
  if (o.lag > o.org) {
    ctx.fillStyle = '#ff5a3c';
    ctx.fillRect(x - r + (w * o.org) / 100, barY, (w * (o.lag - o.org)) / 100, 3);
  }
  ctx.fillStyle = o.org > 40 ? '#6fe08a' : '#e2a44c';
  ctx.fillRect(x - r, barY, (w * o.org) / 100, 3);
  if (s >= 6) {
    const label = `${Math.round(o.men)}`;
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.strokeStyle = 'rgba(10, 16, 20, 0.8)';
    ctx.lineWidth = 2.5;
    ctx.strokeText(label, x, barY + 10);
    ctx.fillStyle = '#f4f1e6';
    ctx.fillText(label, x, barY + 10);
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
  ctx.strokeStyle = INK;
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
