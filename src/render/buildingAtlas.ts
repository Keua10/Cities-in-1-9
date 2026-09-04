import { Texture } from 'pixi.js';
import { TILE_W } from '../core/constants';
import { LEVEL_COUNT, ZONE_COUNT } from '../sim/buildings';

/**
 * 건물 스프라이트 아틀라스.
 *
 * 지형 아틀라스와 **따로** 둔다. 지형은 타일 윗면(64x32) 한 장으로 끝나지만
 * 건물은 위로 솟아 있어 셀 크기가 레벨마다 다르고, 한 텍스처에 억지로 욱여넣으면
 * 셀 규격이 지저분해진다. 텍스처가 하나 늘어 청크당 드로우콜이 1 -> 2 가 되지만,
 * 건물이 몇 채든 청크당 2로 고정이므로 성능 예산 안에 있다.
 *
 * ---------------------------------------------------------------
 * 규격 (ChatGPT 가 그림을 그릴 때 지켜야 하는 값)
 * ---------------------------------------------------------------
 *
 *   파일: public/sprites/buildings.png
 *   전체: 1152 x 384
 *
 *   레벨 n 건물은 n x n 타일을 차지한다. 셀 크기는 (64n) x (64n).
 *     레벨 1   64 x  64
 *     레벨 2  128 x 128
 *     레벨 3  192 x 192
 *
 *   셀 안에서 바닥 다이아몬드는 **아래쪽 절반** 을 차지한다.
 *   즉 셀 높이 64n 중 아래 32n 이 지면이고, 위 32n 이 건물 몸통이 올라갈 자리다.
 *   지면 다이아몬드의 아래 꼭짓점 = 셀의 가운데 아래 끝.
 *
 *   행(밴드) 배치 — y 좌표
 *     y   0 ~  63   레벨 1 밴드 (셀 6개, 각 64 폭)
 *     y  64 ~ 191   레벨 2 밴드 (셀 6개, 각 128 폭)
 *     y 192 ~ 383   레벨 3 밴드 (셀 6개, 각 192 폭)
 *
 *   밴드 안의 셀 순서 — x 방향
 *     0,1  주거 (변형 2종)
 *     2,3  상업 (변형 2종)
 *     4,5  공업 (변형 2종)
 *
 *   변형 2종은 같은 등급·용도의 건물이 나란히 섰을 때 반복감을 줄이기 위한
 *   것이다. 방향(회전) 변형은 만들지 않는다 — 카메라 회전이 없으므로 필요 없고,
 *   넣으면 그림 수가 4배가 된다.
 *
 * 셀 번호와 배치는 **저장되지 않는다.** 나중에 변형을 3종으로 늘리거나 그림을
 * 통째로 갈아도 이미 저장된 도시는 안 깨진다.
 */

export const BUILDING_ATLAS_URL = 'sprites/buildings.png';

/** 같은 용도·등급 안의 그림 변형 수. */
export const BUILDING_VARIANTS = 2;

/** 레벨 n 셀의 한 변. 정사각형이다. */
export function buildingCellSize(level: number): number {
  return level * TILE_W; // 64 / 128 / 192
}

/** 레벨 n 밴드의 y 시작점. */
export function buildingBandY(level: number): number {
  let y = 0;
  for (let l = 1; l < level; l++) y += buildingCellSize(l);
  return y;
}

export const BUILDING_ATLAS_W = buildingCellSize(LEVEL_COUNT) * ZONE_COUNT * BUILDING_VARIANTS;
export const BUILDING_ATLAS_H =
  buildingBandY(LEVEL_COUNT) + buildingCellSize(LEVEL_COUNT);

export interface BuildingAtlas {
  texture: Texture;
  /** 진짜 그림이 아직 없어서 코드로 만든 것인지 */
  placeholder: boolean;
  /** (레벨, 지구, 변형) 의 UV 사각형. */
  uv(level: number, zone: number, variant: number): [number, number, number, number];
}

export async function loadBuildingAtlas(): Promise<BuildingAtlas> {
  const art = await loadImage(BUILDING_ATLAS_URL);
  const placeholder = art === null;

  const canvas = document.createElement('canvas');
  canvas.width = BUILDING_ATLAS_W;
  canvas.height = BUILDING_ATLAS_H;
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
    uv(level, zone, variant) {
      const size = buildingCellSize(level);
      const x = (zone * BUILDING_VARIANTS + variant) * size;
      const y = buildingBandY(level);
      return [x / w, y / h, (x + size) / w, (y + size) / h];
    },
  };
}

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

/* ---------------------------------------------------------------- *
 * 자리표시용 건물
 * ---------------------------------------------------------------- */

/** 지붕 / 밝은 면 / 어두운 면. 지구별 색. */
const BODY: readonly (readonly [string, string, string])[] = [
  ['#7fbf8a', '#5f9c6c', '#3f7550'], // 주거
  ['#7fb2e0', '#5a8dc0', '#3c6a98'], // 상업
  ['#d8b463', '#b08f45', '#87692e'], // 공업
];

/**
 * 코드로 그리는 임시 건물.
 *
 * 진짜 그림이 들어오기 전에도 3.1단계를 검증할 수 있어야 한다. 등급별로
 * 높이와 층수가 눈에 띄게 달라야 "1단계가 2단계로 재건축됐다" 를 화면에서
 * 바로 확인할 수 있으므로 대충 그리지 않는다.
 */
function drawPlaceholders(ctx: CanvasRenderingContext2D): void {
  for (let level = 1; level <= LEVEL_COUNT; level++) {
    const size = buildingCellSize(level);
    const bandY = buildingBandY(level);
    // 바닥 다이아몬드는 셀 아래쪽 절반. 아래 꼭짓점이 셀 가운데 아래 끝이다.
    const groundH = size / 2;

    for (let zone = 0; zone < ZONE_COUNT; zone++) {
      for (let v = 0; v < BUILDING_VARIANTS; v++) {
        const ox = (zone * BUILDING_VARIANTS + v) * size;
        const oy = bandY;
        // 몸통 높이. 변형마다 조금씩 다르게 해서 줄지어 서도 밋밋하지 않게 한다.
        const body = groundH * (level === 1 ? 0.62 : 0.78) * (v === 0 ? 1 : 0.82);
        drawBox(ctx, ox, oy, size, groundH, body, BODY[zone], level, v);
      }
    }
  }
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  size: number,
  groundH: number,
  body: number,
  colors: readonly [string, string, string],
  level: number,
  variant: number,
): void {
  const cxm = ox + size / 2;
  // 바닥 다이아몬드 꼭짓점 (셀 아래쪽 절반)
  const bottomY = oy + size;
  const midY = bottomY - groundH / 2;
  const topY = bottomY - groundH;
  const left = ox;
  const right = ox + size;

  // 살짝 안쪽으로 물려서 타일 경계가 보이게 한다.
  const inset = level === 1 ? 4 : 6;
  const k = 1 - (inset * 2) / size;
  const dx = (size / 2) * k;
  const dy = (groundH / 2) * k;

  const roofY = midY - body;

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

  // 창문 줄. 등급이 높을수록 층이 많아 보이게 한다.
  const floors = level === 1 ? 1 : level === 2 ? 3 : 5;
  ctx.fillStyle = 'rgba(20,26,32,0.45)';
  for (let f = 0; f < floors; f++) {
    const t = (f + 0.6) / (floors + 0.2);
    const y = midY - body * t;
    const w = Math.max(2, dx * 0.5);
    ctx.fillRect(cxm + dx * 0.25, y - Math.max(1, body * 0.06), w * 0.6, Math.max(2, body * 0.09));
    ctx.fillRect(cxm - dx * 0.25 - w * 0.6, y - Math.max(1, body * 0.06), w * 0.6, Math.max(2, body * 0.09));
  }

  // 바닥 그림자. 건물이 땅에 붙어 보이게 한다.
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

  // 변형 1 에는 옥탑을 하나 얹는다. 같은 등급이 나란히 서도 구분된다.
  if (variant === 1 && level > 1) {
    const rw = dx * 0.4;
    const rh = body * 0.18;
    ctx.fillStyle = colors[0];
    ctx.beginPath();
    ctx.moveTo(cxm, roofY - dy - rh);
    ctx.lineTo(cxm + rw, roofY - rh);
    ctx.lineTo(cxm, roofY + dy * 0.4 - rh);
    ctx.lineTo(cxm - rw, roofY - rh);
    ctx.closePath();
    ctx.fill();
  }
}
