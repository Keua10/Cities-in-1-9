import { CHUNK_SIZE, CHUNK_TILES } from '../core/constants';
import { chunkIndexOf, chunkKey, localIndexOf } from '../core/iso';
import { Build, DIRS } from '../world/build';
import type { World } from '../world/world';
import { isAnchor, ZONE_R, zoneOfCode, levelOfCode } from './buildings';
import {
  ROAD_DIST_UNREACHABLE,
  ROAD_FIELD_MAX_DIST,
  ROAD_REACH,
} from './simConstants';

/**
 * 도로망 거리장.
 *
 * 3.1단계에서 통근을 다루는 방식을 먼저 적어둔다.
 *
 * 개별 시민의 집-직장 짝을 다 계산하면(N x M 경로탐색) 도시가 조금만 커져도
 * 감당이 안 된다. 대신 도로 위에서 **다중 출발점 BFS** 를 두 번 돌린다.
 *
 *   toJobs   모든 상업·공업 건물의 진입 도로에서 출발 -> 각 도로 칸이
 *            "가장 가까운 직장까지 몇 칸인가" 를 갖는다
 *   toHomes  모든 주거 건물의 진입 도로에서 출발 -> 각 도로 칸이
 *            "가장 가까운 주거지까지 몇 칸인가" 를 갖는다
 *
 * 주거 건물의 통근 점수는 자기 진입 도로의 toJobs 값으로, 상업·공업 건물의
 * 인력 수급 점수는 toHomes 값으로 읽는다. BFS 두 번이면 끝이고, 비용은
 * 도로 칸 수에 비례한다(도시 전체 타일 수가 아니다).
 *
 * 이 거리장은 3.2단계에서 차량이 실제로 탈 경로의 뼈대가 된다.
 * 저장하지 않는다 — build 배열에서 언제든 다시 만들 수 있다.
 */

interface Field {
  toJobs: Uint16Array;
  toHomes: Uint16Array;
  /**
   * 이 칸에서 ROAD_REACH 안에 도로가 있는가(1/0).
   *
   * 건물을 놓을 때마다 주변 5x5 를 훑으면 청크 하나에서 초당 수만 번 조회가
   * 일어난다. 거리장을 다시 만들 때 한 번에 계산해두고 배열 조회 한 번으로 끝낸다.
   */
  reach: Uint8Array;
}

export class RoadField {
  private fields = new Map<string, Field>();
  /** 마지막 계산에 들어간 도로 칸 수. HUD 표시용. */
  roadTiles = 0;
  /** 도로에 닿은 건물 수 / 전체 건물 수. */
  connectedBuildings = 0;

  distToJobs(tx: number, ty: number): number {
    const f = this.fields.get(chunkKey(chunkIndexOf(tx), chunkIndexOf(ty)));
    if (!f) return ROAD_DIST_UNREACHABLE;
    return f.toJobs[localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx)];
  }

  distToHomes(tx: number, ty: number): number {
    const f = this.fields.get(chunkKey(chunkIndexOf(tx), chunkIndexOf(ty)));
    if (!f) return ROAD_DIST_UNREACHABLE;
    return f.toHomes[localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx)];
  }

  /** 이 칸이 도로에서 ROAD_REACH 안에 있는가. */
  nearRoad(tx: number, ty: number): boolean {
    const f = this.fields.get(chunkKey(chunkIndexOf(tx), chunkIndexOf(ty)));
    if (!f) return false;
    return f.reach[localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx)] === 1;
  }

  /**
   * 건물의 통근 거리. footprint 에 맞닿은 도로 중 가장 가까운 값을 쓴다.
   * 도로에 안 닿아 있으면 UNREACHABLE.
   */
  commuteFor(
    tx: number,
    ty: number,
    span: number,
    zone: number,
  ): number {
    let best = ROAD_DIST_UNREACHABLE;
    for (const [rx, ry] of edgeNeighbors(tx, ty, span)) {
      const d = zone === ZONE_R ? this.distToJobs(rx, ry) : this.distToHomes(rx, ry);
      if (d < best) best = d;
    }
    return best;
  }

  /** 전체 재계산. 하루에 한 번(ROAD_FIELD_INTERVAL) 돈다. */
  rebuild(world: World): void {
    this.fields.clear();
    const parcels = world.developedParcels();
    if (parcels.length === 0) {
      this.roadTiles = 0;
      this.connectedBuildings = 0;
      return;
    }

    let roads = 0;
    for (const p of parcels) {
      this.fields.set(p.key, {
        toJobs: new Uint16Array(CHUNK_TILES).fill(ROAD_DIST_UNREACHABLE),
        toHomes: new Uint16Array(CHUNK_TILES).fill(ROAD_DIST_UNREACHABLE),
        reach: new Uint8Array(CHUNK_TILES),
      });
      roads += p.roadCount;
    }
    this.roadTiles = roads;

    for (const p of parcels) this.markReach(world, p.cx, p.cy);

    // 출발점 모으기: 건물 footprint 에 맞닿은 도로 칸.
    const jobSeeds: number[] = [];
    const homeSeeds: number[] = [];
    let connected = 0;
    let total = 0;

    for (const p of parcels) {
      if (!p.bld) continue;
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const code = p.bld[ly * CHUNK_SIZE + lx];
          if (!isAnchor(code)) continue;
          total++;
          const zone = zoneOfCode(code);
          const span = levelOfCode(code);
          const tx = p.cx * CHUNK_SIZE + lx;
          const ty = p.cy * CHUNK_SIZE + ly;
          let touched = false;
          for (const [rx, ry] of edgeNeighbors(tx, ty, span)) {
            if (world.getBuild(rx, ry) !== Build.Road) continue;
            touched = true;
            if (zone === ZONE_R) homeSeeds.push(rx, ry);
            else jobSeeds.push(rx, ry);
          }
          if (touched) connected++;
        }
      }
    }
    this.connectedBuildings = total === 0 ? 0 : connected;

    this.bfs(world, jobSeeds, 'toJobs');
    this.bfs(world, homeSeeds, 'toHomes');
  }

  /**
   * 도로 칸만 밟는 너비 우선 탐색.
   * 큐는 [tx, ty] 를 이어 붙인 평평한 배열이다. 객체를 만들지 않아 GC 가 안 돈다.
   */
  private bfs(world: World, seeds: number[], which: 'toJobs' | 'toHomes'): void {
    if (seeds.length === 0) return;

    let queue = seeds.slice();
    let dist = 0;

    // 출발점 자체를 0 으로 찍는다.
    for (let i = 0; i < queue.length; i += 2) {
      this.write(queue[i], queue[i + 1], which, 0);
    }

    while (queue.length > 0 && dist < ROAD_FIELD_MAX_DIST) {
      dist++;
      const next: number[] = [];
      for (let i = 0; i < queue.length; i += 2) {
        const tx = queue[i];
        const ty = queue[i + 1];
        for (const dir of DIRS) {
          const nx = tx + dir[0];
          const ny = ty + dir[1];
          if (world.getBuild(nx, ny) !== Build.Road) continue;
          const f = this.fields.get(chunkKey(chunkIndexOf(nx), chunkIndexOf(ny)));
          if (!f) continue; // 개발되지 않은 청크의 도로는 볼 일이 없다
          const idx = localIndexOf(ny) * CHUNK_SIZE + localIndexOf(nx);
          if (f[which][idx] <= dist) continue;
          f[which][idx] = dist;
          next.push(nx, ny);
        }
      }
      queue = next;
    }
  }

  /**
   * 도로 도달 마스크를 채운다.
   *
   * 청크 경계 밖의 도로도 봐야 한다 — 옆 청크 도로에 붙은 땅이 죽으면 안 된다.
   * 그래서 도로 쪽에서 바깥으로 칠하는 방식이 아니라, 칸마다 주변을 보는
   * 방식으로 간다. 4096칸 x 25 = 10만 번이지만 거리장을 다시 만들 때만 돈다.
   */
  private markReach(world: World, cx: number, cy: number): void {
    const f = this.fields.get(chunkKey(cx, cy));
    if (!f) return;
    const baseX = cx * CHUNK_SIZE;
    const baseY = cy * CHUNK_SIZE;

    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const tx = baseX + lx;
        const ty = baseY + ly;
        let hit = 0;
        for (let dy = -ROAD_REACH; dy <= ROAD_REACH && hit === 0; dy++) {
          for (let dx = -ROAD_REACH; dx <= ROAD_REACH; dx++) {
            if (world.getBuild(tx + dx, ty + dy) === Build.Road) {
              hit = 1;
              break;
            }
          }
        }
        f.reach[ly * CHUNK_SIZE + lx] = hit;
      }
    }
  }

  private write(
    tx: number,
    ty: number,
    which: 'toJobs' | 'toHomes',
    value: number,
  ): void {
    const f = this.fields.get(chunkKey(chunkIndexOf(tx), chunkIndexOf(ty)));
    if (!f) return;
    const idx = localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx);
    if (f[which][idx] > value) f[which][idx] = value;
  }
}

/**
 * span x span 부지의 바깥 테두리 칸들. 건물이 도로에 접했는지 볼 때 쓴다.
 * 모서리 대각선은 넣지 않는다 — 도로는 4방향 연결이다.
 */
export function* edgeNeighbors(
  tx: number,
  ty: number,
  span: number,
): Generator<[number, number]> {
  for (let k = 0; k < span; k++) {
    yield [tx + k, ty - 1];
    yield [tx + k, ty + span];
    yield [tx - 1, ty + k];
    yield [tx + span, ty + k];
  }
}

/** 부지가 도로에 한 칸이라도 접해 있는가. */
export function touchesRoad(
  world: World,
  tx: number,
  ty: number,
  span: number,
): boolean {
  for (const [rx, ry] of edgeNeighbors(tx, ty, span)) {
    if (world.getBuild(rx, ry) === Build.Road) return true;
  }
  return false;
}
