import { HEIGHT_UNIT, MAX_HEIGHT } from './constants';
import { worldToTile } from './iso';
import type { World } from '../world/world';

/**
 * 화면(월드 좌표)에서 실제로 눌린 타일을 찾는다.
 *
 * 고도가 있으면 평지 기준 변환만으로는 틀린다. 높이 h 인 타일은 화면에서
 * 16*h 픽셀만큼 위로 올라가 있으므로, 반대로 클릭 지점을 16*h 만큼 내린 뒤
 * 평지 변환을 하면 그 타일이 나온다. 높은 쪽부터 확인해서 가장 먼저 맞는
 * 타일이 카메라에 가장 가까운 타일이다.
 */
export function pickTile(
  world: World,
  wx: number,
  wy: number,
): { tx: number; ty: number } {
  for (let h = MAX_HEIGHT; h > 0; h--) {
    const t = worldToTile(wx, wy + h * HEIGHT_UNIT);
    if (world.getHeight(t.tx, t.ty) === h) return t;
  }
  return worldToTile(wx, wy);
}
