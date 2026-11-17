import { parseChunkKey } from '../../core/iso';
import { reducedMotion } from '../../core/motion';
import type { ArmySystem, MapEffect } from '../../sim/military/armySystem';
import type { MapView } from './mapView';

/** 내 땅이 맞은 뒤 화살표가 남아 있는 시간(ms). */
const ALERT_MS = 10_000;
/** 화면 가장자리에서 화살표까지 거리(px). */
const INSET = 20;
const MAX_ARROWS = 4;
/** 흔들림: 맞은 뒤 이만큼(ms) 동안, 최대 이 폭(px)으로. */
const SHAKE_MS = 450;
const SHAKE_PX = 5;

interface Target {
  cx: number;
  cy: number;
  until: number;
}

/**
 * 화면 밖에서 내 땅이 공격받으면 화면 가장자리에 빨간 화살표를 띄운다.
 * 대상: 내 땅에 떨어진 폭격·미사일, 내 땅에서 시작된 교전, 내 땅 안의 적 부대.
 * 누르면 그곳으로 시점을 옮긴다(hitAt).
 */
export class EdgeAlerts {
  private targets = new Map<string, Target>();
  private seen = new Set<string>();
  private arrows: Array<{ x: number; y: number; cx: number; cy: number; ang: number }> = [];

  /** 새 효과·적 부대를 보고 대상을 갱신한다. */
  update(army: ArmySystem, owned: ReadonlySet<string>, now: number): void {
    for (const e of army.effects) {
      if (e.kind !== 'boom' && e.kind !== 'clash') continue;
      const id = `${e.kind}|${e.key}|${e.at}`;
      if (this.seen.has(id) || !owned.has(e.key)) continue;
      this.seen.add(id);
      const { cx, cy } = parseChunkKey(e.key);
      this.targets.set(e.key, { cx, cy, until: now + ALERT_MS });
    }
    if (this.seen.size > 200) this.seen.clear();
    for (const u of army.war?.enemy.units ?? []) {
      const key = `${u.cx},${u.cy}`;
      if (u.state !== 'training' && owned.has(key))
        this.targets.set(`e${u.id}`, { cx: u.cx, cy: u.cy, until: now + 1500 });
    }
    for (const [k, t] of this.targets) if (t.until < now) this.targets.delete(k);
  }

  /** 화면 밖 대상만 화살표로. 그린 게 있으면 true(깜빡이므로). */
  paint(ctx: CanvasRenderingContext2D, view: MapView, now: number): boolean {
    const w = view.width;
    const h = view.height;
    const mx = w / 2;
    const my = h / 2;
    const out: Array<{ x: number; y: number; cx: number; cy: number; d: number; ang: number }> = [];
    const taken = new Set<string>();
    for (const t of this.targets.values()) {
      const tx = view.X(t.cx + 0.5);
      const ty = view.Y(t.cy + 0.5);
      if (tx >= 0 && tx <= w && ty >= 0 && ty <= h) continue;
      const k = `${t.cx},${t.cy}`;
      if (taken.has(k)) continue;
      taken.add(k);
      const ang = Math.atan2(ty - my, tx - mx);
      // 가운데에서 대상 쪽으로 쏜 선이 안쪽 사각형 테두리와 만나는 점.
      const kx = (w / 2 - INSET) / Math.max(1e-6, Math.abs(Math.cos(ang)));
      const ky = (h / 2 - INSET) / Math.max(1e-6, Math.abs(Math.sin(ang)));
      const k2 = Math.min(kx, ky);
      out.push({
        x: mx + Math.cos(ang) * k2,
        y: my + Math.sin(ang) * k2,
        cx: t.cx,
        cy: t.cy,
        d: Math.hypot(tx - mx, ty - my),
        ang,
      });
    }
    out.sort((a, b) => a.d - b.d);
    this.arrows = out.slice(0, MAX_ARROWS);
    const pulse = reducedMotion() ? 1 : 0.6 + 0.4 * Math.sin(now / 180);
    for (const a of this.arrows) {
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.rotate(a.ang);
      ctx.fillStyle = `rgba(226, 75, 74, ${0.7 + 0.3 * pulse})`;
      ctx.strokeStyle = '#1b0b0b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(12, 0);
      ctx.lineTo(-8, -10);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-8, 10);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      ctx.restore();
    }
    return this.arrows.length > 0;
  }

  /** 화살표를 눌렀으면 그 대상 청크. */
  hitAt(px: number, py: number): { cx: number; cy: number } | null {
    for (const a of this.arrows) if (Math.hypot(px - a.x, py - a.y) < 24) return a;
    return null;
  }
}

/** 내 땅에 막 떨어진 폭발이 있으면 화면 흔들림 오프셋. 동작 줄이기면 0. */
export function shakeOffset(
  effects: readonly MapEffect[],
  owned: ReadonlySet<string>,
  now: number,
): { x: number; y: number } {
  if (reducedMotion()) return { x: 0, y: 0 };
  let amp = 0;
  for (const e of effects) {
    if (e.kind !== 'boom' || !owned.has(e.key)) continue;
    const age = now - e.at;
    if (age >= 0 && age < SHAKE_MS) amp = Math.max(amp, SHAKE_PX * (1 - age / SHAKE_MS));
  }
  if (!amp) return { x: 0, y: 0 };
  return { x: Math.sin(now / 23) * amp, y: Math.cos(now / 31) * amp * 0.7 };
}
