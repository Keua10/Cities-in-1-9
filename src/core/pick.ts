import { HEIGHT_UNIT, MAX_HEIGHT } from './constants';
import { worldToTileF } from './iso';
import type { World } from '../world/world';

/**
 * 화면(월드 좌표)에서 실제로 눌린 타일을 찾는다.
 *
 * tileToWorldX/Y 는 타일 중심을 정수 타일 좌표에 놓는다.
 * 따라서 보이는 다이아몬드 윗면의 판정은 실수 타일 좌표를 floor 하는 게 아니라
 * 가장 가까운 정수 타일 좌표로 반올림해야 한다.
 *
 * 기존 floor 판정은 다이아몬드 내부에서도 위치에 따라 이웃 타일을 선택할 수 있어
 * 터치 위치와 선택 표시가 살짝 어긋나 보일 수 있었다.
 *
 * 고도가 있으면 높이 h 인 타일의 윗면은 화면에서 HEIGHT_UNIT * h 만큼 위로
 * 올라가 있으므로, 클릭 지점을 같은 양만큼 아래로 되돌린 뒤 후보 타일을 찾는다.
 */
export function pickTile(
  world: World,
  wx: number,
  wy: number,
): { tx: number; ty: number } {
  for (let h = MAX_HEIGHT; h > 0; h--) {
    const t = nearestTile(
      wx,
      wy + h * HEIGHT_UNIT,
    );

    if (
      world.getHeight(
        t.tx,
        t.ty,
      ) === h
    ) {
      return t;
    }
  }

  return nearestTile(
    wx,
    wy,
  );
}

function nearestTile(
  wx: number,
  wy: number,
): { tx: number; ty: number } {
  const f = worldToTileF(
    wx,
    wy,
  );

  return {
    tx: Math.round(f.tx),
    ty: Math.round(f.ty),
  };
}
