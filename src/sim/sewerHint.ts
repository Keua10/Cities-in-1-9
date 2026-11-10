import { CHUNK_SIZE } from '../core/constants';
import { parseChunkKey } from '../core/iso';
import { BASE_CHUNK_SPAN } from '../core/constants';
import { isWater } from '../world/terrain';
import type { World } from '../world/world';

/**
 * 하수를 내보낼 하천이 어디 있는지 알려주는 문장.
 *
 * 직접 방류구와 하수처리장은 둘 다 **하천에 닿아야** 지을 수 있다. 그런데
 * 기본 영역 안에 물이 한 칸도 없는 도시가 있다(도시 번호마다 지형이 다르다).
 * 그런 도시의 학생은 하수 처리 0% 를 보고도 어디에 무엇을 지어야 하는지
 * 화면에서 알 길이 없었다. 가장 가까운 물이 어느 쪽 몇 칸에 있는지 말해준다.
 *
 * 개척 범위나 지형이 바뀔 때만 다시 계산한다.
 */
let cacheKey = '';
let cacheText = '';

export function sewerOutletHint(world: World): string {
  const keys = [...world.exploredKeys()].sort();
  const key = `${keys.length}:${keys[0] ?? ''}:${world.walkRevision}:${world.baseCx},${world.baseCy}`;
  if (key === cacheKey) return cacheText;
  cacheKey = key;

  const half = (BASE_CHUNK_SPAN * CHUNK_SIZE) / 2;
  const cx = world.baseCx * CHUNK_SIZE + half;
  const cy = world.baseCy * CHUNK_SIZE + half;
  let best: { tx: number; ty: number; d: number } | null = null;
  for (const k of keys) {
    const c = parseChunkKey(k);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const tx = c.cx * CHUNK_SIZE + lx;
        const ty = c.cy * CHUNK_SIZE + ly;
        if (!isWater(world.getTile(tx, ty))) continue;
        const d = Math.max(Math.abs(tx - cx), Math.abs(ty - cy));
        if (!best || d < best.d) best = { tx, ty, d };
      }
    }
  }

  if (!best) {
    cacheText =
      '개척한 땅 안에 하천이 없어 하수 방류구·처리장을 지을 수 없습니다 · 선생님께 알려주세요.';
    return cacheText;
  }
  const insideBase = best.d < half;
  cacheText = insideBase
    ? `하수는 하천에 닿은 직접 방류구로 내보냅니다 · 지도에서 파란 하천을 찾아보세요.`
    : `기본 영역 안에는 하천이 없습니다 · 도시 중심에서 ${screenDirection(best.tx - cx, best.ty - cy)} 약 ${best.d}칸에 하천이 있습니다. 도로·전선·하수도관을 이어 직접 방류구를 지으세요.`;
  return cacheText;
}

/** 타일 방향을 화면 방향 말로 바꾼다. 화면 x = tx - ty, 화면 y = tx + ty. */
function screenDirection(dx: number, dy: number): string {
  const sx = dx - dy;
  const sy = dx + dy;
  const horiz = Math.abs(sx) > Math.abs(sy) * 0.5 ? (sx > 0 ? '오른쪽' : '왼쪽') : '';
  const vert = Math.abs(sy) > Math.abs(sx) * 0.5 ? (sy > 0 ? '아래' : '위') : '';
  if (vert && horiz) return `${horiz} ${vert}`;
  return vert || horiz || '근처';
}
