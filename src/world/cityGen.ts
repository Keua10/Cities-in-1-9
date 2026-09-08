import { BASE_CHUNK_SPAN, CHUNK_SIZE } from '../core/constants';
import { localIndexOf } from '../core/iso';
import { BLD_NONE, simRandom, ZONE_C, ZONE_I, ZONE_R } from '../sim/buildings';
import {
  canPlaceFacility,
  FAC_FIRE,
  FAC_HOSPITAL,
  FAC_MINIPARK,
  FAC_PARK,
  FAC_POLICE,
  FAC_SCHOOL,
  FAC_SPORTS,
  facilitySpan,
  touchesRoadTiles,
} from '../sim/facilities';
import { Build, canPlaceRoad, DIRS } from './build';
import { isWater } from './terrain';
import type { World } from './world';

/**
 * 테스트용 대도시 생성기.
 *
 * ---------------------------------------------------------------
 * 왜 격자 도시를 만들지 않는가
 * ---------------------------------------------------------------
 * 예전 testCity.ts 는 20x20 에 3x3 격자 도로를 깔았다. 시뮬레이션이 도는지
 * 보기에는 충분했지만, 그걸로는 **아무것도 검증되지 않는다.** 격자 도시에는
 * 경사 도로도, 막다른 길도, 교차로 밀도 차이도, 물가 지형도 없다.
 *
 * 이 생성기는 실제 도시가 자라는 순서를 그대로 따라간다.
 *
 *   1. 지형을 읽고 도심이 설 만한 자리를 고른다 (평지 + 물 아님)
 *   2. 도심 둘레에 부도심·주거·공업 **구역 씨앗** 을 뿌린다
 *   3. 씨앗끼리 간선도로로 잇는다 — 길찾기가 지형을 피해 돌아가므로
 *      직선이 아니라 등고선을 따라 휘어진다
 *   4. 구역마다 **자기 결의 격자** 로 이면도로를 깐다 (블록 크기·방향·위상이
 *      구역마다 다르다. 그래서 구역 경계에서 길이 어긋나고, 그 어긋남이
 *      도시를 기계적이지 않게 만든다)
 *   5. 비탈 규칙을 못 지키는 도로를 걷어내고, 도심에서 끊긴 도로도 걷어낸다
 *   6. 시설 -> 지구 -> 건물 순으로 채운다
 *
 * 모든 난수는 좌표 해시다(simRandom). 같은 도시 번호면 언제 몇 번을 돌려도
 * 같은 도시가 나온다 — 그래야 "지난번 그 비탈길" 을 다시 열어볼 수 있다.
 */

/** 도시 기본 영역 한 변(타일). 4x4 청크 = 256. */
const SPAN = BASE_CHUNK_SPAN * CHUNK_SIZE;

/**
 * 도시 반경(타일). 구역 씨앗을 뿌리는 거리와 도시 테두리가 여기서 나온다.
 *
 * **이 숫자는 취향이 아니라 예산이다.**
 * 매크로 시뮬레이션은 하루에 한 번(60초마다) 통근 배정과 혼잡 추정을 다시
 * 만드는데, 둘 다 "집 한 채마다 도로망 BFS" 라서 비용이 도시 넓이의 제곱에
 * 가깝게 는다. 처음 만든 반경 125짜리 도시(건물 6,700채)는 그 재계산에
 * 6.5초가 걸렸다 — 1분마다 6.5초씩 멈추는 도시는 대도시가 아니라 슬라이드다.
 *
 * 반경 70이면 건물 3천여 채, 하루치 재계산이 한 틱에 0.4초 안쪽이다. 화면(줌 1.0)에 40x30
 * 타일이 들어오므로 이 크기도 끝에서 끝까지 걸어 다니면 한참 걸린다.
 */
const CITY_RADIUS = 70;
/** 영역 가장자리 여유. 이웃 도시 쪽으로 도로가 새어 나가지 않게 한다. */
const EDGE = 6;

/** 구역 종류. 블록 모양·지구 구성·건물 밀도가 여기서 갈린다. */
const K_DOWNTOWN = 0;
const K_SUBCENTER = 1;
const K_RESIDENTIAL = 2;
const K_INDUSTRIAL = 3;

interface Seed {
  x: number;
  y: number;
  kind: number;
  /** 블록 한 변(도로 간격). 두 값이 다르면 긴 블록이 된다. */
  blockW: number;
  blockH: number;
  /** 격자 위상. 구역마다 달라서 경계에서 길이 어긋난다. */
  phaseX: number;
  phaseY: number;
  /** 도심에서의 거리. 건물 밀도를 여기서 뽑는다. */
  ring: number;
}

/**
 * 새로 심은 도시의 시작 자금.
 *
 * 이미 인구 수만 명짜리 도시를 받아 든 상태라 START_MONEY(6만) 로 시작하면
 * 첫날 유지비에 눌린다. 도시 규모에 맞춘 금고를 열어 준다.
 */
export const SEEDED_CITY_MONEY = 300_000;

export interface SeededCity {
  tx: number;
  ty: number;
}

/**
 * 아직 아무것도 안 지어진 도시에만 큰 도시를 심는다.
 * 저장된 도로/지구가 하나라도 있으면 절대 손대지 않는다.
 */
export function seedCityIfEmpty(world: World, bornDay = 0): SeededCity | null {
  if (world.developedParcels().length > 0) return null;
  return generateCity(world, bornDay);
}

/** 조건 없이 새로 만든다. "맵 초기화" 버튼이 부른다. */
export function generateCity(world: World, bornDay = 0): SeededCity | null {
  return new CityBuilder(world, bornDay).run();
}

class CityBuilder {
  private ox: number;
  private oy: number;
  private seedBase: number;

  private land = new Uint8Array(SPAN * SPAN);
  private hgt = new Uint8Array(SPAN * SPAN);
  /** 1 = 도로 예정. 실제 setBuild 는 규칙 검사를 통과한 뒤에 한 번만 한다. */
  private plan = new Uint8Array(SPAN * SPAN);
  /** 이 칸이 속한 구역 씨앗 번호. -1 은 도시 밖(자연 상태). */
  private owner = new Int16Array(SPAN * SPAN).fill(-1);

  private seeds: Seed[] = [];
  private cx = 0;
  private cy = 0;

  constructor(
    private world: World,
    private bornDay: number,
  ) {
    this.ox = world.baseCx * CHUNK_SIZE;
    this.oy = world.baseCy * CHUNK_SIZE;
    // 도시 번호가 다르면 배치도 달라진다. 지형 자체가 이미 다르지만,
    // 블록 위상까지 갈라 두면 두 도시가 형제처럼 보이지 않는다.
    this.seedBase = (world.baseCx * 7919 + world.baseCy * 104729) | 0;
  }

  run(): SeededCity | null {
    this.readTerrain();
    if (!this.chooseCenter()) return null;
    this.placeSeeds();
    this.assignDistricts();
    this.planArterials();
    this.planLocalStreets();
    this.enforceSlopeRule();
    this.pruneDisconnected();
    this.commitRoads();
    this.placeFacilities();
    this.paintZones();
    this.placeBuildings();
    return { tx: this.ox + this.cx, ty: this.oy + this.cy };
  }

  /* ---------------- 좌표 도우미 ---------------- */

  private idx(x: number, y: number): number {
    return y * SPAN + x;
  }

  private inside(x: number, y: number): boolean {
    return x >= EDGE && y >= EDGE && x < SPAN - EDGE && y < SPAN - EDGE;
  }

  private rnd(a: number, b: number, c: number): number {
    return simRandom(this.seedBase, a, b, c);
  }

  /**
   * 0~1 사이의 부드러운 잡음. 격자 간격 `cell` 타일마다 값을 뽑고 사이를 부드럽게 잇는다.
   * 구역 경계를 구불구불하게 만들고, 길찾기 비용에 결을 넣는 데 쓴다.
   */
  private noise(x: number, y: number, cell: number, salt: number): number {
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    const fx = smooth(x / cell - gx);
    const fy = smooth(y / cell - gy);
    const a = this.rnd(gx, gy, salt);
    const b = this.rnd(gx + 1, gy, salt);
    const c = this.rnd(gx, gy + 1, salt);
    const d = this.rnd(gx + 1, gy + 1, salt);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  }

  /* ---------------- 1. 지형 읽기 ---------------- */

  private readTerrain(): void {
    for (let y = 0; y < SPAN; y++) {
      for (let x = 0; x < SPAN; x++) {
        const i = this.idx(x, y);
        const tx = this.ox + x;
        const ty = this.oy + y;
        this.hgt[i] = this.world.sampleHeight(tx, ty);
        this.land[i] = isWater(this.world.getTile(tx, ty)) ? 0 : 1;
      }
    }
  }

  /* ---------------- 2. 도심 자리 ---------------- */

  /**
   * 도심은 "넓고 평평하고 영역 한가운데에 가까운" 자리다.
   * 물가를 싫어하지는 않는다 — 강가·바닷가 도심이 오히려 도시답다.
   */
  private chooseCenter(): boolean {
    let best = -1;
    for (let y = EDGE + 16; y < SPAN - EDGE - 16; y += 3) {
      for (let x = EDGE + 16; x < SPAN - EDGE - 16; x += 3) {
        const i = this.idx(x, y);
        if (!this.land[i]) continue;
        const h = this.hgt[i];
        let open = 0;
        let flat = 0;
        for (let dy = -15; dy <= 15; dy += 3) {
          for (let dx = -15; dx <= 15; dx += 3) {
            const j = this.idx(x + dx, y + dy);
            if (!this.land[j]) continue;
            open++;
            if (this.hgt[j] === h) flat++;
          }
        }
        const pull = Math.hypot(x - SPAN / 2, y - SPAN / 2) * 0.16;
        const score = open + flat * 0.7 - pull;
        if (score > best) {
          best = score;
          this.cx = x;
          this.cy = y;
        }
      }
    }
    return best > 0;
  }

  /* ---------------- 3. 구역 씨앗 ---------------- */

  private placeSeeds(): void {
    this.pushSeed(this.cx, this.cy, K_DOWNTOWN, 0);

    // 안쪽 고리 — 도심을 둘러싼 부도심과 오래된 주거지.
    const inner = 5;
    for (let i = 0; i < inner; i++) {
      const a = (i / inner) * Math.PI * 2 + this.rnd(i, 11, 3) * 0.7;
      const r = CITY_RADIUS * (0.34 + this.rnd(i, 12, 3) * 0.12);
      const kind = i % 2 === 0 ? K_RESIDENTIAL : K_SUBCENTER;
      this.pushSeed(
        Math.round(this.cx + Math.cos(a) * r),
        Math.round(this.cy + Math.sin(a) * r * 0.92),
        kind,
        1,
      );
    }

    // 바깥 고리 — 신도시 주거와 공업지대. 공업은 서로 붙여 놓는다.
    const outer = 7;
    const industrialAt = Math.floor(this.rnd(3, 3, 3) * outer);
    for (let i = 0; i < outer; i++) {
      const a = ((i + 0.5) / outer) * Math.PI * 2 + this.rnd(i, 21, 4) * 0.5;
      const r = CITY_RADIUS * (0.66 + this.rnd(i, 22, 4) * 0.26);
      const industrial = i === industrialAt || i === (industrialAt + 1) % outer;
      this.pushSeed(
        Math.round(this.cx + Math.cos(a) * r),
        Math.round(this.cy + Math.sin(a) * r * 0.92),
        industrial ? K_INDUSTRIAL : K_RESIDENTIAL,
        2,
      );
    }
  }

  /** 물이나 영역 밖이면 가까운 뭍으로 끌어당긴다. 못 찾으면 그 씨앗은 버린다. */
  private pushSeed(x: number, y: number, kind: number, ring: number): void {
    const spot = this.nearestLand(x, y, 14);
    if (!spot) return;
    const n = this.seeds.length;
    // 블록 모양. 종류마다 결이 다르고, 같은 종류끼리도 조금씩 다르다.
    let bw: number;
    let bh: number;
    if (kind === K_DOWNTOWN) {
      bw = 5;
      bh = 7;
    } else if (kind === K_SUBCENTER) {
      bw = 5;
      bh = 8 + Math.floor(this.rnd(n, 31, 5) * 3);
    } else if (kind === K_INDUSTRIAL) {
      bw = 7 + Math.floor(this.rnd(n, 32, 5) * 2);
      bh = 10 + Math.floor(this.rnd(n, 33, 5) * 4);
    } else {
      bw = 5 + Math.floor(this.rnd(n, 34, 5) * 2);
      bh = 8 + Math.floor(this.rnd(n, 35, 5) * 5);
    }
    // 절반은 결을 90도 돌린다. 이웃 구역과 격자 방향이 어긋나야 도시가
    // 한 장의 모눈종이처럼 보이지 않는다.
    if (this.rnd(n, 36, 5) < 0.5) {
      const t = bw;
      bw = bh;
      bh = t;
    }
    this.seeds.push({
      x: spot.x,
      y: spot.y,
      kind,
      blockW: bw,
      blockH: bh,
      phaseX: Math.floor(this.rnd(n, 37, 5) * bw),
      phaseY: Math.floor(this.rnd(n, 38, 5) * bh),
      ring,
    });
  }

  private nearestLand(x: number, y: number, limit: number): { x: number; y: number } | null {
    for (let r = 0; r <= limit; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!this.inside(nx, ny)) continue;
          if (this.land[this.idx(nx, ny)]) return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  /* ---------------- 4. 구역 나누기 ---------------- */

  /**
   * 가장 가까운 씨앗이 그 칸의 주인이다. 거리에 잡음을 곱하므로 경계가
   * 직선이 아니라 구불구불해진다. 어느 씨앗에서도 멀면 도시 밖(-1)이다.
   */
  private assignDistricts(): void {
    if (!this.seeds.length) return;
    for (let y = EDGE; y < SPAN - EDGE; y++) {
      for (let x = EDGE; x < SPAN - EDGE; x++) {
        const i = this.idx(x, y);
        if (!this.land[i]) continue;
        const wobble = 0.78 + this.noise(x, y, 26, 71) * 0.5;
        let bestD = Infinity;
        let best = -1;
        for (let s = 0; s < this.seeds.length; s++) {
          const seed = this.seeds[s];
          // 도심은 조금 더 넓게 잡는다. 실제 도시도 도심이 구역을 빨아들인다.
          const bias = seed.kind === K_DOWNTOWN ? 0.82 : 1;
          const d =
            Math.hypot(x - seed.x, y - seed.y) * wobble * bias;
          if (d < bestD) {
            bestD = d;
            best = s;
          }
        }
        // 도시의 바깥 테두리. 여기서부터는 들판으로 남긴다.
        if (bestD > CITY_RADIUS * 0.3) continue;
        this.owner[i] = best;
      }
    }
  }

  /* ---------------- 5. 간선도로 ---------------- */

  private planArterials(): void {
    const inner = this.seeds.filter((s) => s.ring === 1);
    const outer = this.seeds.filter((s) => s.ring === 2);
    const hub = this.seeds[0];
    if (!hub) return;

    for (const s of inner) this.stamp(this.route(hub, s), true);
    for (const s of outer) {
      // 바깥 고리는 도심이 아니라 가장 가까운 안쪽 구역에 붙인다.
      // 모든 길이 도심으로 직행하면 도심이 로터리처럼 뭉개진다.
      let near = hub;
      let best = Infinity;
      for (const a of inner) {
        const d = Math.hypot(a.x - s.x, a.y - s.y);
        if (d < best) {
          best = d;
          near = a;
        }
      }
      this.stamp(this.route(near, s), true);
    }

    // 순환도로. 안쪽 고리를 한 바퀴 잇되 한두 구간은 일부러 빼먹는다
    // (실제 도시의 순환도로도 대개 미완성이다).
    for (let i = 0; i < inner.length; i++) {
      if (this.rnd(i, 51, 6) < 0.22) continue;
      this.stamp(this.route(inner[i], inner[(i + 1) % inner.length]), true);
    }
    for (let i = 0; i < outer.length; i++) {
      if (this.rnd(i, 52, 6) < 0.45) continue;
      this.stamp(this.route(outer[i], outer[(i + 1) % outer.length]), false);
    }
  }

  /**
   * A* 길찾기. 물은 못 지나가고, 고도가 바뀌는 칸은 비싸다.
   * 그래서 길이 등고선을 따라 휘고, 언덕은 넘어야 할 때만 넘는다 —
   * 그 자리가 곧 경사 도로다.
   */
  private route(a: Seed, b: Seed): number[] {
    const start = this.idx(a.x, a.y);
    const goal = this.idx(b.x, b.y);
    const cost = new Float32Array(SPAN * SPAN).fill(Infinity);
    const prev = new Int32Array(SPAN * SPAN).fill(-1);
    const heap = new MinHeap();
    cost[start] = 0;
    heap.push(start, 0);

    let found = false;
    let guard = 0;
    while (heap.size > 0 && guard++ < 220_000) {
      const cur = heap.pop();
      if (cur === goal) {
        found = true;
        break;
      }
      const cx = cur % SPAN;
      const cy = (cur / SPAN) | 0;
      const base = cost[cur];
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.inside(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (!this.land[ni]) continue;
        // 이미 깔린 길 위를 지나가면 싸다. 간선이 하나로 모여 큰길이 된다.
        const reuse = this.plan[ni] ? 0.35 : 1;
        const climb = Math.abs(this.hgt[ni] - this.hgt[cur]) * 2.6;
        const grain = this.noise(nx, ny, 18, 91) * 1.1;
        const next = base + reuse + climb + grain;
        if (next >= cost[ni]) continue;
        cost[ni] = next;
        prev[ni] = cur;
        heap.push(ni, next + (Math.abs(nx - b.x) + Math.abs(ny - b.y)) * 0.9);
      }
    }
    if (!found) return [];

    const path: number[] = [];
    for (let i = goal; i !== -1; i = prev[i]) path.push(i);
    return path.reverse();
  }

  /** 길을 계획에 새긴다. wide 면 같은 고도인 옆칸까지 2차선으로 넓힌다. */
  private stamp(path: readonly number[], wide: boolean): void {
    for (let k = 0; k < path.length; k++) {
      const i = path[k];
      this.plan[i] = 1;
      if (!wide) continue;
      const x = i % SPAN;
      const y = (i / SPAN) | 0;
      // 진행 방향의 직각으로 한 칸. 방향이 바뀌는 자리에서는 건너뛴다.
      const nxt = path[k + 1] ?? path[k - 1] ?? i;
      const dx = Math.sign((nxt % SPAN) - x);
      const dy = Math.sign(((nxt / SPAN) | 0) - y);
      const px = dy !== 0 ? 1 : 0;
      const py = dx !== 0 ? 1 : 0;
      const sx = x + px;
      const sy = y + py;
      if (!this.inside(sx, sy)) continue;
      const si = this.idx(sx, sy);
      // **고도가 같을 때만** 넓힌다. 비탈에서 옆으로 붙이면 그 칸이 여러
      // 방향으로 비탈지게 되어 규칙에 걸린다(build.ts 경사 판정).
      if (this.land[si] && this.hgt[si] === this.hgt[i]) this.plan[si] = 1;
    }
  }

  /* ---------------- 6. 이면도로 ---------------- */

  /**
   * 구역마다 자기 격자를 깐다. 선을 끝까지 긋지 않고 **구역 안에 있는 동안만**
   * 긋는다. 그래서 물가·언덕·구역 경계에서 길이 자연스럽게 끊기고, 구역마다
   * 격자의 방향과 위상이 달라 도시 전체가 한 장의 모눈이 되지 않는다.
   */
  private planLocalStreets(): void {
    for (let s = 0; s < this.seeds.length; s++) {
      const seed = this.seeds[s];
      const box = this.districtBox(s);
      if (!box) continue;

      for (let y = box.y0; y <= box.y1; y++) {
        if (mod(y - seed.phaseY, seed.blockH) !== 0) continue;
        this.runLine(s, box.x0, box.x1, y, true);
      }
      for (let x = box.x0; x <= box.x1; x++) {
        if (mod(x - seed.phaseX, seed.blockW) !== 0) continue;
        this.runLine(s, box.y0, box.y1, x, false);
      }
    }
  }

  private districtBox(s: number): { x0: number; y0: number; x1: number; y1: number } | null {
    let x0 = SPAN;
    let y0 = SPAN;
    let x1 = -1;
    let y1 = -1;
    for (let y = EDGE; y < SPAN - EDGE; y++) {
      for (let x = EDGE; x < SPAN - EDGE; x++) {
        if (this.owner[this.idx(x, y)] !== s) continue;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? null : { x0, y0, x1, y1 };
  }

  /**
   * 선 하나를 긋는다. 구역 안에 있는 구간(run)만 남기고, 짧은 토막은 버린다.
   * 가끔 한쪽 끝을 잘라 막다른 길을 만들고, 가끔 도중에 한 칸 어긋나게 꺾는다.
   */
  private runLine(s: number, from: number, to: number, fixed: number, horizontal: boolean): void {
    let shift = 0;
    let run: number[] = [];
    const flush = (): void => {
      if (run.length >= 6) {
        // 막다른 길: 20% 확률로 끝을 두어 칸 자른다.
        const cut =
          this.rnd(run[0], fixed, 61) < 0.2
            ? 1 + Math.floor(this.rnd(run[0], fixed, 62) * 3)
            : 0;
        for (let k = 0; k < run.length - cut; k++) this.plan[run[k]] = 1;
      }
      run = [];
    };

    for (let p = from; p <= to; p++) {
      // 구역 안에서 한 번쯤 한 칸 어긋난다. 완전한 직선은 도시를 기계처럼 보이게 한다.
      if (this.rnd(p, fixed, 63) < 0.035) shift += this.rnd(p, fixed, 64) < 0.5 ? 1 : -1;
      const x = horizontal ? p : fixed + shift;
      const y = horizontal ? fixed + shift : p;
      if (!this.inside(x, y)) {
        flush();
        continue;
      }
      const i = this.idx(x, y);
      if (this.owner[i] !== s || !this.land[i]) {
        flush();
        continue;
      }
      run.push(i);
    }
    flush();
  }

  /* ---------------- 7. 규칙 정리 ---------------- */

  /**
   * 비탈 규칙(build.ts)을 계획 단계에서 미리 지킨다.
   *
   * 한 칸이 여러 방향으로 비탈지면 그릴 수 없으므로 그 칸을 뺀다. 빼면 이웃의
   * 상황도 바뀌므로 더 이상 바뀌지 않을 때까지 돌린다. 결과는 "언덕을 비스듬히
   * 가로지르던 골목이 언덕 앞에서 끊긴 모습" 이고, 그게 실제 지형의 도시다.
   */
  private enforceSlopeRule(): void {
    for (let pass = 0; pass < 6; pass++) {
      let removed = 0;
      for (let y = EDGE; y < SPAN - EDGE; y++) {
        for (let x = EDGE; x < SPAN - EDGE; x++) {
          const i = this.idx(x, y);
          if (!this.plan[i]) continue;
          if (this.slopeOk(x, y)) continue;
          this.plan[i] = 0;
          removed++;
        }
      }
      if (removed === 0) break;
    }
  }

  private slopeOk(x: number, y: number): boolean {
    const h = this.hgt[this.idx(x, y)];
    let count = 0;
    let first = -1;
    let second = -1;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d][0];
      const ny = y + DIRS[d][1];
      if (!this.inside(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      if (!this.plan[ni]) continue;
      if (this.hgt[ni] === h) continue;
      count++;
      if (first < 0) first = d;
      else if (second < 0) second = d;
    }
    if (count <= 1) return true;
    if (count > 2) return false;
    return (first + 2) % 4 === second;
  }

  /** 도심에서 도로만 밟아 못 가는 길은 없앤다. 섬처럼 뜬 골목은 도시가 아니다. */
  private pruneDisconnected(): void {
    const start = this.nearestPlanned(this.cx, this.cy);
    if (start < 0) return;
    const seen = new Uint8Array(SPAN * SPAN);
    const queue = new Int32Array(SPAN * SPAN);
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const cur = queue[head++];
      const x = cur % SPAN;
      const y = (cur / SPAN) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.inside(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (seen[ni] || !this.plan[ni]) continue;
        seen[ni] = 1;
        queue[tail++] = ni;
      }
    }
    for (let i = 0; i < this.plan.length; i++) {
      if (this.plan[i] && !seen[i]) this.plan[i] = 0;
    }
  }

  private nearestPlanned(x: number, y: number): number {
    for (let r = 0; r < 60; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!this.inside(nx, ny)) continue;
          const i = this.idx(nx, ny);
          if (this.plan[i]) return i;
        }
      }
    }
    return -1;
  }

  /* ---------------- 8. 실제로 놓기 ---------------- */

  private commitRoads(): void {
    for (let y = EDGE; y < SPAN - EDGE; y++) {
      for (let x = EDGE; x < SPAN - EDGE; x++) {
        if (!this.plan[this.idx(x, y)]) continue;
        const tx = this.ox + x;
        const ty = this.oy + y;
        // 계획 단계에서 이미 규칙을 지켰지만, 마지막 관문은 한 곳(build.ts)이어야 한다.
        if (!canPlaceRoad(this.world, tx, ty).ok) continue;
        this.world.setBuild(tx, ty, Build.Road, false);
      }
    }
  }

  /* ---------------- 9. 시설 ---------------- */

  /**
   * 시설을 **커버리지 격자** 로 놓는다.
   *
   * 구역마다 한두 채씩 놓아 봤더니 도시가 커질수록 서비스 품질이 무너졌다.
   * 이 게임의 만족도는 서비스·복지 감점이 0.5까지 깎아내리고, 2·3단계 건물의
   * 입주 기준선이 0.45 / 0.62 라서, 커버가 모자라면 **큰 도시일수록 공실률이
   * 올라간다.** 실제로 그렇게 만든 첫 판이 입주율 28% 였다.
   *
   * 그래서 간격을 정원과 반경에서 거꾸로 잡는다.
   *
   *   소방서  정원 220채   -> 24칸마다 (건물 밀도 기준으로 정원 언저리)
   *   경찰서  정원 3,000명 -> 46칸마다
   *   병원    정원 5,000명 -> 62칸마다
   *   학교    정원 2,500명 -> 42칸마다
   *   공원    중산층 요구를 6.4칸까지 채운다 -> 16칸마다
   *   소공원  저소득 요구를 3.7칸까지 채운다 -> 11칸마다 (자투리 메우기)
   *
   * 격자점마다 잡음으로 흔들고, 구역 성격에 안 맞는 시설은 건너뛴다
   * (공업지대에 학교와 체육시설을 놓지 않는다). 그래서 줄 맞춰 선 것처럼
   * 보이지 않으면서도 도시 전체가 고르게 덮인다.
   *
   * 큰 것부터 놓는다. 3x3 병원이 자리를 못 잡는 게 소공원이 못 서는 것보다 아프다.
   */
  private placeFacilities(): void {
    const lattice: ReadonlyArray<readonly [number, number]> = [
      [FAC_HOSPITAL, 62],
      [FAC_POLICE, 46],
      [FAC_SCHOOL, 42],
      [FAC_SPORTS, 30],
      [FAC_FIRE, 24],
      [FAC_PARK, 16],
      [FAC_MINIPARK, 11],
    ];

    for (const [kind, spacing] of lattice) {
      const half = spacing >> 1;
      for (let y = EDGE + half; y < SPAN - EDGE; y += spacing) {
        for (let x = EDGE + half; x < SPAN - EDGE; x += spacing) {
          const jx = x + Math.round((this.rnd(x, y, kind + 100) - 0.5) * spacing * 0.6);
          const jy = y + Math.round((this.rnd(x, y, kind + 200) - 0.5) * spacing * 0.6);
          if (!this.inside(jx, jy)) continue;
          const s = this.owner[this.idx(jx, jy)];
          if (s < 0) continue;
          if (!this.suitsDistrict(kind, this.seeds[s].kind)) continue;
          this.tryFacility(kind, jx, jy, Math.min(9, half));
        }
      }
    }
  }

  /** 구역 성격에 맞는 시설인가. 공장지대의 학교는 아무도 안 다닌다. */
  private suitsDistrict(kind: number, districtKind: number): boolean {
    if (districtKind !== K_INDUSTRIAL) return true;
    return kind === FAC_FIRE || kind === FAC_POLICE || kind === FAC_MINIPARK;
  }

  private tryFacility(kind: number, x: number, y: number, limit: number): boolean {
    const span = facilitySpan(kind);
    for (let r = 0; r <= limit; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!this.inside(nx, ny) || !this.inside(nx + span, ny + span)) continue;
          const tx = this.ox + nx;
          const ty = this.oy + ny;
          if (!canPlaceFacility(this.world, tx, ty, kind).ok) continue;
          this.world.placeFacility(tx, ty, kind, this.bornDay);
          return true;
        }
      }
    }
    return false;
  }

  /* ---------------- 10. 지구 ---------------- */

  /**
   * 도로에서 두 칸 안쪽까지만 지구로 칠한다.
   *
   * 세 칸 넘게 칠하면 그 안쪽은 도로에 닿지 못해 "지어져도 비는 건물" 이 된다
   * (roadGraph 의 통근 거리는 필지에 **맞닿은** 도로에서 잰다). 안 칠한
   * 블록 속살은 마당·공터로 남아서, 위에서 보면 도시가 훨씬 자연스럽다.
   */
  private paintZones(): void {
    const dist = new Uint8Array(SPAN * SPAN).fill(255);
    const queue = new Int32Array(SPAN * SPAN);
    let head = 0;
    let tail = 0;
    for (let y = EDGE; y < SPAN - EDGE; y++) {
      for (let x = EDGE; x < SPAN - EDGE; x++) {
        const i = this.idx(x, y);
        if (this.world.getBuild(this.ox + x, this.oy + y) !== Build.Road) continue;
        dist[i] = 0;
        queue[tail++] = i;
      }
    }
    while (head < tail) {
      const cur = queue[head++];
      if (dist[cur] >= 2) continue;
      const x = cur % SPAN;
      const y = (cur / SPAN) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.inside(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (dist[ni] !== 255) continue;
        dist[ni] = dist[cur] + 1;
        queue[tail++] = ni;
      }
    }

    for (let y = EDGE; y < SPAN - EDGE; y++) {
      for (let x = EDGE; x < SPAN - EDGE; x++) {
        const i = this.idx(x, y);
        if (dist[i] === 0 || dist[i] > 2) continue;
        if (!this.land[i]) continue;
        const s = this.owner[i];
        if (s < 0) continue;
        const tx = this.ox + x;
        const ty = this.oy + y;
        if (this.world.getBuild(tx, ty) !== Build.None) continue;
        const zone = this.zoneFor(this.seeds[s], x, y);
        if (zone < 0) continue;
        this.world.setBuild(tx, ty, zone, false);
      }
    }
  }

  /**
   * 이 칸에 어떤 지구를 칠할까.
   *
   * 한 구역을 한 색으로 칠하지 않는다. 주거지에도 동네 가게가 있고, 공업지대
   * 입구에도 상가가 있다. 잡음으로 섞되 **구역의 성격은 남게** 비율을 잡았고,
   * 일부는 일부러 비워서 공터·녹지로 둔다.
   */
  private zoneFor(seed: Seed, x: number, y: number): number {
    const n = this.noise(x, y, 9, 81);
    const green = this.noise(x, y, 5, 82);
    if (green > 0.93) return -1; // 공터

    if (seed.kind === K_DOWNTOWN) {
      return n < 0.72 ? Build.ZoneC : Build.ZoneR;
    }
    if (seed.kind === K_SUBCENTER) {
      if (n < 0.5) return Build.ZoneC;
      return n < 0.92 ? Build.ZoneR : Build.ZoneI;
    }
    if (seed.kind === K_INDUSTRIAL) {
      return n < 0.82 ? Build.ZoneI : Build.ZoneC;
    }
    // 주거지 — 큰길가에는 상가가 붙는다.
    if (n > 0.88) return Build.ZoneC;
    return Build.ZoneR;
  }

  /* ---------------- 11. 건물 ---------------- */

  /**
   * 처음부터 건물을 채워 넣는다. 시뮬레이션이 자라기를 기다리면 대도시를 보는 데
   * 며칠(게임 시간)이 걸린다.
   *
   * 규칙 두 가지만 지키면 나머지는 시뮬레이션이 알아서 한다.
   *   - 필지가 도로에 **맞닿아야** 한다 (안 그러면 통근 거리가 무한대라 영원히 빈다)
   *   - 필지가 평평하고 한 청크 안에 들어가야 한다 (growth.ts 와 같은 조건)
   *
   * 밀도는 도심에서 멀어질수록 낮아지고, 어디서든 일부는 빈터로 남긴다.
   * 그 빈터가 시뮬레이션이 앞으로 자랄 자리다.
   */
  private placeBuildings(): void {
    const maxR = CITY_RADIUS * 0.95;
    for (let y = EDGE; y < SPAN - EDGE; y++) {
      for (let x = EDGE; x < SPAN - EDGE; x++) {
        const tx = this.ox + x;
        const ty = this.oy + y;
        const build = this.world.getBuild(tx, ty);
        const zone = zoneOfBuildId(build);
        if (zone < 0) continue;
        if (this.world.getBld(tx, ty) !== BLD_NONE) continue;

        const far = Math.min(1, Math.hypot(x - this.cx, y - this.cy) / maxR);
        const intensity = 1 - far;
        const roll = this.rnd(x, y, 91);
        // 빈터 비율. 도심은 촘촘하고 변두리는 듬성듬성하다.
        if (roll > 0.55 + intensity * 0.35) continue;

        const pick = this.rnd(x, y, 92);
        let level: number;
        if (intensity > 0.72) level = pick < 0.45 ? 3 : 2;
        else if (intensity > 0.45) level = pick < 0.2 ? 3 : pick < 0.72 ? 2 : 1;
        else level = pick < 0.28 ? 2 : 1;
        // 공업은 부지가 크다. 3단계 공장이 도시 외곽에 서는 게 자연스럽다.
        if (zone === ZONE_I && intensity < 0.5 && pick > 0.6) level = 3;

        for (let l = level; l >= 1; l--) {
          if (!this.plotFits(x, y, l, build)) continue;
          this.world.placeBuilding(tx, ty, zone, l, this.bornDay);
          break;
        }
      }
    }
  }

  /** growth.ts 의 부지 조건 + "도로에 맞닿아야 한다" 를 함께 본다. */
  private plotFits(x: number, y: number, span: number, build: number): boolean {
    const tx = this.ox + x;
    const ty = this.oy + y;
    if (localIndexOf(tx) + span > CHUNK_SIZE) return false;
    if (localIndexOf(ty) + span > CHUNK_SIZE) return false;
    const h = this.hgt[this.idx(x, y)];
    for (let dy = 0; dy < span; dy++) {
      for (let dx = 0; dx < span; dx++) {
        const j = this.idx(x + dx, y + dy);
        if (!this.land[j] || this.hgt[j] !== h) return false;
        if (this.world.getBuild(tx + dx, ty + dy) !== build) return false;
        if (this.world.getBld(tx + dx, ty + dy) !== BLD_NONE) return false;
      }
    }
    return touchesRoadTiles(this.world, tx, ty, span);
  }
}

/* ---------------------------------------------------------------- *
 * 작은 도우미
 * ---------------------------------------------------------------- */

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function mod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

/** Build.ZoneR/C/I -> ZONE_R/C/I. 지구가 아니면 -1. */
function zoneOfBuildId(build: number): number {
  if (build === Build.ZoneR) return ZONE_R;
  if (build === Build.ZoneC) return ZONE_C;
  if (build === Build.ZoneI) return ZONE_I;
  return -1;
}

/**
 * A* 용 최소 힙. 값이 갱신될 때 예전 항목을 지우지 않고 그냥 하나 더 넣는다
 * (lazy deletion) — 꺼낸 뒤 비용이 안 맞으면 무시하면 되고, 그게 훨씬 싸다.
 */
class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(p, i);
      i = p;
    }
  }

  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop() as number;
    const lastKey = this.keys.pop() as number;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.items.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(m, i);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const ti = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = ti;
    const tk = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = tk;
  }
}
