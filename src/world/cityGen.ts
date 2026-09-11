import { BASE_CHUNK_SPAN, CHUNK_SIZE } from '../core/constants';
import { localIndexOf } from '../core/iso';
import { BLD_NONE, ZONE_C, ZONE_I, ZONE_R } from '../sim/buildings';
import { JOB_CAPACITY_C, JOB_CAPACITY_I, RESIDENT_CAPACITY } from '../sim/buildings';
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
import { ServiceField } from '../sim/services';
import { Build, canConnectRoads, canPlaceRoad, DIRS } from './build';
import { isWater } from './terrain';
import type { World } from './world';
import { seedCityUtilities } from './cityUtilities';
import { deriveSeed, randomCitySeed, Rng } from './rng';

/**
 * 대도시 생성기 (다시 만든 판).
 *
 * ---------------------------------------------------------------
 * 예전 생성기가 무엇을 틀렸는가
 * ---------------------------------------------------------------
 * 1. **영역과 반경이 어긋났다.** 기본 도시는 2x2 청크(128타일)인데 생성기는
 *    반경 70짜리 도시를 그렸다. 지름 140 > 128 이라 구역 씨앗의 절반이 영역
 *    밖으로 나가 버려지고, 남은 쪽으로 도시가 쏠렸다. 도심이 (91,103) 같은
 *    구석에 서는 도시가 그래서 나왔다.
 * 2. **도로 연결을 나중에 추측했다.** 도로를 "맞닿음" 기준으로 깔아 놓고,
 *    다 깐 다음 주변 도로의 진행축을 재서 연결 비트를 만들었다. 그런데 도심
 *    연결 검사(pruneDisconnected)는 그 전에 맞닿음 그래프로 했다. 두 그래프가
 *    다르니 **실제로는 도심과 끊긴 도로 덩어리가 그대로 남았다** — 측정해 보면
 *    도로망이 최대 5조각으로 갈라지고 33%가 도심에서 못 간다.
 * 3. **용도 비율이 지형 운에 맡겨졌다.** 구역 종류를 각도로 배정하고 지형이
 *    자르는 대로 뒀더니 도시 0 은 R/C/I = 3452/395/37 (일자리/필요 0.21,
 *    실업률 79%), 도시 4 는 반대로 2.45 가 나왔다.
 * 4. **시설을 정원이 아니라 고정 격자로 깔았다.** 182채가 서고 유지비가 수입을
 *    넘어(18,445 vs 23,233) 도시가 첫날부터 적자였다.
 * 5. **매번 같은 도시가 나왔다.** 난수가 전부 좌표 해시라 "맵 초기화" 를 눌러도
 *    결과가 한 글자도 안 바뀌었다.
 *
 * ---------------------------------------------------------------
 * 다시 만든 원칙
 * ---------------------------------------------------------------
 * - **경계는 계산이 아니라 규칙이다.** 모든 쓰기는 `inside()` 를 통과한 좌표에만
 *   일어난다. 도시는 2x2 청크를 절대 넘지 않는다.
 * - **도로망은 추측하지 않고 만든다.** 후보 도로에서 도심을 뿌리로 하는 연결
 *   그래프를 직접 키우고, 그 그래프에 못 들어온 후보는 아예 놓지 않는다.
 *   간선(edge)을 받아들일 때마다 build.ts 의 비탈 규칙을 그 자리에서 검사하므로
 *   "놓고 나서 고치는" 단계가 없다. 결과는 **항상 한 덩어리, 항상 규칙에 맞는**
 *   도로망이다.
 * - **용도 비율은 목표에서 거꾸로 잡는다.** 시뮬레이션의 균형식
 *   (RESIDENTS_PER_JOB, SHOP_JOBS_PER_RESIDENT)에서 나오는 정원비를 타일수로
 *   바꿔 할당량을 정하고, 지구를 그 할당량까지만 키운다.
 * - **시설 수는 정원에서 나온다.** 소방서 정원 220채, 경찰 3,000명 …에 실제
 *   건물/인구를 나눠서 필요한 만큼만 짓는다.
 * - **씨앗 하나로 굴러간다.** 씨앗이 다르면 도시가 다르고, 같으면 똑같이 다시
 *   만들어진다.
 */

/** 도시 기본 영역 한 변(타일). 2x2 청크 = 128. */
const SPAN = BASE_CHUNK_SPAN * CHUNK_SIZE;
/** 영역 가장자리 여유. 도로·지구·건물 어느 것도 여기를 넘지 않는다. */
const EDGE = 4;

/** 구역(섹션) 종류. */
const K_DOWNTOWN = 0;
const K_SUBCENTER = 1;
const K_RESIDENTIAL = 2;
const K_INDUSTRIAL = 3;

/**
 * 용도별 타일 할당 비율.
 *
 * 취향이 아니라 sim/config/macro.ts 에서 역산한 값이다.
 *   일자리 정원 = 주거 정원 / RESIDENTS_PER_JOB(1.35)
 *   상업 정원   = 인구 x SHOP_JOBS_PER_RESIDENT(0.18)
 * 이므로 정원비는 R : C : I = 1 : 0.18 : 0.56 이다. 타일당 평균 정원
 * (주거 11, 상업 8.5, 공업 13, 계층이 섞인 도시 기준)으로 나누면 타일비가
 * 1 : 0.23 : 0.47 = 58.6% : 13.6% : 27.8% 가 나온다.
 */
const ZONE_SHARE_C = 0.145;
const ZONE_SHARE_I = 0.21;

/** 공업 혐오(INDUSTRY_NUISANCE_RADIUS=6)를 완충하는 상업 띠의 두께. */
const INDUSTRY_BUFFER = 3;

/** 지구를 칠하는 도로로부터의 최대 거리. 3 이면 3x3 공장까지 들어간다. */
const ZONE_DEPTH = 3;

/**
 * 목표 평균 복지 점수.
 *
 * AMENITY_NEED_BY_TIER 는 저소득 0.35 / 중산층 0.9 / 고소득 1.8 이다. 1.3 이면
 * 아래 두 계층은 완전히 채우고 고소득도 7할을 채운다(모자란 만큼의 감점은
 * AMENITY_GAP_MAX 0.24 의 3할, 즉 0.07). 1.8 까지 채우려면 공원이 배로 필요한데
 * 그 유지비가 만족도 이득보다 크다.
 */
const AMENITY_TARGET = 1.3;

/** 서비스가 안 닿아도 넘어가는 건물 비율. 이 밑으로는 한 채 더 짓는 게 손해다. */
const SERVICE_GAP_TOLERANCE = 0.03;
/** 빈 곳 메우기를 시도하는 횟수. 한 번에 종류마다 한 채씩 는다. */
const SERVICE_TOPUP_ROUNDS = 4;

/**
 * A* 가 한 번 꺾을 때 무는 값(타일 환산).
 *
 * 3 이면 "세 칸 이상 아낄 때만 꺾는다" 는 뜻이다. 평지에서는 사실상 직진만
 * 하고, 물가와 언덕에서만 휜다.
 */
const TURN_COST = 3;
/** 길찾기 비용에 섞는 잡음. 완전히 같은 두 경로를 갈라놓을 정도만 남긴다. */
const ROUTE_GRAIN = 0.15;
/** 이보다 짧은 이면도로 토막은 놓지 않는다. 짧은 토막은 전부 막다른 길이 된다. */
const MIN_STREET_RUN = 6;
/** 이 길이 이하의 막다른 꼬투리는 걷어낸다. 그 이상은 골목 막다른 길로 남긴다. */
const MAX_STUB_LENGTH = 2;
/** 한 칸을 품는 2x2 네 개의 왼쪽 위 모서리. */
const CORNER_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-1, 0],
  [0, -1],
  [-1, -1],
];

/** 도로 후보의 우선순위. 낮을수록 먼저 연결 그래프에 들어간다. */
const PRIO_ARTERIAL = 0;
const PRIO_LOCAL = 1;

interface Section {
  x: number;
  y: number;
  kind: number;
  /** 0 = 도심, 1 = 안쪽 고리, 2 = 바깥 고리. */
  ring: number;
  /** 블록 한 변(도로 간격). 두 값이 다르면 긴 블록이 된다. */
  blockW: number;
  blockH: number;
  /** 격자 위상. 구역마다 달라서 경계에서 길이 어긋난다. */
  phaseX: number;
  phaseY: number;
  /** 이 구역이 뻗는 거리(타일). */
  reach: number;
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
  /** 이 도시를 만든 씨앗. 저장해 두면 같은 도시를 다시 만들 수 있다. */
  seed: number;
}

/** 씨앗을 안 주면 도시 위치에서 만든다. 같은 학생은 처음 한 번 같은 도시를 받는다. */
function defaultSeed(world: World): number {
  return deriveSeed((world.baseCx * 7919 + world.baseCy * 104729) | 0, 0x5c17);
}

/**
 * 아직 아무것도 안 지어진 도시에만 큰 도시를 심는다.
 * 저장된 도로/지구가 하나라도 있으면 절대 손대지 않는다.
 */
export function seedCityIfEmpty(world: World, bornDay = 0, seed?: number): SeededCity | null {
  if (world.developedParcels().length > 0) return null;
  return generateCity(world, bornDay, seed);
}

/** 조건 없이 새로 만든다. "맵 초기화" 버튼이 부른다. */
export function generateCity(world: World, bornDay = 0, seed?: number): SeededCity | null {
  const actual = seed === undefined ? defaultSeed(world) : seed >>> 0;
  const center = new CityBuilder(world, bornDay, actual).run();
  if (!center) return null;
  seedCityUtilities(world, bornDay, actual);
  // 시설이 들어서면서 헐린 건물 자리에 도로와 안 닿는 지구 칸이 남는다.
  // 도시가 완전히 선 뒤에 한 번에 거둬들인다.
  trimUnbuildableZones(world);
  return center;
}

/**
 * 영원히 쓸 수 없는 지구 칸을 거둬들인다.
 *
 * growth.ts 의 신축은 **1x1 부지 검사를 먼저 통과한 칸만** 후보로 쓴다
 * (buildPass -> plotFits(...,1,...)). 즉 도로에 직접 맞닿지 않은 빈 지구 칸은
 * 이미 선 건물의 몸통이 아닌 한 영원히 빈 땅이다. 예전 생성기는 그런 칸을
 * 지구 타일의 34%나 남겼다 — 화면에는 "도로 없음" 빗금으로 보이고, 도시 패널의
 * 공실률에도 계속 잡히는 죽은 땅이다.
 */
function trimUnbuildableZones(world: World): void {
  const ox = world.baseCx * CHUNK_SIZE;
  const oy = world.baseCy * CHUNK_SIZE;
  for (let y = 0; y < SPAN; y++) {
    for (let x = 0; x < SPAN; x++) {
      const tx = ox + x;
      const ty = oy + y;
      if (zoneOfBuildId(world.getBuild(tx, ty)) < 0) continue;
      if (world.getBld(tx, ty) !== BLD_NONE) continue;
      if (world.buildingCovering(tx, ty)) continue;
      if (touchesRoadTiles(world, tx, ty, 1)) continue;
      world.setBuild(tx, ty, Build.None, false);
    }
  }
}

/** "맵 초기화" 가 쓰는 새 씨앗. */
export { randomCitySeed };

class CityBuilder {
  private ox: number;
  private oy: number;

  private land = new Uint8Array(SPAN * SPAN);
  private hgt = new Uint8Array(SPAN * SPAN);
  /** 도로 후보와 그 우선순위. 255 = 후보 아님. */
  private cand = new Uint8Array(SPAN * SPAN).fill(255);
  /** 실제로 놓기로 확정한 도로. */
  private road = new Uint8Array(SPAN * SPAN);
  /** 확정한 도로 간선. 방향 d 로 연결됨을 뜻하는 비트. */
  private links = new Uint8Array(SPAN * SPAN);
  /** 비탈 간선만 모은 비트. 비탈 규칙 검사에 쓴다. */
  private slopeBits = new Uint8Array(SPAN * SPAN);
  /** 이 칸이 속한 섹션 번호. -1 은 도시 밖. */
  private owner = new Int16Array(SPAN * SPAN).fill(-1);
  /** 도로에서의 거리(0 = 도로, 255 = 멀거나 도달 불가). */
  private roadDist = new Uint8Array(SPAN * SPAN).fill(255);

  private sections: Section[] = [];
  private cx = 0;
  private cy = 0;
  private rng: Rng;

  constructor(
    private world: World,
    private bornDay: number,
    private seed: number,
  ) {
    this.ox = world.baseCx * CHUNK_SIZE;
    this.oy = world.baseCy * CHUNK_SIZE;
    this.rng = new Rng(seed);
  }

  run(): SeededCity | null {
    this.readTerrain();
    if (!this.chooseCore()) return null;
    this.placeSections();
    this.planArterials();
    this.planLocalStreets();
    this.growRoadNetwork();
    if (!this.commitRoads()) return null;
    this.measureRoadDistance();
    this.assignSections();
    this.paintZones();
    this.placeBuildings();
    this.placeServiceFacilities();
    return { tx: this.ox + this.cx, ty: this.oy + this.cy, seed: this.seed };
  }

  /* ---------------- 좌표 도우미 ---------------- */

  private idx(x: number, y: number): number {
    return y * SPAN + x;
  }

  /** 도시가 쓸 수 있는 유일한 범위. 여기를 벗어난 좌표에는 아무것도 쓰지 않는다. */
  private inside(x: number, y: number): boolean {
    return x >= EDGE && y >= EDGE && x < SPAN - EDGE && y < SPAN - EDGE;
  }

  /**
   * 0~1 사이의 부드러운 잡음. 격자 간격 `cell` 타일마다 값을 뽑고 사이를 부드럽게 잇는다.
   * 구역 경계를 구불구불하게 만들고, 길찾기 비용에 결을 넣는 데 쓴다.
   */
  private makeNoise(cell: number, salt: number): (x: number, y: number) => number {
    const rng = new Rng(deriveSeed(this.seed, salt));
    const size = Math.ceil(SPAN / cell) + 2;
    const grid = new Float32Array(size * size);
    for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
    const at = (gx: number, gy: number): number =>
      grid[Math.min(size - 1, Math.max(0, gy)) * size + Math.min(size - 1, Math.max(0, gx))];
    return (x, y) => {
      const gx = Math.floor(x / cell);
      const gy = Math.floor(y / cell);
      const fx = smooth(x / cell - gx);
      const fy = smooth(y / cell - gy);
      const a = at(gx, gy);
      const b = at(gx + 1, gy);
      const c = at(gx, gy + 1);
      const d = at(gx + 1, gy + 1);
      return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
    };
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
   *
   * 예전과 달리 **탐색 범위를 영역의 가운데 30%로 묶는다.** 도심이 구석에 서면
   * 구역 고리의 한쪽이 통째로 영역 밖으로 나가고, 그 절반이 버려진다.
   */
  private chooseCore(): boolean {
    const lo = Math.floor(SPAN * 0.35);
    const hi = Math.ceil(SPAN * 0.65);
    let best = -1;
    for (let y = lo; y <= hi; y += 2) {
      for (let x = lo; x <= hi; x += 2) {
        const i = this.idx(x, y);
        if (!this.land[i]) continue;
        const h = this.hgt[i];
        let open = 0;
        let flat = 0;
        for (let dy = -12; dy <= 12; dy += 3) {
          for (let dx = -12; dx <= 12; dx += 3) {
            const nx = x + dx;
            const ny = y + dy;
            if (!this.inside(nx, ny)) continue;
            const j = this.idx(nx, ny);
            if (!this.land[j]) continue;
            open++;
            if (this.hgt[j] === h) flat++;
          }
        }
        const pull = Math.hypot(x - SPAN / 2, y - SPAN / 2) * 0.2;
        // 흔들기: 씨앗이 다르면 같은 지형에서도 도심이 조금씩 옮겨 앉는다.
        const jitter = this.rng.range(-2.5, 2.5);
        const score = open + flat * 0.7 - pull + jitter;
        if (score > best) {
          best = score;
          this.cx = x;
          this.cy = y;
        }
      }
    }
    return best > 0;
  }

  /* ---------------- 3. 섹션(구역) ---------------- */

  /**
   * 도심 + 안쪽 고리 + 바깥 고리.
   *
   * 고리 반지름은 영역 크기에서 잡는다. 바깥 고리(0.30 x SPAN = 38)에 구역
   * 반경(최대 18)을 더해도 56 이라 도심이 영역 가운데 30% 안에 있는 한 도시
   * 전체가 2x2 안에 들어온다.
   */
  private placeSections(): void {
    this.pushSection(this.cx, this.cy, K_DOWNTOWN, 0, 15);

    // 안쪽 고리 — 부도심과 오래된 주거지가 도심을 둘러싼다.
    const inner = 4;
    const innerSpin = this.rng.next() * Math.PI * 2;
    const subAt = this.rng.int(inner);
    for (let i = 0; i < inner; i++) {
      const a = innerSpin + (i / inner) * Math.PI * 2 + this.rng.range(-0.28, 0.28);
      const r = SPAN * this.rng.range(0.15, 0.19);
      const kind = i === subAt || i === (subAt + 2) % inner ? K_SUBCENTER : K_RESIDENTIAL;
      this.pushSection(
        Math.round(this.cx + Math.cos(a) * r),
        Math.round(this.cy + Math.sin(a) * r * 0.92),
        kind,
        1,
        14,
      );
    }

    // 바깥 고리 — 신도시 주거와 공업지대.
    // 공업은 **서로 붙여서 한쪽에 몰아 놓는다.** 청크 단위 공업 혐오
    // (macro.updateNuisance)는 흩어 놓으나 몰아 놓으나 총량이 같지만, 몰아
    // 놓아야 주거지와 상업 완충대를 사이에 둘 수 있다.
    const outer = 6;
    const outerSpin = this.rng.next() * Math.PI * 2;
    const indAt = this.rng.int(outer);
    for (let i = 0; i < outer; i++) {
      const a = outerSpin + ((i + 0.5) / outer) * Math.PI * 2 + this.rng.range(-0.2, 0.2);
      const r = SPAN * this.rng.range(0.27, 0.32);
      const industrial = i === indAt || i === (indAt + 1) % outer;
      this.pushSection(
        Math.round(this.cx + Math.cos(a) * r),
        Math.round(this.cy + Math.sin(a) * r * 0.92),
        industrial ? K_INDUSTRIAL : K_RESIDENTIAL,
        2,
        industrial ? 16 : 17,
      );
    }
  }

  /** 물이나 영역 밖이면 가까운 뭍으로 끌어당긴다. 못 찾으면 그 섹션은 버린다. */
  private pushSection(x: number, y: number, kind: number, ring: number, reach: number): void {
    const spot = this.nearestLand(x, y, 16);
    if (!spot) return;
    // 이미 있는 섹션과 너무 붙으면 버린다. 붙어 있으면 격자가 서로를 갉아먹는다.
    for (const s of this.sections) {
      if (Math.hypot(s.x - spot.x, s.y - spot.y) < 10) return;
    }
    let bw: number;
    let bh: number;
    /*
     * 블록 한 변은 4 아래로 내리지 않는다. 도로 사이 속살이 세 칸은 돼야 3x3
     * 건물이 들어간다(ZONE_DEPTH).
     *
     * 나란한 차선을 없애면서 도로가 23% 줄었고, 그만큼 한 칸당 통행량이 올라
     * 혼잡 감점이 커졌다(0.13~0.15). 블록을 한 칸씩 줄여 도로를 되돌린다.
     * 직선 격자라서 칸이 작아져도 화면이 복잡해지지는 않는다.
     */
    if (kind === K_DOWNTOWN) {
      bw = this.rng.between(4, 4);
      bh = this.rng.between(4, 5);
    } else if (kind === K_SUBCENTER) {
      bw = this.rng.between(4, 5);
      bh = this.rng.between(4, 6);
    } else if (kind === K_INDUSTRIAL) {
      // 공장 부지는 깊다. 한 변을 길게 잡아 3x3 공장이 들어갈 속살을 만든다.
      bw = this.rng.between(5, 6);
      bh = this.rng.between(6, 7);
    } else {
      bw = this.rng.between(4, 5);
      bh = this.rng.between(5, 7);
    }
    // 절반은 결을 90도 돌린다. 이웃 구역과 격자 방향이 어긋나야 도시가
    // 한 장의 모눈종이처럼 보이지 않는다.
    if (this.rng.chance(0.5)) {
      const t = bw;
      bw = bh;
      bh = t;
    }
    this.sections.push({
      x: spot.x,
      y: spot.y,
      kind,
      ring,
      blockW: bw,
      blockH: bh,
      phaseX: this.rng.int(bw),
      phaseY: this.rng.int(bh),
      reach,
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

  /* ---------------- 4. 간선도로 ---------------- */

  /**
   * 섹션을 잇는 뼈대.
   *
   * 예전 생성기는 간선을 2칸 폭으로 넓혔다. 이 게임의 도로는 한 칸이 이미
   * 양방향이고 나란한 두 줄은 서로 연결되지 않으므로, 2칸 폭은 통행량을
   * 늘리지 못하면서 유지비와 "왜 안 이어지지?" 만 늘린다. 그래서 한 칸으로 깐다.
   */
  private planArterials(): void {
    const hub = this.sections[0];
    if (!hub) return;
    const inner = this.sections.filter((s) => s.ring === 1);
    const outer = this.sections.filter((s) => s.ring === 2);
    const grain = this.makeNoise(18, 0x91);

    for (const s of inner) this.stamp(this.route(hub, s, grain));
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
      this.stamp(this.route(near, s, grain));
    }

    // 순환도로. 고리를 한 바퀴 잇되 한두 구간은 일부러 빼먹는다
    // (실제 도시의 순환도로도 대개 미완성이다).
    for (let i = 0; i < inner.length; i++) {
      if (this.rng.chance(0.18)) continue;
      this.stamp(this.route(inner[i], inner[(i + 1) % inner.length], grain));
    }
    for (let i = 0; i < outer.length; i++) {
      if (this.rng.chance(0.32)) continue;
      this.stamp(this.route(outer[i], outer[(i + 1) % outer.length], grain));
    }
  }

  /**
   * A* 길찾기.
   *
   * **한 걸음의 고도차가 1을 넘으면 아예 밟지 않는다.** build.ts 의
   * canConnectRoads 가 그 연결을 거부하기 때문이다. 예전 생성기는 이 조건을
   * 계획에 넣지 않아서, 절벽을 가로지르는 길을 그려 놓고 나중에 그 칸만 지웠다.
   * 지워진 자리에서 길이 끊기고, 끊긴 뒤쪽이 도심에서 갈 수 없는 섬이 됐다.
   */
  private route(a: Section, b: Section, grain: (x: number, y: number) => number): number[] {
    /*
     * 상태가 **칸이 아니라 (칸, 들어온 방향)** 이다.
     *
     * 칸만 상태로 쓰면 꺾는 데 값이 안 붙어서, 평지에서도 길이 잡음을 따라
     * 하늘하늘 휜다. 실제로 그렇게 나온 도시는 직선이면 될 자리까지 전부
     * 구불구불했다(코너 82~111개, 예전 생성기는 15~47개).
     *
     * 방향을 상태에 넣으면 "꺾으면 TURN_COST 만큼 비싸다" 를 정확히 표현할 수
     * 있다. 그래서 길은 **기본적으로 직진하고**, 물·절벽을 피하거나 TURN_COST
     * 이상을 아낄 때만 꺾는다. 상태가 네 배로 늘지만 128x128x4 라 가볍다.
     */
    const size = SPAN * SPAN;
    const cost = new Float32Array(size * 4).fill(Infinity);
    const prev = new Int32Array(size * 4).fill(-1);
    const heap = new MinHeap();
    const start = this.idx(a.x, a.y);
    // 출발 칸은 어느 방향으로 나가든 공짜다.
    for (let d = 0; d < 4; d++) {
      cost[start * 4 + d] = 0;
      heap.push(start * 4 + d, 0);
    }

    const goal = this.idx(b.x, b.y);
    let best = -1;
    let bestCost = Infinity;
    let guard = 0;
    while (heap.size > 0 && guard++ < 400_000) {
      const state = heap.pop();
      const cur = state >> 2;
      const from = state & 3;
      const base = cost[state];
      if (base > bestCost) break;
      if (cur === goal) {
        if (base < bestCost) {
          bestCost = base;
          best = state;
        }
        continue;
      }
      const cx = cur % SPAN;
      const cy = (cur / SPAN) | 0;
      const ch = this.hgt[cur];
      for (let d = 0; d < 4; d++) {
        const nx = cx + DIRS[d][0];
        const ny = cy + DIRS[d][1];
        if (!this.inside(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (!this.land[ni]) continue;
        const climb = Math.abs(this.hgt[ni] - ch);
        if (climb > 1) continue; // 절벽은 도로가 될 수 없다
        // 이미 깔린 길 위를 지나가면 싸다. 간선이 하나로 모여 큰길이 된다.
        const reuse = this.cand[ni] !== 255 ? 0.3 : 1;
        const turn = d === from ? 0 : TURN_COST;
        const next = base + reuse + climb * 2.6 + turn + grain(nx, ny) * ROUTE_GRAIN;
        const ns = ni * 4 + d;
        if (next >= cost[ns]) continue;
        cost[ns] = next;
        prev[ns] = state;
        heap.push(ns, next + (Math.abs(nx - b.x) + Math.abs(ny - b.y)) * 0.9);
      }
    }
    if (best < 0) return [];

    const path: number[] = [];
    for (let s = best; s !== -1; s = prev[s]) path.push(s >> 2);
    return path.reverse();
  }

  private stamp(path: readonly number[]): void {
    for (const i of path) this.cand[i] = PRIO_ARTERIAL;
  }

  /* ---------------- 5. 이면도로 ---------------- */

  /**
   * 섹션마다 자기 격자를 깐다. 선을 끝까지 긋지 않고 **섹션 반경 안에 있는
   * 동안만** 긋는다. 그래서 물가·언덕·구역 경계에서 길이 자연스럽게 끊기고,
   * 구역마다 격자의 방향과 위상이 달라 도시 전체가 한 장의 모눈이 되지 않는다.
   */
  private planLocalStreets(): void {
    const wobble = this.makeNoise(22, 0x33);
    for (let s = 0; s < this.sections.length; s++) {
      const sec = this.sections[s];
      const x0 = Math.max(EDGE, sec.x - sec.reach);
      const x1 = Math.min(SPAN - EDGE - 1, sec.x + sec.reach);
      const y0 = Math.max(EDGE, sec.y - sec.reach);
      const y1 = Math.min(SPAN - EDGE - 1, sec.y + sec.reach);
      const belongs = (x: number, y: number): boolean => {
        if (!this.inside(x, y) || !this.land[this.idx(x, y)]) return false;
        // 반경을 잡음으로 흔들어 구역 윤곽을 둥근 원이 아니게 만든다.
        const limit = sec.reach * (0.78 + wobble(x, y) * 0.42);
        return Math.hypot(x - sec.x, y - sec.y) <= limit;
      };

      for (let y = y0; y <= y1; y++) {
        if (mod(y - sec.phaseY, sec.blockH) !== 0) continue;
        this.runLine(belongs, x0, x1, y, true);
      }
      for (let x = x0; x <= x1; x++) {
        if (mod(x - sec.phaseX, sec.blockW) !== 0) continue;
        this.runLine(belongs, y0, y1, x, false);
      }
    }
  }

  /**
   * 선 하나를 긋는다. 구역 안에 있는 구간(run)만 남기고, 짧은 토막은 버린다.
   * 가끔 한쪽 끝을 잘라 막다른 길을 만들고, 가끔 도중에 한 칸 어긋나게 꺾는다.
   */
  private runLine(
    belongs: (x: number, y: number) => boolean,
    from: number,
    to: number,
    fixed: number,
    horizontal: boolean,
  ): void {
    let run: number[] = [];
    const flush = (): void => {
      if (run.length >= MIN_STREET_RUN) {
        // 막다른 길: 가끔 끝을 한두 칸 자른다. 예전에는 확률도 길이도 컸는데,
        // 잘린 끝이 전부 막다른 길이 되어 도시에 380개씩 쌓였다.
        const cut = this.rng.chance(0.08) ? this.rng.between(1, 2) : 0;
        for (let k = 0; k < run.length - cut; k++) {
          if (this.cand[run[k]] === 255) this.cand[run[k]] = PRIO_LOCAL;
        }
      }
      run = [];
    };

    /*
     * **선은 곧게 긋는다.**
     *
     * 예전에는 칸마다 3% 확률로 한 칸씩 어긋나게 해서 "기계 같지 않은" 결을
     * 노렸다. 그런데 그 어긋남이 누적되어 골목마다 지그재그가 생기고, 옆줄까지
     * 흘러가 나란한 두 줄을 만들기도 했다. 도시가 기계처럼 보이지 않게 하는
     * 일은 구역마다 다른 블록 크기·위상·방향이 이미 하고 있다.
     */
    for (let p = from; p <= to; p++) {
      const x = horizontal ? p : fixed;
      const y = horizontal ? fixed : p;
      if (!belongs(x, y)) {
        flush();
        continue;
      }
      run.push(this.idx(x, y));
    }
    flush();
  }

  /* ---------------- 6. 도로망 만들기 ---------------- */

  /**
   * 도로망의 핵심. **연결 그래프를 직접 키운다.**
   *
   * 도심에서 시작해서 후보 도로를 하나씩 붙여 나간다. 간선(두 칸 사이의 연결)을
   * 붙일 때마다 build.ts 의 두 규칙을 그 자리에서 검사한다.
   *
   *   - 두 칸의 고도차가 1 이하일 것
   *   - 한 칸이 여러 방향으로 비탈지지 않을 것 (마주 보는 두 방향은 허용)
   *
   * 검사를 통과한 간선만 받아들이고, 이 그래프에 끝내 들어오지 못한 후보는
   * **놓지 않는다.** 그래서 완성된 도로망은 정의상
   *   (1) 도심에서 전부 도달 가능하고
   *   (2) 모든 연결이 규칙을 만족하며
   *   (3) 고립된 도로 조각이 하나도 없다.
   *
   * 여기에 규칙이 하나 더 있다 — **나란한 두 차선을 애초에 만들지 않는다.**
   * 자세한 것은 wouldBlock 주석에 있다.
   *
   * 간선 후보를 우선순위 버킷으로 처리한다. 간선도로를 먼저 받아들여야 비탈
   * 규칙이 뼈대가 아니라 골목 쪽에서 걸리고, 나란한 두 줄 중 살아남는 쪽도
   * 골목이 아니라 간선이 된다.
   */
  private growRoadNetwork(): void {
    const start = this.nearestCandidate(this.cx, this.cy);
    if (start < 0) return;

    // 버킷 0 = 간선, 1 = 이면도로. 같은 버킷 안은 먼저 닿은 순서(BFS).
    const buckets: number[][] = [[], []];
    this.road[start] = 1;
    buckets[this.cand[start] === PRIO_ARTERIAL ? 0 : 1].push(start);

    for (let b = 0; b < buckets.length; b++) {
      for (let head = 0; head < buckets[b].length; head++) {
        const cur = buckets[b][head];
        const x = cur % SPAN;
        const y = (cur / SPAN) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = x + DIRS[d][0];
          const ny = y + DIRS[d][1];
          if (!this.inside(nx, ny)) continue;
          const ni = this.idx(nx, ny);
          if (this.cand[ni] === 255) continue;
          if (this.links[cur] & (1 << d)) continue;
          if (!this.road[ni] && this.wouldBlock(nx, ny)) continue;
          if (!this.acceptEdge(cur, ni, d)) continue;
          if (this.road[ni]) continue;
          this.road[ni] = 1;
          const prio = this.cand[ni] === PRIO_ARTERIAL ? 0 : 1;
          buckets[Math.max(prio, b)].push(ni);
        }
      }
    }

    this.trimStubs();

    // 뼈대가 다 선 뒤에 남은 맞닿음을 **전부** 이어 준다. 격자가 실제로 격자가
    // 되려면 교차로가 있어야 하는데, 위 통과는 "처음 닿은" 간선만 쓴다.
    //
    // 여기서 예외를 두지 않는 것이 중요하다. 나란한 두 차선은 wouldBlock 이
    // 애초에 못 생기게 막았으므로, 남은 맞닿음은 전부 이어야 할 교차로다.
    // 맞닿았는데 안 이어진 자리를 남기면 화면에 연석만 보이고, 학생은 "왜 여기가
    // 안 이어지지" 로 읽는다.
    for (let y = EDGE; y < SPAN - EDGE; y++) {
      for (let x = EDGE; x < SPAN - EDGE; x++) {
        const i = this.idx(x, y);
        if (!this.road[i]) continue;
        for (let d = 0; d < 2; d++) {
          const nx = x + DIRS[d][0];
          const ny = y + DIRS[d][1];
          if (!this.inside(nx, ny)) continue;
          const ni = this.idx(nx, ny);
          if (!this.road[ni] || this.links[i] & (1 << d)) continue;
          this.acceptEdge(i, ni, d);
        }
      }
    }
  }

  /**
   * 이 칸을 도로로 놓으면 **2x2 도로 덩어리** 가 생기는가.
   *
   * ---------------------------------------------------------------
   * 왜 막는가
   * ---------------------------------------------------------------
   * 2x2 덩어리는 곧 나란히 붙은 두 차선이다. 가로로 이으면 사다리가 되어 한
   * 덩어리 넓은 아스팔트로 보이고, 안 이으면 맞닿은 채 연석만 보이는 자리가
   * 된다. 둘 다 틀렸다. **애초에 만들지 않는 것** 이 답이다.
   *
   * 놓지 않은 칸 때문에 못 가는 곳이 생기지는 않는다. BFS 로 자라는 중이라
   * 이 칸을 거부해도 그 너머는 다른 길로 닿거나, 닿지 못하면 그건 원래 이
   * 중복 차선으로만 갈 수 있던 곳이다.
   *
   * ---------------------------------------------------------------
   * 왜 이렇게 판정하는가
   * ---------------------------------------------------------------
   * 예전 citySeed.ts 는 칸마다 앞뒤 7칸을 훑어 "이 도로의 주 진행축"을 추정하고
   * 양쪽이 모두 직각 축이면 연결을 끊었다. 그 방식은 **짧은 구간에서 무너진다**
   * — 두세 칸짜리 막다른 길이나 코너는 축을 정할 수가 없어서, 평행 차선인데
   * 이어 버리거나 반대로 멀쩡한 연결을 끊어 도로망을 조각냈다.
   *
   * 여기서는 축을 추정하지 않고 2x2 네 칸만 본다. 사거리·T자·계단식 꺾임에는
   * 2x2 가 생기지 않으므로 걸리지 않고, 길이가 판정에 전혀 안 들어가서 두
   * 칸짜리 평행 차선도 스무 칸짜리와 똑같이 잡힌다.
   */
  private wouldBlock(x: number, y: number): boolean {
    // 이 칸을 품는 2x2 네 개를 모두 본다. 나머지 세 칸이 전부 도로면 덩어리다.
    for (const [ox, oy] of CORNER_OFFSETS) {
      let filled = 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + ox + (k & 1);
        const ny = y + oy + (k >> 1);
        if (nx === x && ny === y) continue;
        if (!this.inside(nx, ny) || !this.road[this.idx(nx, ny)]) break;
        filled++;
      }
      if (filled === 3) return true;
    }
    return false;
  }

  /**
   * 한두 칸짜리 막다른 꼬투리를 걷어낸다.
   *
   * 지형·비탈 규칙·중복 차선 금지에 걸려 선이 잘리면 한 칸짜리 부스러기가
   * 남는다. 골목 막다른 길(cul-de-sac)은 도시다운 모습이지만 한두 칸짜리는
   * 화면만 지저분하게 만든다. MAX_STUB_LENGTH 보다 긴 막다른 길은 남긴다.
   */
  private trimStubs(): void {
    for (let pass = 0; pass < MAX_STUB_LENGTH; pass++) {
      let removed = 0;
      for (let y = EDGE; y < SPAN - EDGE; y++) {
        for (let x = EDGE; x < SPAN - EDGE; x++) {
          const i = this.idx(x, y);
          if (!this.road[i]) continue;
          let degree = 0;
          let only = -1;
          for (let d = 0; d < 4; d++) {
            if (!(this.links[i] & (1 << d))) continue;
            degree++;
            only = d;
          }
          if (degree !== 1) continue;
          this.road[i] = 0;
          this.links[i] = 0;
          this.slopeBits[i] = 0;
          const nx = x + DIRS[only][0];
          const ny = y + DIRS[only][1];
          const ni = this.idx(nx, ny);
          const back = (only + 2) & 3;
          this.links[ni] &= ~(1 << back);
          this.slopeBits[ni] &= ~(1 << back);
          removed++;
        }
      }
      if (removed === 0) break;
    }
  }

  /** 간선 하나를 규칙에 맞으면 받아들인다. */
  private acceptEdge(a: number, b: number, d: number): boolean {
    const back = (d + 2) & 3;
    const dh = this.hgt[b] - this.hgt[a];
    if (Math.abs(dh) > 1) return false;
    if (dh !== 0) {
      if (!slopeLegal(this.slopeBits[a] | (1 << d))) return false;
      if (!slopeLegal(this.slopeBits[b] | (1 << back))) return false;
      this.slopeBits[a] |= 1 << d;
      this.slopeBits[b] |= 1 << back;
    }
    this.links[a] |= 1 << d;
    this.links[b] |= 1 << back;
    return true;
  }

  private nearestCandidate(x: number, y: number): number {
    for (let r = 0; r < 48; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!this.inside(nx, ny)) continue;
          const i = this.idx(nx, ny);
          if (this.cand[i] !== 255) return i;
        }
      }
    }
    return -1;
  }

  /* ---------------- 7. 실제로 놓기 ---------------- */

  /**
   * 계획한 도로를 월드에 놓는다.
   *
   * 칸을 먼저 전부 놓고(고립 상태), 그다음 계획한 간선만 연다. 마지막 관문은
   * 계획 단계가 아니라 build.ts 한 곳(canPlaceRoad / canConnectRoads)이다 —
   * 학생이 직접 그린 도로와 완전히 같은 검사를 통과한 도로망만 남는다.
   */
  private commitRoads(): boolean {
    let placed = 0;
    for (let y = EDGE; y < SPAN - EDGE; y++) {
      for (let x = EDGE; x < SPAN - EDGE; x++) {
        const i = this.idx(x, y);
        if (!this.road[i]) continue;
        const tx = this.ox + x;
        const ty = this.oy + y;
        if (!canPlaceRoad(this.world, tx, ty).ok) {
          this.road[i] = 0;
          continue;
        }
        this.world.placeGeneratedRoad(tx, ty);
        placed++;
      }
    }
    if (placed === 0) return false;

    for (let y = EDGE; y < SPAN - EDGE; y++) {
      for (let x = EDGE; x < SPAN - EDGE; x++) {
        const i = this.idx(x, y);
        if (!this.road[i]) continue;
        for (let d = 0; d < 2; d++) {
          if (!(this.links[i] & (1 << d))) continue;
          const nx = x + DIRS[d][0];
          const ny = y + DIRS[d][1];
          if (!this.road[this.idx(nx, ny)]) continue;
          const ax = this.ox + x;
          const ay = this.oy + y;
          const bx = this.ox + nx;
          const by = this.oy + ny;
          if (!canConnectRoads(this.world, ax, ay, bx, by).ok) continue;
          this.world.connectRoads(ax, ay, bx, by, false);
        }
      }
    }

    return this.pruneUnreachable();
  }

  /**
   * 마지막 안전망.
   *
   * 위 단계가 맞다면 지울 것이 하나도 없어야 한다. 그래도 실제 월드의
   * `roadsConnected` 로 다시 훑어서 도심에서 못 가는 도로를 **철거한다.**
   * 생성기와 월드의 판정이 언젠가 어긋나더라도 "차가 못 가는 길"이 도시에
   * 남지 않게 하는 값싼 보험이다.
   */
  private pruneUnreachable(): boolean {
    let start = -1;
    for (let r = 0; r < 64 && start < 0; r++) {
      for (let dy = -r; dy <= r && start < 0; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const nx = this.cx + dx;
          const ny = this.cy + dy;
          if (!this.inside(nx, ny)) continue;
          if (this.road[this.idx(nx, ny)]) {
            start = this.idx(nx, ny);
            break;
          }
        }
      }
    }
    if (start < 0) return false;

    const seen = new Uint8Array(SPAN * SPAN);
    const queue: number[] = [start];
    seen[start] = 1;
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      const x = cur % SPAN;
      const y = (cur / SPAN) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.inside(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (seen[ni] || !this.road[ni]) continue;
        if (!this.world.roadsConnected(this.ox + x, this.oy + y, this.ox + nx, this.oy + ny))
          continue;
        seen[ni] = 1;
        queue.push(ni);
      }
    }

    for (let i = 0; i < this.road.length; i++) {
      if (!this.road[i] || seen[i]) continue;
      this.road[i] = 0;
      this.world.setBuild(this.ox + (i % SPAN), this.oy + ((i / SPAN) | 0), Build.None, false);
    }
    // 도심 자리를 실제 도로망 위로 옮겨 둔다. 첫 카메라가 길 위를 본다.
    this.cx = start % SPAN;
    this.cy = (start / SPAN) | 0;
    return true;
  }

  /* ---------------- 8. 도로에서의 거리 ---------------- */

  /** 지구를 칠할 수 있는 깊이까지만 재는 BFS. 도로 칸이 0 이다. */
  private measureRoadDistance(): void {
    const queue: number[] = [];
    for (let y = EDGE; y < SPAN - EDGE; y++) {
      for (let x = EDGE; x < SPAN - EDGE; x++) {
        const i = this.idx(x, y);
        if (!this.road[i]) continue;
        this.roadDist[i] = 0;
        queue.push(i);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      if (this.roadDist[cur] >= ZONE_DEPTH) continue;
      const x = cur % SPAN;
      const y = (cur / SPAN) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.inside(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (this.roadDist[ni] !== 255 || !this.land[ni]) continue;
        if (this.road[ni]) continue;
        this.roadDist[ni] = this.roadDist[cur] + 1;
        queue.push(ni);
      }
    }
  }

  /* ---------------- 9. 섹션 나누기 ---------------- */

  /**
   * 각 칸의 주인 섹션. 가장 가까운 씨앗이 주인이되 거리에 잡음을 곱해
   * 경계를 구불구불하게 만든다.
   */
  private assignSections(): void {
    if (!this.sections.length) return;
    const wobble = this.makeNoise(26, 0x71);
    for (let y = EDGE; y < SPAN - EDGE; y++) {
      for (let x = EDGE; x < SPAN - EDGE; x++) {
        const i = this.idx(x, y);
        if (this.roadDist[i] === 255) continue;
        const w = 0.8 + wobble(x, y) * 0.45;
        let bestD = Infinity;
        let best = -1;
        for (let s = 0; s < this.sections.length; s++) {
          const sec = this.sections[s];
          // 도심은 조금 더 넓게 잡는다. 실제 도시도 도심이 구역을 빨아들인다.
          const bias = sec.kind === K_DOWNTOWN ? 0.84 : 1;
          const d = Math.hypot(x - sec.x, y - sec.y) * w * bias;
          if (d < bestD) {
            bestD = d;
            best = s;
          }
        }
        this.owner[i] = best;
      }
    }
  }

  /* ---------------- 10. 지구 ---------------- */

  /**
   * 용도를 **할당량으로** 칠한다.
   *
   * 예전에는 칸마다 잡음을 굴려 용도를 정했다. 그러면 지형이 공업 구역을
   * 통째로 잘라먹었을 때 도시 전체에 일자리가 없어진다(실제로 도시 0 의
   * 공업 타일은 37칸이었다). 그래서 순서를 뒤집는다.
   *
   *   1. 칠할 수 있는 칸 N 을 센다
   *   2. 목표 비율로 공업 0.28N, 상업 0.14N 을 정한다
   *   3. 공업 씨앗에서 **할당량이 찰 때까지만** BFS 로 키운다
   *   4. 공업 둘레 세 칸을 상업 완충대로 바꾼다 (주거를 공장에서 떼어 놓는다)
   *   5. 도심·부도심에서 남은 상업 할당량을 키운다
   *   6. 나머지 전부 주거
   *
   * 지형이 어떻게 생겼든 비율은 항상 목표에 맞고, 공업은 항상 도시 한쪽에
   * 뭉쳐 있고, 주거와 공업 사이에는 항상 상업 띠가 있다.
   */
  private paintZones(): void {
    const zonable: number[] = [];
    for (let y = EDGE; y < SPAN - EDGE; y++) {
      for (let x = EDGE; x < SPAN - EDGE; x++) {
        const i = this.idx(x, y);
        const d = this.roadDist[i];
        if (d === 0 || d === 255) continue;
        if (this.owner[i] < 0) continue;
        if (this.world.getBuild(this.ox + x, this.oy + y) !== Build.None) continue;
        zonable.push(i);
      }
    }
    if (!zonable.length) return;

    const total = zonable.length;
    const quotaI = Math.round(total * ZONE_SHARE_I);
    const quotaC = Math.round(total * ZONE_SHARE_C);
    const zone = new Int8Array(SPAN * SPAN).fill(-1);
    for (const i of zonable) zone[i] = ZONE_R;

    // 3. 공업. 공업 섹션 씨앗에서 시작하는 다중 출발 BFS.
    const indSeeds: number[] = [];
    for (const sec of this.sections) {
      if (sec.kind !== K_INDUSTRIAL) continue;
      const spot = this.nearestZonable(sec.x, sec.y, zone);
      if (spot >= 0) indSeeds.push(spot);
    }
    const industrial = this.growZone(indSeeds, zone, quotaI, ZONE_I);

    // 4. 완충대. 공업에서 INDUSTRY_BUFFER 칸 안쪽의 주거를 상업으로 바꾼다.
    let usedC = 0;
    if (industrial.length) {
      const buffer = this.ringAround(industrial, zone, INDUSTRY_BUFFER);
      for (const i of buffer) {
        if (usedC >= quotaC) break;
        zone[i] = ZONE_C;
        usedC++;
      }
    }

    // 5. 도심·부도심 상업.
    const comSeeds: number[] = [];
    for (const sec of this.sections) {
      if (sec.kind !== K_DOWNTOWN && sec.kind !== K_SUBCENTER) continue;
      const spot = this.nearestZonable(sec.x, sec.y, zone);
      if (spot >= 0) comSeeds.push(spot);
    }
    usedC += this.growZone(comSeeds, zone, Math.max(0, quotaC - usedC), ZONE_C).length;

    // 남은 상업 할당량은 간선 길가에 흩뿌린다. 동네 가게다.
    if (usedC < quotaC) {
      const shops = this.rng.shuffle(
        zonable.filter((i) => zone[i] === ZONE_R && this.cand[i] === PRIO_ARTERIAL),
      );
      for (const i of shops) {
        if (usedC >= quotaC) break;
        zone[i] = ZONE_C;
        usedC++;
      }
    }

    const BUILD_OF = [Build.ZoneR, Build.ZoneC, Build.ZoneI];
    const green = this.makeNoise(5, 0x82);
    for (const i of zonable) {
      const z = zone[i];
      if (z < 0) continue;
      const x = i % SPAN;
      const y = (i / SPAN) | 0;
      // 일부는 일부러 비워 공터·녹지로 둔다. 시뮬레이션이 앞으로 자랄 자리다.
      if (z === ZONE_R && green(x, y) > 0.93) continue;
      this.world.setBuild(this.ox + x, this.oy + y, BUILD_OF[z], false);
    }
  }

  /** 다중 출발 BFS 로 한 용도를 할당량까지 키운다. 칠한 칸 목록을 돌려준다. */
  private growZone(
    seeds: readonly number[],
    zone: Int8Array,
    quota: number,
    value: number,
  ): number[] {
    const out: number[] = [];
    if (!seeds.length || quota <= 0) return out;
    const seen = new Uint8Array(SPAN * SPAN);
    const queue: number[] = [];
    for (const s of seeds) {
      if (seen[s]) continue;
      seen[s] = 1;
      queue.push(s);
    }
    for (let head = 0; head < queue.length && out.length < quota; head++) {
      const cur = queue[head];
      if (zone[cur] === ZONE_R) {
        zone[cur] = value;
        out.push(cur);
      }
      const x = cur % SPAN;
      const y = (cur / SPAN) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.inside(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (seen[ni]) continue;
        // 도로 칸은 건너뛰되 그 너머로 퍼진다. 길 하나가 지구를 갈라놓지 않는다.
        if (this.roadDist[ni] === 255) continue;
        seen[ni] = 1;
        queue.push(ni);
      }
    }
    return out;
  }

  /** 주어진 칸들에서 depth 칸 이내의 주거 칸. 공업 둘레의 완충대를 만든다. */
  private ringAround(core: readonly number[], zone: Int8Array, depth: number): number[] {
    const dist = new Uint8Array(SPAN * SPAN).fill(255);
    const queue: number[] = [];
    for (const i of core) {
      dist[i] = 0;
      queue.push(i);
    }
    const out: number[] = [];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      if (dist[cur] >= depth) continue;
      const x = cur % SPAN;
      const y = (cur / SPAN) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.inside(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (dist[ni] !== 255) continue;
        dist[ni] = dist[cur] + 1;
        queue.push(ni);
        if (zone[ni] === ZONE_R) out.push(ni);
      }
    }
    return out;
  }

  private nearestZonable(x: number, y: number, zone: Int8Array): number {
    for (let r = 0; r < 24; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!this.inside(nx, ny)) continue;
          const i = this.idx(nx, ny);
          if (zone[i] === ZONE_R) return i;
        }
      }
    }
    return -1;
  }

  /* ---------------- 11. 건물 ---------------- */

  /**
   * 처음부터 건물을 채워 넣는다. 시뮬레이션이 자라기를 기다리면 대도시를 보는 데
   * 며칠(게임 시간)이 걸린다.
   *
   * 규칙 두 가지만 지키면 나머지는 시뮬레이션이 알아서 한다.
   *   - 부지가 도로에 **맞닿아야** 한다 (안 그러면 통근 거리가 무한대라 영원히 빈다)
   *   - 부지가 평평하고 한 청크 안에 들어가야 한다 (growth.ts 와 같은 조건)
   *
   * 밀도는 도심에서 멀어질수록 낮아지고, 어디서든 일부는 빈터로 남긴다.
   * 그 빈터가 시뮬레이션이 앞으로 자랄 자리다.
   */
  private placeBuildings(): void {
    const maxR = SPAN * 0.42;
    const zoneTiles: number[] = [];
    // 0 = 빈터, 1~3 = 이 칸에 서길 바라는 건물 등급.
    const wanted = new Uint8Array(SPAN * SPAN);

    for (let y = EDGE; y < SPAN - EDGE; y++) {
      for (let x = EDGE; x < SPAN - EDGE; x++) {
        const i = this.idx(x, y);
        const zone = zoneOfBuildId(this.world.getBuild(this.ox + x, this.oy + y));
        if (zone < 0) continue;
        zoneTiles.push(i);

        const far = Math.min(1, Math.hypot(x - this.cx, y - this.cy) / maxR);
        const intensity = 1 - far;
        // 빈터 비율. 도심은 촘촘하고 변두리는 듬성듬성하다.
        if (this.rng.next() > 0.44 + intensity * 0.34) continue;

        const pick = this.rng.next();
        if (intensity > 0.68) wanted[i] = pick < 0.5 ? 3 : 2;
        else if (intensity > 0.4) wanted[i] = pick < 0.26 ? 3 : pick < 0.78 ? 2 : 1;
        else wanted[i] = pick < 0.34 ? 2 : 1;
        // 공장은 부지가 크다. 외곽의 큰 공장은 도시답지만, 정원이 커서
        // 일자리 균형을 흔들므로 확률만 조금 올린다.
        if (zone === ZONE_I && intensity < 0.5 && pick > 0.78) wanted[i] = 3;
      }
    }

    /*
     * **큰 것부터 놓는다.**
     *
     * 예전 판은 한 번만 훑으면서 칸마다 등급을 정했다. 그러면 먼저 놓인 1x1
     * 집 한 채가 그 자리에 설 수 있었던 3x3 아파트를 영원히 막는다. 실제로
     * 주거 건물의 등급 분포가 L1 1154 / L2 106 / L3 1 로 무너져서, 같은 땅에서
     * 인구가 나올 수 있는 양의 절반도 못 채웠다.
     *
     * 그래서 3x3 -> 2x2 -> 1x1 순서로 세 번 훑는다. 앞 단계에서 자리를 못 잡은
     * 칸은 다음 단계에서 한 등급 낮춰 다시 시도하므로 빈칸이 남지 않는다.
     */
    const order = this.rng.shuffle(zoneTiles);
    for (let level = 3; level >= 1; level--) {
      for (const i of order) {
        if (wanted[i] < level) continue;
        const x = i % SPAN;
        const y = (i / SPAN) | 0;
        const tx = this.ox + x;
        const ty = this.oy + y;
        const build = this.world.getBuild(tx, ty);
        const zone = zoneOfBuildId(build);
        if (zone < 0) continue;
        if (this.world.getBld(tx, ty) !== BLD_NONE) continue;
        if (!this.plotFits(x, y, level, build)) continue;
        this.world.placeBuilding(tx, ty, zone, level, this.bornDay);
      }
    }
  }

  /** growth.ts 의 부지 조건 + "도로에 맞닿아야 한다" 를 함께 본다. */
  private plotFits(x: number, y: number, span: number, build: number): boolean {
    const tx = this.ox + x;
    const ty = this.oy + y;
    if (localIndexOf(tx) + span > CHUNK_SIZE) return false;
    if (localIndexOf(ty) + span > CHUNK_SIZE) return false;
    if (!this.inside(x + span - 1, y + span - 1)) return false;
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

  /* ---------------- 12. 시설 ---------------- */

  /**
   * 시설을 **정원에서 역산한 개수만큼** 놓는다.
   *
   * 예전에는 간격이 고정된 격자로 깔았다(소공원 11칸마다 = 121곳). 도시 크기와
   * 무관하게 182채가 서고, 유지비가 수입을 넘어 첫날부터 적자가 났다.
   *
   * 이제는 실제로 지어진 건물 수와 정원에서 필요한 수를 계산한다.
   *   소방서  건물 220채당 1        경찰서  3,000명당 1
   *   병원    5,000명당 1           학교    2,500명당 1
   * 복지(공원·소공원·체육시설)는 주거 정원에 비례해서 깐다. 필요량
   * (AMENITY_NEED_BY_TIER)은 계층이 높을수록 크므로 도심 쪽을 더 촘촘히 한다.
   *
   * 큰 것부터 놓는다. 3x3 병원이 자리를 못 잡는 게 소공원이 못 서는 것보다 아프다.
   */
  private placeServiceFacilities(): void {
    const stats = this.countBuildings();
    const pop = Math.max(1, stats.residents);
    const area = this.cityArea();

    /**
     * 필수 서비스는 **정원과 도달 범위 둘 다** 로 정해야 한다.
     *
     * 정원만 보면(예전 판의 반대쪽 실수) 경찰서가 5채면 3,000 x 5 = 15,000명을
     * 감당하니 충분해 보이지만, 서비스는 도로 BFS 로 퍼지므로 반경 34 밖의
     * 동네는 정원이 남아돌아도 **경찰서가 없는 동네** 다. 실제로 경찰 커버율이
     * 0.69 까지 떨어졌다. 그래서 둘 중 큰 쪽을 쓴다.
     */
    const byCapacity = (value: number, per: number): number => Math.ceil((value / per) * 1.25);
    const byArea = (range: number): number => Math.ceil(area / (range * range * 0.42));
    const service = (value: number, per: number, range: number): number =>
      Math.max(1, byCapacity(value, per), byArea(range));

    /*
     * 필수 서비스는 **지구를 가리지 않고** 뿌린다.
     *
     * 주거지 쪽으로 당겨 놓았더니 공업지구에 소방서도 경찰서도 없는 도시가
     * 나왔다. SERVICE_WEIGHT 를 보면 공업지구의 소방 가중치가 0.16 으로 가장
     * 크고, 고소득 배율(1.35)까지 곱해져 감점이 0.35 에 이른다. 실제로 그
     * 도시의 3단계 공장 입주율이 0.22 까지 내려갔다. 학교만 예외로 주거지
     * 쪽에 둔다 — 공업지구의 학교 가중치는 0 이다.
     */
    this.scatterFacility(FAC_HOSPITAL, service(pop, 5_000, 55), -1);
    this.scatterFacility(FAC_SCHOOL, service(pop, 2_500, 30), ZONE_R);
    this.scatterFacility(FAC_POLICE, service(pop, 3_000, 34), -1);
    this.scatterFacility(FAC_FIRE, service(stats.buildings, 220, 40), -1);
    this.fillServiceGaps([FAC_HOSPITAL, FAC_SCHOOL, FAC_POLICE, FAC_FIRE]);

    /*
     * 복지(공원·체육시설·소공원)는 **면적 적분** 으로 잡는다.
     *
     * 시설 하나가 뿌리는 복지 총량은 strength x pi x r^2 / 3 이다(선형 감쇠의
     * 원뿔 부피). 도시 넓이로 나누면 평균 복지 점수가 나온다. 목표는 평균
     * AMENITY_TARGET — 저소득(0.35)·중산층(0.9) 요구를 완전히 채우고 고소득
     * (1.8)도 상당 부분 채우는 선이다. 더 깔면 만족도는 조금 오르지만 유지비가
     * 먼저 도시를 잡아먹는다.
     *
     * 주거지구 쪽에 몰아 놓는다. 공장 한가운데 공원은 아무 집도 덕을 못 본다.
     */
    const mass = (strength: number, range: number): number =>
      (strength * Math.PI * range * range) / 3;
    const budget = area * AMENITY_TARGET;
    const parks = Math.max(3, Math.round((budget * 0.66) / mass(1.5, 16)));
    const sports = Math.max(1, Math.round((budget * 0.18) / mass(1.6, 14)));
    const mini = Math.max(4, Math.round((budget * 0.16) / mass(0.65, 8)));
    this.scatterFacility(FAC_SPORTS, sports, ZONE_R);
    this.scatterFacility(FAC_PARK, parks, ZONE_R);
    this.scatterFacility(FAC_MINIPARK, mini, ZONE_R);
  }

  /**
   * 실제로 서비스가 안 닿는 동네에만 한 채씩 더 놓는다.
   *
   * 개수 공식(정원 x 면적)은 **평균** 이다. 서비스는 유클리드 원이 아니라 도로
   * BFS 로 퍼지므로, 강이나 언덕이 길을 돌아가게 만든 쪽은 평균이 맞아도 비어
   * 있다. 평행 차선을 가로로 꿰던 사다리를 걷어내자 도로 거리가 실제 거리대로
   * 늘어나면서 이 편차가 드러났다 — 병원 커버율이 도시에 따라 0.72 까지 갔다.
   *
   * 상수를 올려 전부 촘촘하게 깔면 안 비는 동네까지 시설이 늘어 유지비만 는다.
   * 그래서 **시뮬레이션이 쓰는 바로 그 ServiceField 로 재 보고**, 안 닿는 건물이
   * 몰려 있는 칸에만 한 채씩 더한다. 생성기와 시뮬레이션의 커버리지 판정이
   * 같은 코드라서 "생성기에서는 덮였는데 게임에서는 빈" 경우가 없다.
   */
  private fillServiceGaps(kinds: readonly number[]): void {
    const anchors = this.buildingAnchors();
    if (anchors.length === 0) return;
    const field = new ServiceField();
    const tolerance = Math.max(4, Math.round(anchors.length * SERVICE_GAP_TOLERANCE));

    for (let round = 0; round < SERVICE_TOPUP_ROUNDS; round++) {
      field.rebuild(this.world);
      let added = false;
      for (const kind of kinds) {
        const gaps: number[] = [];
        for (const [x, y, span] of anchors) {
          if (field.ownerFor(this.ox + x, this.oy + y, span, kind) < 0) gaps.push(this.idx(x, y));
        }
        if (gaps.length <= tolerance) continue;
        const spot = densestCell(gaps);
        if (spot >= 0 && this.placeFacilityAt(kind, spot % SPAN, (spot / SPAN) | 0, 12)) {
          added = true;
        }
      }
      if (!added) break;
    }
  }

  /** 도시 안의 건물 앵커. [x, y, span]. */
  private buildingAnchors(): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    for (let y = EDGE; y < SPAN - EDGE; y++) {
      for (let x = EDGE; x < SPAN - EDGE; x++) {
        const info = this.world.buildingCovering(this.ox + x, this.oy + y);
        if (!info || info.kind !== null) continue;
        if (info.tx !== this.ox + x || info.ty !== this.oy + y) continue;
        out.push([x, y, info.span]);
      }
    }
    return out;
  }

  /** (x, y) 에서 바깥으로 돌면서 시설 한 채가 들어갈 첫 자리를 찾는다. */
  private placeFacilityAt(kind: number, x: number, y: number, limit: number): boolean {
    const span = facilitySpan(kind);
    for (let r = 0; r <= limit; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!this.inside(nx, ny) || !this.inside(nx + span - 1, ny + span - 1)) continue;
          if (this.roadDist[this.idx(nx, ny)] === 255) continue;
          if (!this.clearFacilityPlot(nx, ny, span)) continue;
          const tx = this.ox + nx;
          const ty = this.oy + ny;
          if (!canPlaceFacility(this.world, tx, ty, kind, 5).ok) continue;
          this.world.placeFacility(tx, ty, kind, this.bornDay);
          return true;
        }
      }
    }
    return false;
  }

  /** 도로가 닿는 칸 수. 시설 밀도를 여기서 잡는다. */
  private cityArea(): number {
    let n = 0;
    for (let i = 0; i < this.roadDist.length; i++) if (this.roadDist[i] !== 255) n++;
    return Math.max(1, n);
  }

  /**
   * 시설 `count` 채를 도시 전체에 고르게 뿌린다.
   *
   * 후보를 무작위로 섞은 뒤 "이미 놓은 같은 종류에서 min 거리 이상" 인 자리만
   * 고른다. 격자처럼 줄 맞춰 서지 않으면서도 한쪽에 몰리지 않는다. 자리를
   * 못 찾으면 거리 조건을 낮춰 다시 돈다 — 예외를 던지지 않는다.
   */
  private scatterFacility(kind: number, count: number, prefer = -1): number {
    if (count <= 0) return 0;
    const span = facilitySpan(kind);
    const all = [...Array(SPAN * SPAN).keys()].filter((i) => {
      const x = i % SPAN;
      const y = (i / SPAN) | 0;
      return (
        this.inside(x, y) &&
        this.inside(x + span - 1, y + span - 1) &&
        this.roadDist[i] !== 255 &&
        this.roadDist[i] > 0
      );
    });
    // 선호 지구가 있으면 그쪽을 앞에, 나머지를 뒤에 둔다. 자리가 모자라면
    // 자연스럽게 뒤쪽으로 넘어가므로 "공원을 못 지었다" 가 생기지 않는다.
    const spots =
      prefer < 0
        ? this.rng.shuffle(all)
        : [
            ...this.rng.shuffle(all.filter((i) => this.nearZone(i, prefer))),
            ...this.rng.shuffle(all.filter((i) => !this.nearZone(i, prefer))),
          ];

    const placed: Array<[number, number]> = [];
    // 도시 넓이에서 잡은 첫 목표 간격. 못 채우면 절반씩 줄여 다시 돈다.
    let minGap = Math.max(4, Math.round(Math.sqrt((SPAN * SPAN * 0.55) / count) * 0.8));
    for (let pass = 0; pass < 4 && placed.length < count; pass++, minGap = Math.floor(minGap / 2)) {
      for (const i of spots) {
        if (placed.length >= count) break;
        const x = i % SPAN;
        const y = (i / SPAN) | 0;
        let tooClose = false;
        for (const [px, py] of placed) {
          if (Math.abs(px - x) + Math.abs(py - y) < minGap) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;
        const tx = this.ox + x;
        const ty = this.oy + y;
        // 시설 부지는 기존 지구·건물을 밀고 들어간다. 공공시설이 먼저다.
        if (!this.clearFacilityPlot(x, y, span)) continue;
        if (!canPlaceFacility(this.world, tx, ty, kind, 5).ok) continue;
        this.world.placeFacility(tx, ty, kind, this.bornDay);
        placed.push([x, y]);
      }
    }
    return placed.length;
  }

  /** 이 칸 둘레 두 칸 안에 그 지구가 있는가. 복지 시설을 주거지 쪽으로 당긴다. */
  private nearZone(i: number, zone: number): boolean {
    const x = i % SPAN;
    const y = (i / SPAN) | 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.inside(nx, ny)) continue;
        if (zoneOfBuildId(this.world.getBuild(this.ox + nx, this.oy + ny)) === zone) return true;
      }
    }
    return false;
  }

  /**
   * 시설 부지를 비운다.
   *
   * 도로·물·경사는 건드리지 않는다 — 그건 자리를 옮겨야 할 이유다. 지구와
   * 건물만 걷어낸다. 부지에 걸친 건물은 **통째로** 헌다. 반만 허물면 유령 칸이
   * 남고, 거절하면 도시가 다 들어선 뒤에는 3x3 병원이 설 자리가 거의 없다
   * (실제로 목표 6채 중 4채밖에 못 세웠다).
   */
  private clearFacilityPlot(x: number, y: number, span: number): boolean {
    const h = this.hgt[this.idx(x, y)];
    for (let dy = 0; dy < span; dy++) {
      for (let dx = 0; dx < span; dx++) {
        const j = this.idx(x + dx, y + dy);
        if (!this.land[j] || this.hgt[j] !== h) return false;
        const b = this.world.getBuild(this.ox + x + dx, this.oy + y + dy);
        if (b === Build.Road || b === Build.Civic) return false;
      }
    }
    // 시설은 도로에 닿아야 한다. 아무것도 헐기 전에 확인한다.
    if (!touchesRoadTiles(this.world, this.ox + x, this.oy + y, span)) return false;
    for (let dy = 0; dy < span; dy++) {
      for (let dx = 0; dx < span; dx++) {
        const tx = this.ox + x + dx;
        const ty = this.oy + y + dy;
        if (this.world.buildingCovering(tx, ty)) this.world.demolishAt(tx, ty);
        this.world.setBuild(tx, ty, Build.None, false);
      }
    }
    return true;
  }

  private countBuildings(): { buildings: number; residents: number; jobs: number } {
    let buildings = 0;
    let residents = 0;
    let jobs = 0;
    for (let y = EDGE; y < SPAN - EDGE; y++) {
      for (let x = EDGE; x < SPAN - EDGE; x++) {
        const info = this.world.buildingCovering(this.ox + x, this.oy + y);
        if (!info || info.kind !== null) continue;
        if (info.tx !== this.ox + x || info.ty !== this.oy + y) continue;
        buildings++;
        const level = info.span - 1;
        if (info.zone === ZONE_R) residents += RESIDENT_CAPACITY[level];
        else if (info.zone === ZONE_C) jobs += JOB_CAPACITY_C[level];
        else jobs += JOB_CAPACITY_I[level];
      }
    }
    return { buildings, residents, jobs };
  }
}

/* ---------------------------------------------------------------- *
 * 작은 도우미
 * ---------------------------------------------------------------- */

/**
 * 빈 칸들이 가장 빽빽하게 모인 곳. 8x8 칸으로 묶어 가장 많은 칸의 한가운데를 준다.
 * 평균 좌표(무게중심)를 쓰면 빈 곳이 도시 양 끝에 둘로 나뉘었을 때 그 사이의
 * 멀쩡한 동네 한복판을 찍는다.
 */
function densestCell(tiles: readonly number[]): number {
  if (tiles.length === 0) return -1;
  const CELL = 8;
  const cols = Math.ceil(SPAN / CELL);
  const count = new Map<number, number>();
  let bestKey = -1;
  let bestCount = 0;
  for (const i of tiles) {
    const key = Math.floor(((i / SPAN) | 0) / CELL) * cols + Math.floor((i % SPAN) / CELL);
    const n = (count.get(key) ?? 0) + 1;
    count.set(key, n);
    if (n > bestCount) {
      bestCount = n;
      bestKey = key;
    }
  }
  if (bestKey < 0) return -1;
  const cx = (bestKey % cols) * CELL + CELL / 2;
  const cy = Math.floor(bestKey / cols) * CELL + CELL / 2;
  return cy * SPAN + cx;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function mod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

/**
 * 비탈 마스크가 그릴 수 있는 모양인가.
 * build.ts 의 canConnectRoads 와 **같은 판정이어야 한다** — 한 방향, 또는
 * 마주 보는 두 방향(5 = 동서, 10 = 남북)만 비탈질 수 있다.
 */
function slopeLegal(mask: number): boolean {
  if ((mask & (mask - 1)) === 0) return true;
  return mask === 5 || mask === 10;
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
