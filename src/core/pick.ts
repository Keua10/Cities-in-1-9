import type { World } from '../world/world';
import { edgeWallAt, surfaceAt, type TileSurface } from '../world/slope';
import { HEIGHT_UNIT, MAX_HEIGHT, TILE_HH, TILE_HW } from './constants';
import { tileToWorldX, tileToWorldY, worldToTileF } from './iso';

/**
 * 화면(월드 좌표)에서 실제로 눌린 타일을 찾는다.
 *
 * ---------------------------------------------------------------
 * 왜 고도 0 평면 계산만으로는 안 되나
 * ---------------------------------------------------------------
 * 타일이 화면에서 차지하는 그림은 윗면 마름모 하나가 아니다. 고도가 있으면
 * 그 아래로 **옆면(절벽)** 이 같이 그려진다(chunkMesh.ts).
 *
 *     ┌ 윗면 마름모      <- 여기만 판정하면
 *     │╲                     옆면은 "빈 곳" 이 된다
 *     │ ╲ 옆면(절벽)
 *
 * 예전 판정은 클릭 지점을 고도만큼 내려서 윗면만 찾아보고, 못 찾으면 고도 0
 * 평면으로 떨어뜨렸다. 그래서 바닥을 드래그하다 그 바닥의 옆면에 닿는 순간
 * "고도 0 이라면 여기가 무슨 타일인가" 로 판정이 튀었다. 옆면은 화면에서 위로
 * 솟아 있으니 그 답은 언제나 **몇 칸 뒤(위)의 타일** 이고, 커서가 저 멀리
 * 위로 튀어 올랐다. 게다가 절벽에 가려 보이지도 않는 뒤쪽 타일의 윗면이
 * 앞쪽 절벽보다 먼저 뽑히는 경우도 있었다.
 *
 * ---------------------------------------------------------------
 * 지금 방식: 그려진 순서 그대로 앞에서 뒤로 훑는다
 * ---------------------------------------------------------------
 * 렌더러가 쓰는 것과 **같은 도형**(slope.ts 의 지면 평면과 절벽)을 만들어서
 * 점이 그 안에 들어가는지 본다. 아이소메트릭에서 뒤에서 앞으로 그리는 순서는
 * tx + ty 오름차순이므로, 반대로 tx + ty 가 큰 타일부터 보고 **처음 맞은 타일**
 * 이 곧 화면 맨 위에 보이는 타일이다.
 *
 * 옆면에 맞으면 그 옆면의 주인 타일(= 바로 위 칸)을 준다. 바닥을 드래그하다
 * 그 바닥의 옆면으로 넘어가도 고르던 타일이 그대로 유지된다.
 */
export function pickTile(world: World, wx: number, wy: number): { tx: number; ty: number } {
  const ground = nearestTile(wx, wy);

  /*
   * 후보 범위. 고도 한 단계는 화면에서 HEIGHT_UNIT(=TILE_HH) 만큼 올라가고
   * 그 만큼은 타일 좌표로 (+0.5, +0.5) 다. 그래서 고도 MAX_HEIGHT 짜리 타일의
   * 윗면까지 보려면 뒤로 MAX_HEIGHT / 2 칸이면 되고, 반올림 여유로 한 칸 더 본다.
   * 경사 도로는 자기 고도보다 반 단계까지 솟을 수 있으므로 앞으로도 한 칸 본다.
   */
  const back = Math.ceil(MAX_HEIGHT / 2) + 1;
  const front = 1;

  for (let d = back * 2; d >= -front * 2; d--) {
    const hi = Math.min(back, d + front);
    const lo = Math.max(-front, d - back);
    for (let a = hi; a >= lo; a--) {
      const tx = ground.tx + a;
      const ty = ground.ty + (d - a);
      if (hitsTile(world, tx, ty, wx, wy)) return { tx, ty };
    }
  }

  return ground;
}

/** 점이 이 타일의 그림(윗면 + 옆면 두 장) 안에 있는가. */
function hitsTile(world: World, tx: number, ty: number, wx: number, wy: number): boolean {
  const cx = tileToWorldX(tx, ty);
  // 타일 그림은 가로로 TILE_W 를 넘지 않는다. 대각선으로 떨어진 후보를 먼저 쳐낸다.
  if (wx < cx - TILE_HW || wx > cx + TILE_HW) return false;

  const base = tileToWorldY(tx, ty);
  /*
   * 옆면은 이웃 지면까지만 내려간다. 고도 0 마름모의 아래 꼭짓점이 그 한계인데,
   * 경사 도로면은 자기 고도보다 반 단계까지 내려앉으므로 그만큼 여유를 둔다.
   */
  if (wy > base + TILE_HH + HEIGHT_UNIT) return false;

  const s = surfaceAt(world, tx, ty);
  const yN = cornerY(base, s, -0.5, -0.5);
  const yE = cornerY(base, s, 0.5, -0.5);
  const yS = cornerY(base, s, 0.5, 0.5);
  const yW = cornerY(base, s, -0.5, 0.5);

  // 윗면보다 위는 이 타일의 그림이 아니다(옆면은 윗면 아래로만 붙는다).
  if (wy < Math.min(yN, yE, yS, yW)) return false;

  // 윗면 마름모. 경사 도로면 네 꼭짓점이 지면 평면을 따라 기운다.
  if (inQuad(cx, yN, cx + TILE_HW, yE, cx, yS, cx - TILE_HW, yW, wx, wy)) return true;

  // +tx 면(오른쪽 아래를 향한 절벽). 꼭짓점 차례는 chunkMesh 와 같다.
  const right = edgeWallAt(world, tx, ty, 1, 0);
  if (
    right.steps > 0 &&
    inQuad(
      cx,
      base + TILE_HH - right.topA * HEIGHT_UNIT,
      cx + TILE_HW,
      base - right.topB * HEIGHT_UNIT,
      cx + TILE_HW,
      base - right.botB * HEIGHT_UNIT,
      cx,
      base + TILE_HH - right.botA * HEIGHT_UNIT,
      wx,
      wy,
    )
  ) {
    return true;
  }

  // +ty 면(왼쪽 아래를 향한 절벽).
  const left = edgeWallAt(world, tx, ty, 0, 1);
  return (
    left.steps > 0 &&
    inQuad(
      cx - TILE_HW,
      base - left.topA * HEIGHT_UNIT,
      cx,
      base + TILE_HH - left.topB * HEIGHT_UNIT,
      cx,
      base + TILE_HH - left.botB * HEIGHT_UNIT,
      cx - TILE_HW,
      base - left.botA * HEIGHT_UNIT,
      wx,
      wy,
    )
  );
}

/** 지면 평면 위 (sx, sy) 꼭짓점의 화면 y. chunkMesh 의 정점 식과 같다. */
function cornerY(base: number, s: TileSurface, sx: number, sy: number): number {
  return base + (sx + sy) * TILE_HH - (s.zc + s.dzx * sx + s.dzy * sy) * HEIGHT_UNIT;
}

/**
 * 볼록 사각형 안에 점이 있는가. 네 변의 외적 부호가 엇갈리지 않으면 안이다.
 * 윗면은 아핀 투영이라 언제나 평행사변형이고, 옆면은 세로 변이 평행한 사다리꼴이라
 * 둘 다 볼록이다. 변 위(외적 0)는 안으로 친다 — 맞닿은 타일 사이에 틈이 없어야 한다.
 */
function inQuad(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  px: number,
  py: number,
): boolean {
  const xs = [x0, x1, x2, x3];
  const ys = [y0, y1, y2, y3];
  let positive = false;
  let negative = false;

  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const cross = (xs[j] - xs[i]) * (py - ys[i]) - (ys[j] - ys[i]) * (px - xs[i]);
    if (cross > 1e-6) positive = true;
    else if (cross < -1e-6) negative = true;
    if (positive && negative) return false;
  }

  return true;
}

/**
 * 고도 0 평면에서 점이 들어 있는 마름모.
 *
 * tileToWorldX/Y 는 타일 중심을 정수 타일 좌표에 놓으므로 실수 타일 좌표를
 * floor 가 아니라 반올림해야 그 마름모가 나온다.
 */
function nearestTile(wx: number, wy: number): { tx: number; ty: number } {
  const f = worldToTileF(wx, wy);

  return {
    tx: Math.round(f.tx),
    ty: Math.round(f.ty),
  };
}
