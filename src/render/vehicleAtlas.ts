import { Texture } from 'pixi.js';
import { TILE_HH, TILE_HW } from '../core/constants';
import { VEHICLE_BODY_LENGTH_TILES, VEHICLE_WIDTH_TILES } from '../sim/simConstants';

export const VEHICLE_ATLAS_URL = 'sprites/vehicles.png';
export const VEHICLE_CELL = 32;
/**
 * 차량 색/모양 변형 수.
 *
 * 색은 반드시 variant 로만 정해야 한다. 예전에는 팔레트를 방향(dir)으로 골라서
 * 차가 회전할 때마다 색이 바뀌었다. 한 대의 차는 목적지 해시로 variant 를
 * 한 번 정하고 도착할 때까지 유지하므로, 색이 여기에만 묶여 있어야 한다.
 */
export const VEHICLE_VARIANTS = 4;
export const VEHICLE_ATLAS_W = 512; // 16칸 = 방향 4 x 변형 4
export const VEHICLE_ATLAS_H = 64; // 2줄 = 승용차 / 트럭
/**
 * 셀 중심에서 아래로 이만큼 내려간 점이 차량의 접지점이다.
 * 차체가 위로 솟기 때문에 셀 정중앙을 접지점으로 쓰면 지붕이 잘린다.
 * 렌더러(vehicleMesh)는 이 값만큼 사각형을 위로 올려 붙인다.
 */
export const VEHICLE_GROUND_DROP_PX = 5;

export interface VehicleAtlas {
  texture: Texture;
  placeholder: boolean;
  uv(kind: number, dir: number, variant: number): [number, number, number, number];
}

export async function loadVehicleAtlas(): Promise<VehicleAtlas> {
  const art = await loadImage(VEHICLE_ATLAS_URL);
  const canvas = document.createElement('canvas');
  canvas.width = VEHICLE_ATLAS_W;
  canvas.height = VEHICLE_ATLAS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D 캔버스를 만들 수 없습니다');
  ctx.imageSmoothingEnabled = false;
  if (art) ctx.drawImage(art, 0, 0);
  else drawPlaceholder(ctx);

  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  texture.source.autoGenerateMipmaps = false;
  return {
    texture,
    placeholder: !art,
    uv(kind, dir, variant) {
      const x = (((dir & 3) * VEHICLE_VARIANTS) + (variant % VEHICLE_VARIANTS)) * VEHICLE_CELL;
      const y = (kind & 1) * VEHICLE_CELL;
      return [
        x / VEHICLE_ATLAS_W,
        y / VEHICLE_ATLAS_H,
        (x + VEHICLE_CELL) / VEHICLE_ATLAS_W,
        (y + VEHICLE_CELL) / VEHICLE_ATLAS_H,
      ];
    },
  };
}

async function loadImage(url: string): Promise<HTMLImageElement | null> {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok || !(head.headers.get('content-type') ?? '').startsWith('image')) return null;
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/* ------------------------------------------------------------------ */
/* fallback 차량 그림                                                   */
/* ------------------------------------------------------------------ */

/**
 * sprites/vehicles.png 가 없을 때 쓰는 임시 차량.
 *
 * 예전 fallback 은 네 방향 모두 같은 모양의 화면축 정렬 사각형이었고 색만 달랐다.
 * 그래서 차가 어느 쪽으로 가는지 화면에서 읽을 수 없었고, "우측통행이 되는지"
 * 자체를 눈으로 확인할 수 없었다. 차선 계산을 아무리 고쳐도 확인이 안 되니
 * 같은 수정을 반복하게 된다.
 *
 * 지금은 타일 평면의 두 축(진행방향 F, 그 오른쪽 R)으로 실제 아이소메트릭
 * 상자를 그린다. 크기도 시뮬레이션이 쓰는 차체 길이/폭 상수를 그대로 투영하므로
 * 화면에 보이는 차체와 충돌 판정에 쓰는 차체가 같다.
 */
export function drawPlaceholder(ctx: CanvasRenderingContext2D): void {
  const palettes: ReadonlyArray<{ body: string; roof: string; dark: string; glass: string }> = [
    { body: '#4f83c4', roof: '#6fa2df', dark: '#24384f', glass: '#cfe3f5' },
    { body: '#c9743f', roof: '#e19359', dark: '#4a2c19', glass: '#f2ddc4' },
    { body: '#5c9a58', roof: '#7cb877', dark: '#25391f', glass: '#d8ead4' },
    { body: '#b8b3ac', roof: '#d6d2cb', dark: '#3b3833', glass: '#eef1f4' },
  ];

  for (let kind = 0; kind < 2; kind++) {
    const truck = kind === 1;
    const length = truck ? VEHICLE_BODY_LENGTH_TILES * 1.22 : VEHICLE_BODY_LENGTH_TILES;
    const width = truck ? VEHICLE_WIDTH_TILES * 1.06 : VEHICLE_WIDTH_TILES;
    const bodyHeight = truck ? 9 : 7;
    for (let dir = 0; dir < 4; dir++) {
      for (let variant = 0; variant < VEHICLE_VARIANTS; variant++) {
        const ox = (dir * VEHICLE_VARIANTS + variant) * VEHICLE_CELL;
        const oy = kind * VEHICLE_CELL;
        // 방향은 팔레트에 영향을 주지 않는다. 같은 차가 돌아도 색이 그대로여야 한다.
        const palette = palettes[variant % palettes.length];
        drawCar(ctx, ox, oy, dir, length, width, bodyHeight, palette, truck);
      }
    }
  }
}

interface Palette {
  body: string;
  roof: string;
  dark: string;
  glass: string;
}

/** 타일 방향 인덱스 -> 화면 벡터(타일 1칸 이동량). iso.ts 와 같은 정의다. */
function screenAxis(dir: number): [number, number] {
  switch (dir & 3) {
    case 0: return [TILE_HW, TILE_HH]; // +tx 오른쪽아래
    case 1: return [-TILE_HW, TILE_HH]; // +ty 왼쪽아래
    case 2: return [-TILE_HW, -TILE_HH]; // -tx 왼쪽위
    default: return [TILE_HW, -TILE_HH]; // -ty 오른쪽위
  }
}

function drawCar(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  dir: number,
  lengthTiles: number,
  widthTiles: number,
  bodyHeight: number,
  palette: Palette,
  truck: boolean,
): void {
  const cx = ox + VEHICLE_CELL / 2;
  const cy = oy + VEHICLE_CELL / 2 + VEHICLE_GROUND_DROP_PX;
  // 셀 밖으로 넘치면 위/아래 칸의 그림이 섞인다(트럭 지붕이 승용차 칸에 찍히는 문제).
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, VEHICLE_CELL, VEHICLE_CELL);
  ctx.clip();
  const [fx, fy] = screenAxis(dir); // 진행방향
  const [rx, ry] = screenAxis(dir + 1); // 진행방향의 오른쪽 (laneGeometry 와 같은 규칙)
  const hl = lengthTiles / 2;
  const hw = widthTiles / 2;

  /** 접지 중심을 원점으로, (진행방향 거리, 오른쪽 거리, 높이) -> 셀 안의 픽셀. */
  const point = (alongF: number, alongR: number, lift: number): [number, number] => [
    cx + fx * alongF + rx * alongR,
    cy + fy * alongF + ry * alongR - lift,
  ];

  /** 타일 평면에 놓인 직육면체 한 덩어리. 보이는 옆면과 윗면만 그린다. */
  const box = (
    from: number,
    to: number,
    widthScale: number,
    base: number,
    height: number,
    color: string,
  ): void => {
    const w = hw * widthScale;
    const top = base + height;
    const faces: Array<{ p: Array<[number, number]>; nx: number; ny: number }> = [
      { p: [point(to, -w, base), point(to, w, base), point(to, w, top), point(to, -w, top)], nx: fx, ny: fy },
      { p: [point(from, w, base), point(to, w, base), point(to, w, top), point(from, w, top)], nx: rx, ny: ry },
      { p: [point(from, w, base), point(from, -w, base), point(from, -w, top), point(from, w, top)], nx: -fx, ny: -fy },
      { p: [point(from, -w, base), point(to, -w, base), point(to, -w, top), point(from, -w, top)], nx: -rx, ny: -ry },
    ];
    for (const face of faces) {
      if (face.ny <= 0) continue; // 화면 뒤쪽을 향한 면은 차체에 가려진다
      const norm = Math.hypot(face.nx, face.ny) || 1;
      ctx.fillStyle = shade(color, 0.58 + 0.34 * (face.nx / norm));
      fillPoly(ctx, face.p);
    }
    ctx.fillStyle = shade(color, 1.12);
    fillPoly(ctx, [
      point(to, w, top), point(to, -w, top), point(from, -w, top), point(from, w, top),
    ]);
  };

  // 접지 그림자
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  fillPoly(ctx, [
    point(hl, hw, 0), point(hl, -hw, 0), point(-hl, -hw, 0), point(-hl, hw, 0),
  ]);

  const chassis = truck ? bodyHeight * 0.45 : bodyHeight * 0.5;
  box(-hl, hl, 1, 0, chassis, palette.dark); // 하부(바퀴/섀시)

  if (truck) {
    box(hl * 0.28, hl * 0.99, 0.96, chassis, bodyHeight * 0.75, palette.body); // 운전석
    box(-hl * 0.99, hl * 0.18, 1, chassis, bodyHeight, palette.roof); // 적재함
    ctx.fillStyle = palette.glass;
    fillPoly(ctx, [
      point(hl * 0.99, hw * 0.8, chassis + bodyHeight * 0.62),
      point(hl * 0.99, -hw * 0.8, chassis + bodyHeight * 0.62),
      point(hl * 0.99, -hw * 0.8, chassis + bodyHeight * 0.3),
      point(hl * 0.99, hw * 0.8, chassis + bodyHeight * 0.3),
    ]);
  } else {
    box(-hl, hl, 0.98, chassis, bodyHeight * 0.45, palette.body); // 차체
    const cabinBase = chassis + bodyHeight * 0.45;
    box(-hl * 0.62, hl * 0.42, 0.82, cabinBase, bodyHeight * 0.5, palette.roof); // 캐빈
    // 앞유리. 진행방향 쪽 캐빈 앞면이라 어느 쪽이 앞인지 바로 읽힌다.
    ctx.fillStyle = palette.glass;
    fillPoly(ctx, [
      point(hl * 0.42, hw * 0.82, cabinBase + bodyHeight * 0.46),
      point(hl * 0.42, -hw * 0.82, cabinBase + bodyHeight * 0.46),
      point(hl * 0.42, -hw * 0.82, cabinBase + bodyHeight * 0.08),
      point(hl * 0.42, hw * 0.82, cabinBase + bodyHeight * 0.08),
    ]);
  }

  // 전조등(앞) / 후미등(뒤). 스프라이트만 보고도 진행방향을 알 수 있어야 한다.
  ctx.fillStyle = '#fff6c8';
  dot(ctx, point(hl * 0.99, hw * 0.62, chassis * 0.9));
  dot(ctx, point(hl * 0.99, -hw * 0.62, chassis * 0.9));
  ctx.fillStyle = '#e04a3e';
  dot(ctx, point(-hl * 0.99, hw * 0.62, chassis * 0.9));
  dot(ctx, point(-hl * 0.99, -hw * 0.62, chassis * 0.9));

  ctx.restore();
}

function fillPoly(ctx: CanvasRenderingContext2D, pts: ReadonlyArray<[number, number]>): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
}

function dot(ctx: CanvasRenderingContext2D, p: [number, number]): void {
  ctx.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 1, 2, 2);
}

/** #rrggbb 를 밝기 배율만큼 조정한다. */
function shade(hex: string, factor: number): string {
  const value = parseInt(hex.slice(1), 16);
  const r = clamp255(((value >> 16) & 255) * factor);
  const g = clamp255(((value >> 8) & 255) * factor);
  const b = clamp255((value & 255) * factor);
  return `rgb(${r},${g},${b})`;
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}
