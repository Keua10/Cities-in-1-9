import { parseChunkKey } from '../../core/iso';
import type { PublicCity } from '../../net/publicCities';
import type { MapView } from './mapView';
import { cityColor } from './shared';

/** 대륙 지도의 바닥: 지형 그림(아는 곳만 선명) + 도시 영토·수도·이름표. */

const SEA_BG = '#122a38';

/** 안 가 본 곳에 쓰는 흐린 지도. 작게 줄였다 늘려서 흐리게 한다(오래된 아이패드에서도 됨). */
export function makeBlurred(img: HTMLImageElement): HTMLCanvasElement {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(w / 10));
  small.height = Math.max(1, Math.round(h / 10));
  const sctx = small.getContext('2d')!;
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(img, 0, 0, small.width, small.height);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(small, 0, 0, w, h);
  // 색을 죽이고 어둡게: 지형 윤곽만 어렴풋이.
  octx.globalCompositeOperation = 'saturation';
  octx.fillStyle = 'hsl(0, 0%, 50%)';
  octx.globalAlpha = 0.7;
  octx.fillRect(0, 0, w, h);
  octx.globalCompositeOperation = 'source-over';
  octx.globalAlpha = 1;
  octx.fillStyle = 'rgba(12, 20, 26, 0.55)';
  octx.fillRect(0, 0, w, h);
  return out;
}

/**
 * 바다 배경 + 지형 그림. known 이 있으면 그 청크만 선명하고 나머지는 흐린 그림.
 * known = null 이면(관리자) 전부 선명.
 */
export function paintGround(
  ctx: CanvasRenderingContext2D,
  view: MapView,
  overview: HTMLImageElement | null,
  blurred: HTMLCanvasElement | null,
  known: ReadonlySet<string> | null,
): void {
  const { s, X, Y, ox, oy, mapWidth: mw, mapHeight: mh } = view;
  ctx.fillStyle = SEA_BG;
  ctx.fillRect(0, 0, view.width, view.height);
  if (!overview) return;
  if (!known) {
    ctx.imageSmoothingEnabled = view.scale < 1.5;
    ctx.drawImage(overview, ox, oy, mw, mh);
    return;
  }
  ctx.imageSmoothingEnabled = true;
  if (blurred) ctx.drawImage(blurred, ox, oy, mw, mh);
  ctx.save();
  ctx.beginPath();
  for (const k of known) {
    const { cx, cy } = parseChunkKey(k);
    ctx.rect(X(cx) - 0.25, Y(cy) - 0.25, s + 0.5, s + 0.5);
  }
  ctx.clip();
  ctx.imageSmoothingEnabled = view.scale < 1.5;
  ctx.drawImage(overview, ox, oy, mw, mh);
  ctx.restore();
}

export interface CityPaintOptions {
  mineUid: string;
  selected: string | null;
  /** 내가 아는 청크(null = 전부). */
  known: ReadonlySet<string> | null;
  /** 지금 전쟁 상대면 영토 전체를 안다. */
  atWarWith: (uid: string) => boolean;
}

/** 이름표 하나(부대를 그린 뒤 따로 그린다). */
export interface CityLabel {
  text: string;
  x: number;
  y: number;
  online: boolean;
}

/** 도시 영토(색 칠 + 바깥 경계선), 수도 금색 테두리. 이름표 자리를 돌려준다. */
export function paintCities(
  ctx: CanvasRenderingContext2D,
  view: MapView,
  cities: readonly PublicCity[],
  o: CityPaintOptions,
): CityLabel[] {
  const { s, X, Y } = view;
  const labels: CityLabel[] = [];
  for (const c of cities) {
    // 다른 도시는 내가 아는 땅에 걸친 부분만 보인다. 전쟁 상대는 영토 전체를 안다.
    const full = !o.known || c.uid === o.mineUid || o.atWarWith(c.uid);
    const owned = new Set(full ? c.owned : c.owned.filter((k) => o.known!.has(k)));
    if (!owned.size) continue;
    const capKnown = full || owned.has(c.capital);
    ctx.fillStyle = cityColor(c.cityIndex, c.uid === o.mineUid ? 0.55 : 0.45);
    ctx.beginPath();
    for (const key of owned) {
      const { cx, cy } = parseChunkKey(key);
      ctx.rect(X(cx), Y(cy), s + 0.5, s + 0.5);
    }
    ctx.fill();
    // 바깥 경계선
    ctx.strokeStyle = cityColor(c.cityIndex, 1);
    ctx.lineWidth = c.uid === o.selected ? 2.5 : 1.5;
    ctx.beginPath();
    for (const key of owned) {
      const { cx, cy } = parseChunkKey(key);
      const x0 = X(cx);
      const y0 = Y(cy);
      if (!owned.has(`${cx},${cy - 1}`)) (ctx.moveTo(x0, y0), ctx.lineTo(x0 + s, y0));
      if (!owned.has(`${cx + 1},${cy}`)) (ctx.moveTo(x0 + s, y0), ctx.lineTo(x0 + s, y0 + s));
      if (!owned.has(`${cx},${cy + 1}`)) (ctx.moveTo(x0, y0 + s), ctx.lineTo(x0 + s, y0 + s));
      if (!owned.has(`${cx - 1},${cy}`)) (ctx.moveTo(x0, y0), ctx.lineTo(x0, y0 + s));
    }
    ctx.stroke();
    const cap = parseChunkKey(capKnown ? c.capital : [...owned][0]);
    const span = capKnown ? [2, 4, 6][c.capitalLevel - 1] : 1;
    if (capKnown) {
      ctx.strokeStyle = '#1b1408';
      ctx.lineWidth = 3;
      ctx.strokeRect(X(cap.cx), Y(cap.cy), span * s, span * s);
      ctx.strokeStyle = '#f2cf7a';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(X(cap.cx), Y(cap.cy), span * s, span * s);
    }
    if (s >= 3 || c.uid === o.selected)
      labels.push({
        text: `${c.cityName} Lv.${c.cityLevel}`,
        x: X(cap.cx) + (span * s) / 2,
        y: Y(cap.cy) - 6,
        online: c.uid === o.mineUid || c.online,
      });
  }
  return labels;
}

/**
 * 이름표: 부대 표와 겹치면 겹치지 않을 때까지 위로 올린다(최대 4줄).
 * avoid = 부대 표 자리(가운데 x·y, 반지름 r).
 */
export function paintLabels(
  ctx: CanvasRenderingContext2D,
  labels: readonly CityLabel[],
  avoid: ReadonlyArray<{ x: number; y: number; r: number }>,
): void {
  ctx.font = '600 12px system-ui, sans-serif';
  for (const l of labels) {
    const half = ctx.measureText(l.text).width / 2 + 14;
    let y = l.y;
    for (let step = 0; step < 4; step++) {
      const hit = avoid.some(
        (a) =>
          Math.abs(a.x - l.x) < half + a.r &&
          a.y + a.r * 0.75 + 14 > y - 12 &&
          a.y - a.r * 0.75 - 8 < y + 3,
      );
      if (!hit) break;
      y -= 15;
    }
    paintLabel(ctx, l.text, l.x, y, l.online);
  }
}

/** 이름표: 글자 + 왼쪽 접속 점. */
function paintLabel(
  ctx: CanvasRenderingContext2D,
  label: string,
  x: number,
  y: number,
  online: boolean,
): void {
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(10, 16, 20, 0.85)';
  ctx.strokeText(label, x, y);
  ctx.fillStyle = '#f4f1e6';
  ctx.fillText(label, x, y);
  ctx.fillStyle = online ? '#6fe08a' : '#7d8a90';
  ctx.beginPath();
  ctx.arc(x - ctx.measureText(label).width / 2 - 8, y - 4, 4, 0, Math.PI * 2);
  ctx.fill();
}
