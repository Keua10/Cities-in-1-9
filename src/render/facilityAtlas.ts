import { Texture } from 'pixi.js';
import { TILE_W } from '../core/constants';
import { FACILITY_COUNT } from '../sim/buildings';
import { FACILITY_SPECS } from '../sim/facilities';

/**
 * 시설 스프라이트 아틀라스.
 *
 * buildingAtlas.ts 의 규칙을 그대로 따른다 — 셀은 정사각형, 셀 안에서 바닥
 * 다이아몬드가 **아래쪽 절반** 을 차지하고, 스프라이트의 아래 가운데가 부지
 * 다이아몬드의 아래 꼭짓점에 맞는다.
 *
 * ---------------------------------------------------------------
 * 규격 (그림을 그릴 때 지켜야 하는 값)
 * ---------------------------------------------------------------
 *
 *   파일: public/sprites/facilities.png
 *   전체: 576 x 384        (buildings.png 와 높이가 같다)
 *
 *   밴드 span1  y   0 ~  63   셀  64x64    x: 0=소공원
 *   밴드 span2  y  64 ~ 191   셀 128x128   x: 0=소방서, 1=경찰서, 2=공원
 *   밴드 span3  y 192 ~ 383   셀 192x192   x: 0=병원,   1=학교,   2=체육시설
 *
 * 밴드 y 시작점은 buildingAtlas.ts:buildingBandY 와 완전히 같은 누적 규칙이다
 * (앞 밴드들의 셀 높이 합).
 *
 * **kind -> (밴드, 열) 매핑은 아래 상수 배열 하나로 고정한다.** span 에서 밴드를
 * 유도하고 같은 span 안에서 kind 순서로 열을 계산하는 식으로 쓰면, 나중에
 * 시설을 하나 추가할 때 기존 그림이 통째로 밀린다.
 *
 * 변형(variant)은 만들지 않는다. 시설은 같은 종류가 나란히 설 일이 거의 없어서
 * 반복감 문제가 없다. 소공원만 예외적으로 여러 채가 붙어 설 수 있지만 1x1
 * 스프라이트라 반복이 그렇게 눈에 띄지 않는다. 필요해지면 그때 소공원 밴드에만
 * 열을 늘린다(밴드가 맨 위라 아래 밴드가 안 밀린다 — 그래서 span1 을 맨 위에 뒀다).
 */

export const FACILITY_ATLAS_URL = 'sprites/facilities.png';

/** 셀 한 변. span n 이면 n x TILE_W. 64 / 128 / 192. */
export function facilityCellSize(span: number): number {
  return span * TILE_W;
}

/** span n 밴드의 y 시작점. 앞 밴드들의 셀 높이 합. */
export function facilityBandY(span: number): number {
  let y = 0;
  for (let s = 1; s < span; s++) y += facilityCellSize(s);
  return y;
}

/** kind -> 밴드 안의 열 번호. 위 표를 그대로 박아둔 값이다. 순서를 바꾸지 마라. */
export const FACILITY_ATLAS_COLUMN: readonly number[] = [
  0, // 0 소방서   span2 열0
  1, // 1 경찰서   span2 열1
  0, // 2 병원     span3 열0
  1, // 3 학교     span3 열1
  0, // 4 소공원   span1 열0
  2, // 5 공원     span2 열2
  2, // 6 체육시설 span3 열2
];

/** 각 밴드의 열 수. 가장 넓은 밴드가 아틀라스 폭을 정한다. */
function bandColumns(span: number): number {
  let n = 0;
  for (let kind = 0; kind < FACILITY_COUNT; kind++) {
    if (FACILITY_SPECS[kind].span === span) n++;
  }
  return n;
}

export const FACILITY_ATLAS_W = (() => {
  let w = 0;
  for (let span = 1; span <= 3; span++) {
    w = Math.max(w, bandColumns(span) * facilityCellSize(span));
  }
  return w;
})();
export const FACILITY_ATLAS_H = facilityBandY(3) + facilityCellSize(3);

export interface FacilityAtlas {
  texture: Texture;
  /** 진짜 그림이 아직 없어서 코드로 만든 것인지 */
  placeholder: boolean;
  /** 시설 종류의 UV 사각형. */
  uv(kind: number): [number, number, number, number];
}

export async function loadFacilityAtlas(): Promise<FacilityAtlas> {
  const art = await loadImage(FACILITY_ATLAS_URL);
  const placeholder = art === null;

  const canvas = document.createElement('canvas');
  canvas.width = FACILITY_ATLAS_W;
  canvas.height = FACILITY_ATLAS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D 캔버스를 만들 수 없습니다');
  ctx.imageSmoothingEnabled = false;

  if (art) ctx.drawImage(art, 0, 0);
  else drawPlaceholders(ctx);

  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  texture.source.autoGenerateMipmaps = false;

  const w = canvas.width;
  const h = canvas.height;

  return {
    texture,
    placeholder,
    uv(kind) {
      const span = FACILITY_SPECS[kind].span;
      const size = facilityCellSize(span);
      const x = FACILITY_ATLAS_COLUMN[kind] * size;
      const y = facilityBandY(span);
      return [x / w, y / h, (x + size) / w, (y + size) / h];
    },
  };
}

/** 파일이 없으면 null. 그림 없이도 게임이 돌아가야 한다. */
async function loadImage(url: string): Promise<HTMLImageElement | null> {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok || !(head.headers.get('content-type') ?? '').startsWith('image')) {
      return null;
    }
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(
      img.naturalWidth === FACILITY_ATLAS_W && img.naturalHeight === FACILITY_ATLAS_H ? img : null,
    );
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/* ---------------------------------------------------------------- *
 * 자리표시용 시설
 * ---------------------------------------------------------------- */

/** 지붕 / 밝은 면 / 어두운 면. 종류별 색. */
const BODY: readonly (readonly [string, string, string])[] = [
  ['#e8705f', '#c25446', '#933a30'], // 소방서   빨강
  ['#6f8fd8', '#4f6cb4', '#374d87'], // 경찰서   파랑
  ['#e8e2dc', '#c4bdb6', '#948d87'], // 병원     흰색
  ['#e0b25f', '#b98f45', '#8c6a2f'], // 학교     노랑
  ['#7fca85', '#5da466', '#3f7c4b'], // 소공원   초록
  ['#6bc07a', '#4b9c5c', '#337742'], // 공원     초록
  ['#5fbfb0', '#419a8d', '#2c766a'], // 체육시설 청록
];

/**
 * 코드로 그리는 임시 시설.
 *
 * buildingAtlas.ts 의 placeholder 경로를 그대로 복사한 이유가 같다 — 그림 파일이
 * 없어도 구현·검증이 돌아가야 한다. 복지 3종은 건물 대신 낮은 수풀로 그려서
 * 필수 시설과 한눈에 구분되게 한다.
 */
function drawPlaceholders(ctx: CanvasRenderingContext2D): void {
  for (let kind = 0; kind < FACILITY_COUNT; kind++) {
    const spec = FACILITY_SPECS[kind];
    const size = facilityCellSize(spec.span);
    const ox = FACILITY_ATLAS_COLUMN[kind] * size;
    const oy = facilityBandY(spec.span);
    // 바닥 다이아몬드는 셀 아래쪽 절반. 아래 꼭짓점이 셀 가운데 아래 끝이다.
    const groundH = size / 2;
    // 복지는 낮고 넓게, 필수 서비스는 높게. 실루엣만으로 가족이 구분된다.
    const body = groundH * (spec.welfare ? 0.3 : 0.7);
    drawFacility(ctx, ox, oy, size, groundH, body, BODY[kind], spec.welfare);
  }
}

function drawFacility(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  size: number,
  groundH: number,
  body: number,
  colors: readonly [string, string, string],
  welfare: boolean,
): void {
  const cxm = ox + size / 2;
  const bottomY = oy + size;
  const midY = bottomY - groundH / 2;
  const topY = bottomY - groundH;
  const left = ox;
  const right = ox + size;

  const inset = size <= 64 ? 4 : 6;
  const k = 1 - (inset * 2) / size;
  const dx = (size / 2) * k;
  const dy = (groundH / 2) * k;
  const roofY = midY - body;

  // 부지 바닥. 복지는 잔디, 필수 서비스는 포장이다.
  ctx.fillStyle = welfare ? 'rgba(88,150,92,0.85)' : 'rgba(104,110,116,0.85)';
  ctx.beginPath();
  ctx.moveTo(cxm, topY + 1);
  ctx.lineTo(right - 1, midY);
  ctx.lineTo(cxm, bottomY - 1);
  ctx.lineTo(left + 1, midY);
  ctx.closePath();
  ctx.fill();

  // 오른쪽 면
  ctx.fillStyle = colors[1];
  ctx.beginPath();
  ctx.moveTo(cxm, midY + dy);
  ctx.lineTo(cxm + dx, midY);
  ctx.lineTo(cxm + dx, midY - body);
  ctx.lineTo(cxm, midY + dy - body);
  ctx.closePath();
  ctx.fill();

  // 왼쪽 면
  ctx.fillStyle = colors[2];
  ctx.beginPath();
  ctx.moveTo(cxm, midY + dy);
  ctx.lineTo(cxm - dx, midY);
  ctx.lineTo(cxm - dx, midY - body);
  ctx.lineTo(cxm, midY + dy - body);
  ctx.closePath();
  ctx.fill();

  // 지붕
  ctx.fillStyle = colors[0];
  ctx.beginPath();
  ctx.moveTo(cxm, roofY - dy);
  ctx.lineTo(cxm + dx, roofY);
  ctx.lineTo(cxm, roofY + dy);
  ctx.lineTo(cxm - dx, roofY);
  ctx.closePath();
  ctx.fill();

  if (welfare) {
    // 나무 몇 그루. 공원이 건물로 보이면 안 된다.
    ctx.fillStyle = 'rgba(38,92,48,0.85)';
    const trunk = Math.max(2, size * 0.03);
    for (const [tx, ty] of [
      [-0.35, 0.1],
      [0.3, -0.05],
      [0.05, 0.3],
    ] as const) {
      const px = cxm + dx * tx;
      const py = midY + dy * ty;
      ctx.beginPath();
      ctx.ellipse(px, py - body - trunk * 2, trunk * 2.2, trunk * 1.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // 창문 줄. 공공건물답게 규칙적으로 둔다.
    ctx.fillStyle = 'rgba(20,26,32,0.42)';
    const floors = size >= 192 ? 4 : 2;
    for (let f = 0; f < floors; f++) {
      const t = (f + 0.6) / (floors + 0.2);
      const y = midY - body * t;
      const w = Math.max(2, dx * 0.5);
      ctx.fillRect(cxm + dx * 0.25, y - Math.max(1, body * 0.06), w * 0.6, Math.max(2, body * 0.09));
      ctx.fillRect(cxm - dx * 0.25 - w * 0.6, y - Math.max(1, body * 0.06), w * 0.6, Math.max(2, body * 0.09));
    }
  }

  // 바닥 그림자. 시설이 땅에 붙어 보이게 한다.
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.moveTo(cxm, topY + 1);
  ctx.lineTo(right - 1, midY);
  ctx.lineTo(cxm, bottomY - 1);
  ctx.lineTo(left + 1, midY);
  ctx.closePath();
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}
