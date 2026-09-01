import { Texture } from 'pixi.js';
import {
  ATLAS_CELL_H,
  ATLAS_CELL_W,
  ATLAS_COLUMNS,
  ATLAS_PAD,
  TILE_H,
  TILE_HH,
  TILE_HW,
  TILE_W,
  MAX_HEIGHT,
  WALL_ART,
} from '../core/constants';
import { TERRAIN_COLORS, TERRAIN_COUNT } from '../world/terrain';

export const ATLAS_URL = 'sprites/terrain.png';

/**
 * 절벽 옆면 셀. 지형 셀 뒤에 이어 붙는다.
 * left  = 왼쪽 아래를 향한 면(+ty 방향), right = 오른쪽 아래를 향한 면(+tx 방향).
 * 그림은 셀 안쪽 32x32 안의 평행사변형이다.
 */
export const WallCell = {
  SoilLeft: TERRAIN_COUNT,
  SoilRight: TERRAIN_COUNT + 1,
  RockLeft: TERRAIN_COUNT + 2,
  RockRight: TERRAIN_COUNT + 3,
} as const;

/**
 * 고도 음영 셀. 고도가 높을수록 밝게 덮는 반투명 다이아몬드다.
 * 이 셀들은 코드가 항상 자동 생성해서 아틀라스 뒤에 붙인다 — 그림 작업 대상이 아니다.
 * (나중에 영토 색, 오염 히트맵도 같은 방식으로 셀만 늘리면 된다)
 */
export const SHADE_BASE = ATLAS_COLUMNS * 2;
export const ATLAS_ART_ROWS = 2; // 사람이 그리는 행: 0=지형, 1=절벽
export const ATLAS_CELL_COUNT = SHADE_BASE + MAX_HEIGHT + 1;

/** 고도 h 에 해당하는 음영 셀. 0 이면 음영 자체가 없다. */
export function shadeCellFor(height: number): number {
  return SHADE_BASE + Math.min(MAX_HEIGHT, height);
}

export interface TileAtlas {
  texture: Texture;
  columns: number;
  /** 진짜 그림이 아직 없어서 코드로 만든 것인지 */
  placeholder: boolean;
  /** 지형 셀 index 의 UV 사각형 (u0, v0, u1, v1) — 안쪽 64x32 */
  uv(index: number): [number, number, number, number];
  /** 절벽 셀 index 의 UV 사각형 — 안쪽 32x32 */
  uvWall(index: number): [number, number, number, number];
}

/**
 * public/sprites/terrain.png 가 있으면 그걸 쓰고, 없으면 코드로 그린다.
 * GPT 가 그림을 넣기 전에도 게임이 돌아가야 하므로 폴백이 필요하다.
 */
export async function loadTileAtlas(): Promise<TileAtlas> {
  const art = await loadImage(ATLAS_URL);
  const placeholder = art === null;
  const source = art ?? buildPlaceholderCanvas();

  // 그림(지형·절벽) 뒤에 고도 음영 셀을 코드로 덧붙여 하나의 텍스처로 만든다.
  // 한 장으로 합쳐야 청크당 드로우콜이 1로 유지된다.
  const rows = Math.ceil(ATLAS_CELL_COUNT / ATLAS_COLUMNS);
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLUMNS * ATLAS_CELL_W;
  canvas.height = rows * ATLAS_CELL_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D 캔버스를 만들 수 없습니다');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0);
  drawShadeCells(ctx);

  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  texture.source.autoGenerateMipmaps = false;

  const width = texture.width;
  const height = texture.height;
  const columns = ATLAS_COLUMNS;

  return {
    texture,
    columns,
    placeholder,
    uv(index: number) {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const x = col * ATLAS_CELL_W + ATLAS_PAD;
      const y = row * ATLAS_CELL_H + ATLAS_PAD;
      return [x / width, y / height, (x + TILE_W) / width, (y + TILE_H) / height];
    },
    uvWall(index: number) {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const x = col * ATLAS_CELL_W + ATLAS_PAD;
      const y = row * ATLAS_CELL_H + ATLAS_PAD;
      return [
        x / width,
        y / height,
        (x + WALL_ART) / width,
        (y + WALL_ART) / height,
      ];
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
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** 고도 음영: 높을수록 밝다. 고도 0 은 아예 그리지 않으므로 비워 둔다. */
function drawShadeCells(ctx: CanvasRenderingContext2D): void {
  for (let h = 1; h <= MAX_HEIGHT; h++) {
    const index = SHADE_BASE + h;
    const ox = (index % ATLAS_COLUMNS) * ATLAS_CELL_W + ATLAS_PAD;
    const oy = Math.floor(index / ATLAS_COLUMNS) * ATLAS_CELL_H + ATLAS_PAD;
    ctx.save();
    diamondPath(ctx, ox, oy);
    ctx.clip();
    ctx.fillStyle = `rgba(255, 248, 224, ${(0.038 * h).toFixed(3)})`;
    ctx.fillRect(ox, oy, TILE_W, TILE_H);
    ctx.restore();
  }
}

/* ---------------------------------------------------------------- *
 * 자리표시용 타일 생성
 * ---------------------------------------------------------------- */

function buildPlaceholderCanvas(): HTMLCanvasElement {
  const columns = ATLAS_COLUMNS;
  const rows = ATLAS_ART_ROWS;
  const canvas = document.createElement('canvas');
  canvas.width = columns * ATLAS_CELL_W;
  canvas.height = rows * ATLAS_CELL_H;

  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.imageSmoothingEnabled = false;

  const cellOrigin = (i: number): { ox: number; oy: number } => ({
    ox: (i % columns) * ATLAS_CELL_W + ATLAS_PAD,
    oy: Math.floor(i / columns) * ATLAS_CELL_H + ATLAS_PAD,
  });

  for (let i = 0; i < TERRAIN_COUNT; i++) {
    const { ox, oy } = cellOrigin(i);
    drawTile(ctx, ox, oy, TERRAIN_COLORS[i] ?? '#ff00ff', i);
  }

  const walls: Array<[number, string, 'left' | 'right']> = [
    [WallCell.SoilLeft, '#6b4f35', 'left'],
    [WallCell.SoilRight, '#8a6844', 'right'],
    [WallCell.RockLeft, '#5e6066', 'left'],
    [WallCell.RockRight, '#7b7e85', 'right'],
  ];
  for (const [index, color, side] of walls) {
    const { ox, oy } = cellOrigin(index);
    drawWall(ctx, ox, oy, color, side);
  }

  return canvas;
}

/**
 * 절벽 한 칸. 평행사변형이 셀 안쪽 32x32 를 꽉 채운다.
 * left  : 윗변 (0,0)->(32,16)
 * right : 윗변 (0,16)->(32,0)
 */
function drawWall(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  color: string,
  side: 'left' | 'right',
): void {
  const w = WALL_ART;
  const h = WALL_ART / 2;
  const topLeftY = side === 'left' ? 0 : h;
  const topRightY = side === 'left' ? h : 0;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(ox, oy + topLeftY);
  ctx.lineTo(ox + w, oy + topRightY);
  ctx.lineTo(ox + w, oy + topRightY + h);
  ctx.lineTo(ox, oy + topLeftY + h);
  ctx.closePath();
  ctx.clip();

  ctx.fillStyle = color;
  ctx.fillRect(ox, oy, w, WALL_ART);

  // 지층 결. 옆면이 단색이면 절벽이 종이처럼 보인다.
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  for (let i = 0; i < w; i += 2) {
    const y = side === 'left' ? i / 2 : h - i / 2;
    ctx.fillRect(ox + i, oy + y + 10, 2, 2);
  }
  const shade = ctx.createLinearGradient(ox, oy, ox, oy + WALL_ART);
  shade.addColorStop(0, 'rgba(255,255,255,0.08)');
  shade.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = shade;
  ctx.fillRect(ox, oy, w, WALL_ART);
  ctx.restore();
}

function diamondPath(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
  ctx.beginPath();
  ctx.moveTo(ox + TILE_HW, oy);
  ctx.lineTo(ox + TILE_W, oy + TILE_HH);
  ctx.lineTo(ox + TILE_HW, oy + TILE_H);
  ctx.lineTo(ox, oy + TILE_HH);
  ctx.closePath();
}

function drawTile(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  color: string,
  seed: number,
): void {
  ctx.save();
  diamondPath(ctx, ox, oy);
  ctx.clip();

  ctx.fillStyle = color;
  ctx.fillRect(ox, oy, TILE_W, TILE_H);

  // 아래쪽을 살짝 어둡게 해서 평면이 아니라 바닥처럼 보이게 한다.
  const shade = ctx.createLinearGradient(ox, oy, ox, oy + TILE_H);
  shade.addColorStop(0, 'rgba(255,255,255,0.07)');
  shade.addColorStop(1, 'rgba(0,0,0,0.16)');
  ctx.fillStyle = shade;
  ctx.fillRect(ox, oy, TILE_W, TILE_H);

  // 결정론적인 점무늬. 매번 같은 모양이 나와야 프레임마다 흔들리지 않는다.
  let state = (seed + 1) * 2654435761;
  const rand = (): number => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state / 4294967296;
  };

  const speckles = seed === 0 || seed === 1 ? 4 : 14;
  for (let i = 0; i < speckles; i++) {
    const px = ox + Math.floor(rand() * TILE_W);
    const py = oy + Math.floor(rand() * TILE_H);
    ctx.fillStyle = rand() > 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.12)';
    ctx.fillRect(px, py, 2, 1);
  }

  ctx.restore();

  // 가장자리 한 줄 — 타일 경계가 보여야 격자 감각이 생긴다.
  ctx.save();
  diamondPath(ctx, ox + 0.5, oy + 0.5);
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}
