import { parseChunkKey } from '../../core/iso';
import type { MapEffect } from '../../sim/military/armySystem';
import type { MapView } from './mapView';
import { reducedMotion } from '../../core/motion';

/** 효과 하나가 화면에 남는 시간(ms). armySystem 이 3초 지난 효과를 지운다. */
const EFFECT_MS = 3000;
const MISSILE_FLIGHT_S = 1.2;

/** 미사일·폭발·요격·점령·교전 효과. 그린 게 있으면 true. */
export function paintEffects(
  ctx: CanvasRenderingContext2D,
  view: MapView,
  effects: readonly MapEffect[],
  now: number,
): boolean {
  const { s, X, Y } = view;
  const center = (key: string) => {
    const { cx, cy } = parseChunkKey(key);
    return { x: X(cx) + s / 2, y: Y(cy) + s / 2 };
  };
  let any = false;
  for (const e of effects) {
    if (now - e.at >= EFFECT_MS) continue;
    any = true;
    const t = (now - e.at) / 1000;
    const c = center(e.key);
    if (e.kind === 'missile' && e.from) missile(ctx, center(e.from), c, s, t);
    else if (e.kind === 'boom' || e.kind === 'bomb') {
      boom(ctx, c.x, c.y, s, t);
      shockwave(ctx, c.x, c.y, s, t);
    } else if (e.kind === 'intercept') intercept(ctx, c.x, c.y, s, t);
    else if (e.kind === 'occupy') {
      spread(ctx, c.x, c.y, s, t);
      flag(ctx, c.x, c.y, s, t);
    } else if (e.kind === 'clash') clash(ctx, c.x, c.y, s, t);
  }
  return any;
}

type Pt = { x: number; y: number };

/** 발사 섬광 → 연기 꼬리를 끌며 1.2초 포물선 비행 → 폭발 + 충격파. */
function missile(ctx: CanvasRenderingContext2D, a: Pt, c: Pt, s: number, t: number): void {
  if (t < 0.3) {
    // 발사 섬광
    const k = t / 0.3;
    ctx.fillStyle = `rgba(255, 245, 220, ${0.85 * (1 - k)})`;
    ctx.beginPath();
    ctx.arc(a.x, a.y, Math.max(6, s * 0.5) * (0.5 + k), 0, Math.PI * 2);
    ctx.fill();
  }
  const f = Math.min(1, t / MISSILE_FLIGHT_S);
  if (f >= 1) {
    boom(ctx, c.x, c.y, s, t - MISSILE_FLIGHT_S);
    shockwave(ctx, c.x, c.y, s, t - MISSILE_FLIGHT_S);
    return;
  }
  const lift = Math.hypot(c.x - a.x, c.y - a.y) * 0.35;
  const at = (g: number): Pt => ({
    x: a.x + (c.x - a.x) * g,
    y: a.y + (c.y - a.y) * g - Math.sin(g * Math.PI) * lift,
  });
  // 연기 꼬리: 머리 뒤로 갈수록 굵고 옅다.
  for (let i = 1; i <= 14; i++) {
    const g = f - i * 0.025;
    if (g <= 0) break;
    const p = at(g);
    ctx.fillStyle = `rgba(205, 205, 200, ${0.5 - i * 0.032})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.5 + i * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }
  const head = at(f);
  ctx.fillStyle = '#fff3c4';
  ctx.beginPath();
  ctx.arc(head.x, head.y, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

/** 폭발: 섬광 → 불덩이 → 연기 고리. t = 터진 뒤 초. */
function boom(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, t: number): void {
  if (t < 0 || t > 1.8) return;
  const R = Math.max(8, s * 0.9);
  const f = t / 1.8;
  ctx.fillStyle = `rgba(255, 240, 200, ${Math.max(0, 0.9 - t * 4)})`;
  ctx.beginPath();
  ctx.arc(x, y, R * (0.4 + t * 2), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(255, 120, 40, ${Math.max(0, 0.8 - f)})`;
  ctx.beginPath();
  ctx.arc(x, y, R * (0.3 + f * 0.7), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(60, 60, 60, ${Math.max(0, 0.6 - f * 0.6)})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, R * (0.5 + f * 1.2), 0, Math.PI * 2);
  ctx.stroke();
}

/** 터진 자리에서 퍼지는 얇은 충격파 고리. */
function shockwave(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  t: number,
): void {
  if (t < 0 || t > 0.9 || reducedMotion()) return;
  const f = t / 0.9;
  ctx.strokeStyle = `rgba(255, 240, 210, ${0.9 * (1 - f)})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(8, s * 0.9) * (0.6 + f * 2.6), 0, Math.PI * 2);
  ctx.stroke();
}

/** 점령: 내 색이 청크 가운데에서 가장자리로 번졌다가 옅어진다. */
function spread(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, t: number): void {
  if (t > 1.6) return;
  const grow = Math.min(1, t / 0.5);
  const half = (s / 2) * grow;
  ctx.fillStyle = `rgba(111, 211, 184, ${0.6 * Math.min(1, (1.6 - t) / 1.1)})`;
  ctx.fillRect(x - half, y - half, half * 2, half * 2);
}

/** 공중에서 막힘: 하늘색 방패 고리가 퍼지며 사라진다. */
function intercept(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  t: number,
): void {
  const f = Math.min(1, t / 0.8);
  ctx.strokeStyle = `rgba(150, 210, 255, ${1 - f})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y - s * 0.6, s * (0.3 + f), 0, Math.PI * 2);
  ctx.stroke();
}

/** 점령: 깃발이 올라간다. */
function flag(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, t: number): void {
  const f = Math.min(1, t / 0.6);
  ctx.globalAlpha = Math.min(1, (EFFECT_MS / 1000 - t) / 0.6);
  ctx.strokeStyle = '#1b1408';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.3);
  ctx.lineTo(x, y - s * 0.5 * f);
  ctx.stroke();
  ctx.fillStyle = '#6fd3b8';
  ctx.fillRect(x, y - s * 0.5 * f, s * 0.35, s * 0.22);
  ctx.globalAlpha = 1;
}

/** 교전 시작: 여섯 갈래 섬광. */
function clash(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, t: number): void {
  const f = Math.min(1, t / 0.7);
  ctx.strokeStyle = `rgba(255, 210, 120, ${1 - f})`;
  ctx.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * s * 0.2 * f, y + Math.sin(a) * s * 0.2 * f);
    ctx.lineTo(x + Math.cos(a) * s * 0.6 * f, y + Math.sin(a) * s * 0.6 * f);
    ctx.stroke();
  }
}
