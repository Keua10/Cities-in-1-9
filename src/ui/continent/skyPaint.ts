import { parseChunkKey } from '../../core/iso';
import { isNight, weatherAt, WEATHER_REGION, type Weather } from '../../sim/military/weather';
import { CONTINENT_X0, CONTINENT_Y0 } from '../../world/continent';
import type { MapView } from './mapView';

/** 이보다 가까이(청크 px) 보면 비·눈·바람 입자를, 멀리서는 지역마다 아이콘만. */
const PARTICLE_MIN_S = 12;
const WEATHER_ICON: Record<Exclude<Weather, 'clear'>, string> = {
  rain: '🌧',
  snow: '❄',
  wind: '💨',
};

/**
 * 밤·날씨: 밤이면 지도 전체를 어둡게, 날씨 지역(16×16청크)마다 비·눈·바람을 흘린다.
 * 날씨는 내가 아는 땅 위에서만 보인다(모르는 곳의 하늘은 모른다). 화면에 보이는 지역만.
 * 입자를 그렸으면 true(계속 움직이므로).
 */
export function paintSky(
  ctx: CanvasRenderingContext2D,
  view: MapView,
  known: ReadonlySet<string> | null,
  now: number,
): boolean {
  const wall = Date.now();
  const { s, X, Y, ox, oy } = view;
  const cw = view.width;
  const ch = view.height;
  if (isNight(wall)) {
    ctx.fillStyle = 'rgba(10, 18, 48, 0.32)';
    ctx.fillRect(0, 0, cw, ch);
  }
  const R = WEATHER_REGION;
  /** 지역 안에서 아는 청크들(known = null 이면 지역 전체). */
  const knownIn = (rx: number, ry: number): Array<{ cx: number; cy: number }> | null => {
    if (!known) return null;
    const out: Array<{ cx: number; cy: number }> = [];
    for (const k of known) {
      const c = parseChunkKey(k);
      if (c.cx >= rx && c.cx < rx + R && c.cy >= ry && c.cy < ry + R) out.push(c);
    }
    return out;
  };
  const rx0 = Math.floor((CONTINENT_X0 - ox / s) / R) * R;
  const ry0 = Math.floor((CONTINENT_Y0 - oy / s) / R) * R;
  const cx1 = CONTINENT_X0 + (cw - ox) / s;
  const cy1 = CONTINENT_Y0 + (ch - oy) / s;
  let any = false;
  const t = now / 1000;
  for (let ry = ry0; ry < cy1; ry += R)
    for (let rx = rx0; rx < cx1; rx += R) {
      const w = weatherAt(wall, rx, ry);
      if (w === 'clear') continue;
      const cells = knownIn(rx, ry);
      if (cells && !cells.length) continue;
      const x0 = X(rx);
      const y0 = Y(ry);
      const size = R * s;
      ctx.save();
      ctx.beginPath();
      if (cells) for (const c of cells) ctx.rect(X(c.cx), Y(c.cy), s, s);
      else ctx.rect(x0, y0, size, size);
      ctx.clip();
      ctx.fillStyle = w === 'snow' ? 'rgba(220,230,240,0.06)' : 'rgba(40,60,80,0.07)';
      ctx.fillRect(x0, y0, size, size);
      if (s < PARTICLE_MIN_S) {
        ctx.restore();
        ctx.font = `${Math.max(10, Math.min(16, size * 0.3))}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.globalAlpha = 0.7;
        ctx.fillText(WEATHER_ICON[w], x0 + size / 2, y0 + size / 2);
        ctx.globalAlpha = 1;
        continue;
      }
      any = true;
      particles(ctx, w, x0, y0, size, t);
      ctx.restore();
    }
  return any;
}

/** 입자마다 고정 위치에서 시간에 따라 흘러간다(난수 대신 i 로). */
function particles(
  ctx: CanvasRenderingContext2D,
  w: Exclude<Weather, 'clear'>,
  x0: number,
  y0: number,
  size: number,
  t: number,
): void {
  const n = Math.min(40, Math.max(8, Math.round(size / 14)));
  for (let i = 0; i < n; i++) {
    const fx = ((i * 0.6180339) % 1) * size;
    const fy = ((i * 0.4142135) % 1) * size;
    if (w === 'rain') {
      const y = y0 + ((fy + t * 220) % size);
      const x = x0 + ((fx + t * 40) % size);
      ctx.strokeStyle = 'rgba(170, 200, 230, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 3, y + 9);
      ctx.stroke();
    } else if (w === 'snow') {
      const y = y0 + ((fy + t * 30) % size);
      const x = x0 + ((fx + Math.sin(t + i) * 8 + size) % size);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(x, y, 2, 2);
    } else {
      const x = x0 + ((fx + t * 160) % size);
      const y = y0 + fy + Math.sin(t * 2 + i) * 3;
      ctx.strokeStyle = 'rgba(230, 240, 245, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + 8, y - 3, x + 16, y);
      ctx.stroke();
    }
  }
}
