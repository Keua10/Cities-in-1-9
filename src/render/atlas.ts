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
import { Terrain, TERRAIN_COLORS, TERRAIN_COUNT } from '../world/terrain';

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
export const SHADE_CELL_COUNT = MAX_HEIGHT + 1;

/**
 * 2단계 셀. 도로·지구도 고도 음영과 똑같이 **코드가 그린다.**
 * terrain.png 가 아직 보류 상태라 그림을 기다리다 2단계가 멈추면 안 된다.
 *
 * 셀 번호는 저장되지 않는다(연결 마스크는 이웃에서 매번 계산한다). 나중에 진짜
 * 그림으로 교체하거나 순서를 바꿔도 이미 저장된 도시는 안 깨진다.
 *
 *    0 ~  7  지형      (사람이 그림, 행 0)
 *    8 ~ 11  절벽      (사람이 그림, 행 1)
 *   16 ~ 24  고도 음영 (코드)
 *   25 ~ 40  도로 16칸 (코드) — 연결 마스크 0~15 가 그대로 셀 번호
 *   41 ~ 46  지구 6칸  (코드) — (주거·상업·공업) x (도로 미접함·접함)
 */
export const ROAD_CELL_BASE = SHADE_BASE + SHADE_CELL_COUNT;
export const ROAD_CELL_COUNT = 16;
export const ZONE_CELL_BASE = ROAD_CELL_BASE + ROAD_CELL_COUNT;
export const ZONE_CELL_COUNT = 6;
export const ATLAS_CELL_COUNT = ZONE_CELL_BASE + ZONE_CELL_COUNT;

/** 고도 h 에 해당하는 음영 셀. 0 이면 음영 자체가 없다. */
export function shadeCellFor(height: number): number {
  return SHADE_BASE + Math.min(MAX_HEIGHT, height);
}

/** 지구 셀. zone 은 0=주거, 1=상업, 2=공업. */
export function zoneCell(zone: number, hasRoad: boolean): number {
  return ZONE_CELL_BASE + zone * 2 + (hasRoad ? 1 : 0);
}

/** 지구 색. HUD 범례도 같은 값을 쓴다. */
export const ZONE_COLORS: readonly string[] = ['#3f8f4f', '#2f6fa8', '#a8862f'];
export const ZONE_LABELS: readonly string[] = ['주거', '상업', '공업'];

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
  drawIsometricTerrainDetails(ctx);
  drawShadeCells(ctx);
  drawRoadCells(ctx);
  drawZoneCells(ctx);

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

/** 셀 index 의 그림 영역 왼쪽 위 좌표. */
function cellOrigin(index: number): { ox: number; oy: number } {
  return {
    ox: (index % ATLAS_COLUMNS) * ATLAS_CELL_W + ATLAS_PAD,
    oy: Math.floor(index / ATLAS_COLUMNS) * ATLAS_CELL_H + ATLAS_PAD,
  };
}

/**
 * 2:1 아이소메트릭 표면 결.
 *
 * 화면 축 기준 정사각형 픽셀 블록을 반복하면 타일이 체크무늬처럼 보인다.
 * 이 함수는 원본 지형색과 다이아몬드 외곽을 그대로 두고, 가로 2px : 세로 1px인
 * 두 아이소 축을 따라가는 짧고 낮은 대비의 결만 더한다.
 */
function drawIsometricTerrainDetails(ctx: CanvasRenderingContext2D): void {
  for (let terrain = 0; terrain < TERRAIN_COUNT; terrain++) {
    const { ox, oy } = cellOrigin(terrain);
    ctx.save();
    diamondPath(ctx, ox, oy);
    ctx.clip();

    switch (terrain) {
      case Terrain.WaterDeep:
        drawIsoSegment(ctx, ox + 18, oy + 9, 6, 1, 'rgba(190,232,239,0.20)');
        drawIsoSegment(ctx, ox + 46, oy + 18, 5, -1, 'rgba(18,80,105,0.22)');
        break;
      case Terrain.WaterShallow:
        drawIsoSegment(ctx, ox + 20, oy + 10, 5, 1, 'rgba(229,247,236,0.24)');
        drawIsoSegment(ctx, ox + 48, oy + 19, 4, -1, 'rgba(35,111,125,0.20)');
        break;
      case Terrain.Sand:
        drawIsoDiamond(ctx, ox + 22, oy + 12, 'rgba(255,240,183,0.34)');
        drawIsoDiamond(ctx, ox + 43, oy + 19, 'rgba(142,112,64,0.22)');
        break;
      case Terrain.Grass:
        drawIsoTuft(ctx, ox + 24, oy + 15, 'rgba(51,112,56,0.28)');
        drawIsoSegment(ctx, ox + 38, oy + 20, 3, 1, 'rgba(190,211,102,0.18)');
        break;
      case Terrain.GrassDry:
        drawIsoTuft(ctx, ox + 23, oy + 14, 'rgba(111,119,47,0.25)');
        drawIsoSegment(ctx, ox + 43, oy + 20, 3, -1, 'rgba(231,218,119,0.20)');
        break;
      case Terrain.Dirt:
        drawIsoSegment(ctx, ox + 20, oy + 12, 4, 1, 'rgba(91,62,39,0.24)');
        drawIsoDiamond(ctx, ox + 43, oy + 20, 'rgba(224,187,126,0.20)');
        break;
      case Terrain.Rock:
        drawIsoSegment(ctx, ox + 20, oy + 11, 5, 1, 'rgba(213,211,196,0.24)');
        drawIsoSegment(ctx, ox + 44, oy + 15, 4, -1, 'rgba(61,67,69,0.28)');
        drawIsoSegment(ctx, ox + 34, oy + 21, 3, 1, 'rgba(61,67,69,0.20)');
        break;
      case Terrain.Forest:
        // 넓게 반복되는 기본 지형이라 한 타일에 작은 수관 결 두 개만 둔다.
        drawIsoTuft(ctx, ox + 23, oy + 14, 'rgba(31,91,47,0.22)');
        drawIsoTuft(ctx, ox + 43, oy + 20, 'rgba(143,181,83,0.16)');
        break;
    }

    ctx.restore();
  }
}

/** direction 1 = 오른쪽 아래, -1 = 왼쪽 아래. 한 스텝은 정확히 2:1이다. */
function drawIsoSegment(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  steps: number,
  direction: 1 | -1,
  color: string,
): void {
  ctx.fillStyle = color;
  for (let step = 0; step < steps; step++) {
    ctx.fillRect(x + direction * step * 2, y + step, 2, 1);
  }
}

/** 2:1 투영을 따르는 6x3 크기의 작은 지면 점. */
function drawIsoDiamond(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(cx - 1, cy - 1, 2, 1);
  ctx.fillRect(cx - 3, cy, 6, 1);
  ctx.fillRect(cx - 1, cy + 1, 2, 1);
}

/** 정사각형 십자 대신 두 아이소 축으로 벌어지는 V자형 풀잎. */
function drawIsoTuft(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(cx, cy - 2, 2, 1);
  ctx.fillRect(cx - 2, cy - 1, 2, 1);
  ctx.fillRect(cx + 2, cy - 1, 2, 1);
  ctx.fillRect(cx, cy, 2, 1);
}

/**
 * 다이아몬드 꼭짓점과 변의 중점.
 *
 *        T(32,0)
 *   L(0,16)   R(64,16)
 *        B(32,32)
 *
 * 방향 d 의 변과 중점(= 이웃 타일과 맞닿는 지점):
 *   0 (+tx, 오른쪽 아래) R->B, 중점 (48,24)
 *   1 (+ty, 왼쪽 아래)   B->L, 중점 (16,24)
 *   2 (-tx, 왼쪽 위)     L->T, 중점 (16,8)
 *   3 (-ty, 오른쪽 위)   T->R, 중점 (48,8)
 */
const EDGE_MID: ReadonlyArray<readonly [number, number]> = [
  [TILE_HW + TILE_W / 4, TILE_HH + TILE_H / 4],
  [TILE_W / 4, TILE_HH + TILE_H / 4],
  [TILE_W / 4, TILE_H / 4],
  [TILE_HW + TILE_W / 4, TILE_H / 4],
];

const EDGE_LINE: ReadonlyArray<readonly [number, number, number, number]> = [
  [TILE_W, TILE_HH, TILE_HW, TILE_H],
  [TILE_HW, TILE_H, 0, TILE_HH],
  [0, TILE_HH, TILE_HW, 0],
  [TILE_HW, 0, TILE_W, TILE_HH],
];

/**
 * 도로 16칸. 셀 번호의 아래 4비트가 곧 연결 마스크다.
 *
 * 진짜 그림이 들어오기 전까지 쓰는 코드 생성 타일이지만, 연결 모양이 눈에
 * 보여야 2단계를 검증할 수 있으므로 대충 그리지 않는다.
 */
function drawRoadCells(ctx: CanvasRenderingContext2D): void {
  for (let mask = 0; mask < ROAD_CELL_COUNT; mask++) {
    const { ox, oy } = cellOrigin(ROAD_CELL_BASE + mask);

    ctx.save();
    diamondPath(ctx, ox, oy);
    ctx.clip();

    // 노면
    ctx.fillStyle = '#3b4046';
    ctx.fillRect(ox, oy, TILE_W, TILE_H);
    const shade = ctx.createLinearGradient(ox, oy, ox, oy + TILE_H);
    shade.addColorStop(0, 'rgba(255,255,255,0.06)');
    shade.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = shade;
    ctx.fillRect(ox, oy, TILE_W, TILE_H);

    // 연결되지 않은 변에는 연석을 그린다. 도로가 어디서 끊겼는지 바로 보인다.
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#8d9199';
    for (let d = 0; d < 4; d++) {
      if (mask & (1 << d)) continue;
      const e = EDGE_LINE[d];
      ctx.beginPath();
      ctx.moveTo(ox + e[0], oy + e[1]);
      ctx.lineTo(ox + e[2], oy + e[3]);
      ctx.stroke();
    }

    if (mask === 0) {
      // 외톨이 도로. 가운데에 점만 찍는다.
      ctx.fillStyle = 'rgba(226,214,140,0.7)';
      ctx.fillRect(ox + TILE_HW - 2, oy + TILE_HH - 1, 4, 2);
    } else {
      // 중앙선. 연결된 방향으로만 뻗는다.
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(226,214,140,0.75)';
      ctx.setLineDash([4, 3]);
      for (let d = 0; d < 4; d++) {
        if (!(mask & (1 << d))) continue;
        const m = EDGE_MID[d];
        ctx.beginPath();
        ctx.moveTo(ox + TILE_HW, oy + TILE_HH);
        ctx.lineTo(ox + m[0], oy + m[1]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    ctx.restore();
  }
}

/**
 * 지구 6칸. (주거·상업·공업) x (도로 미접함·접함).
 *
 * 도로에 접하지 않은 지구는 어둡게 그린다. 3단계에서 "도로에 접한 지구만 개발"
 * 규칙이 붙을 자리라, 학생이 지금부터 그 차이를 눈으로 알 수 있어야 한다.
 */
function drawZoneCells(ctx: CanvasRenderingContext2D): void {
  for (let zone = 0; zone < ZONE_COLORS.length; zone++) {
    for (let r = 0; r < 2; r++) {
      const hasRoad = r === 1;
      const { ox, oy } = cellOrigin(zoneCell(zone, hasRoad));

      ctx.save();
      diamondPath(ctx, ox, oy);
      ctx.clip();

      ctx.fillStyle = ZONE_COLORS[zone];
      ctx.fillRect(ox, oy, TILE_W, TILE_H);

      if (!hasRoad) {
        // 아직 못 짓는 땅. 회색을 덮어 채도를 떨어뜨린다.
        ctx.fillStyle = 'rgba(24,28,32,0.5)';
        ctx.fillRect(ox, oy, TILE_W, TILE_H);
      }

      const shade = ctx.createLinearGradient(ox, oy, ox, oy + TILE_H);
      shade.addColorStop(0, 'rgba(255,255,255,0.10)');
      shade.addColorStop(1, 'rgba(0,0,0,0.20)');
      ctx.fillStyle = shade;
      ctx.fillRect(ox, oy, TILE_W, TILE_H);

      // 안쪽 점선 테두리 — 지구는 "구획" 이라는 신호
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = hasRoad ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.32)';
      ctx.beginPath();
      ctx.moveTo(ox + TILE_HW, oy + 5);
      ctx.lineTo(ox + TILE_W - 10, oy + TILE_HH);
      ctx.lineTo(ox + TILE_HW, oy + TILE_H - 5);
      ctx.lineTo(ox + 10, oy + TILE_HH);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.restore();
    }
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
