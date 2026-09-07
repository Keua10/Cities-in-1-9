import { CHUNK_SIZE, CHUNK_TILES } from '../core/constants';
import { chunkIndexOf, chunkKey, localIndexOf } from '../core/iso';
import { Build, DIRS } from '../world/build';
import type { Parcel, World } from '../world/world';
import {
  FAC_WELFARE_BASE,
  FACILITY_COUNT,
  facilityKindOfCode,
  isFacilityAnchor,
} from './buildings';
import { FACILITY_SPECS, touchesRoadTiles } from './facilities';
import { edgeNeighbors } from './roadGraph';
import {
  AMENITY_SCORE_SCALE,
  OVERLOAD_SLOPE,
  SERVICE_FIELD_MAX_DIST,
} from './simConstants';

/**
 * 3.3단계의 심장. **한 클래스가 두 가족을 모두 들고 있다.**
 *
 *   필수 서비스 (kind 0~3)  ->  도로 BFS + 담당 용량   (5.1~5.4)
 *   복지        (kind 4~6)  ->  유클리드 스탬프 + 감가 (5.5)
 *
 * 파일을 나누지 마라 — 갱신 시점이 같고(도로가 바뀔 때), macro 의 evaluate() 가
 * 두 값을 같은 루프에서 읽는다.
 *
 * ---------------------------------------------------------------
 * 왜 거리를 다르게 재는가
 * ---------------------------------------------------------------
 * 필수 서비스는 **도로를 타고 닿는다.** 강 건너편에 소방서가 보여도 다리가
 * 없으면 커버되지 않는다. 도로를 어떻게 깔았는지가 교통(3.2)에 이어 여기서도
 * 성적표가 된다.
 *
 * 복지는 반대로 **눈에 보이는 거리** 다. 공원은 소방차가 출동하는 게 아니라
 * 창밖으로 보이고 걸어서 가는 것이라, 강 건너 공원도 경관 효과가 있다.
 * 두 가족이 거리를 다르게 재는 것은 실수가 아니라 설계다.
 *
 * 저장하지 않는다 — build/bld 배열에서 언제든 다시 만들 수 있다.
 */

/** 커버되지 않음. dist 를 Uint8 에 담으므로 255 가 "없음" 이다. */
export const SERVICE_DIST_NONE = 255;
/** 담당 시설 없음. */
export const SERVICE_OWNER_NONE = 0xffff;

/** 필수 서비스 종류 수. kind 0~3. */
export const SERVICE_KIND_COUNT = FAC_WELFARE_BASE;

/** 도시에 서 있는 시설 한 채. rebuild 때마다 새로 만든다. */
export interface FacilityRecord {
  /** 시설 목록에서의 번호. owner 배열에 들어가는 값이다. */
  index: number;
  kind: number;
  /** 앵커 타일(왼쪽 위). */
  tx: number;
  ty: number;
  span: number;
  /**
   * 도로에 닿아 있는가.
   *
   * 이미 지어진 시설 옆 도로를 나중에 학생이 헐면 그 시설은 **죽은 시설** 이 된다.
   * 이건 막지 않는다(도로 철거를 시설이 거부하기 시작하면 규칙이 지저분해진다).
   * 대신 상태판이 경고한다. 소공원은 애초에 도로를 안 보므로 죽은 시설 판정에서
   * 제외한다(needsRoad = false).
   */
  hasRoad: boolean;
}

/**
 * 개발 청크 하나의 커버리지 격자.
 *
 * 청크당 4종 x 3바이트 x 4096 = 48KB. **시설이 하나도 없는 종류는 배열을 만들지
 * 않는다** — 대부분의 도시에서 병원 하나 없는 초반이 그렇다.
 * 복지 격자는 Uint8Array 하나(4KB)뿐이고, 복지 시설이 없으면 역시 만들지 않는다.
 */
interface CoverageChunk {
  /** [kind] -> 도로 칸마다 가장 가까운 그 종류 시설까지의 도로 거리. 255 = 닿지 않음. */
  dist: (Uint8Array | null)[];
  /** [kind] -> 그 시설의 번호(담당자). 0xffff = 없음. */
  owner: (Uint16Array | null)[];
  /** 복지 점수 x AMENITY_SCORE_SCALE. 격자 밖(개발되지 않은 청크)은 0 이다. */
  amenity: Uint8Array | null;
}

export class ServiceField {
  private chunks = new Map<string, CoverageChunk>();
  /** 이번 rebuild 에 잡힌 시설 전부. 번호가 곧 owner 값이다. */
  private facilities: FacilityRecord[] = [];

  /**
   * 시설별 담당 부하. **직전 평가에서 적립된 값** 이다(5.4 한 틱 지연).
   * 저장하지 않는다. 초기값은 항상 0 이고 primeCatchup 이 evaluate 를 두 번
   * 부르므로 첫 틱이 돌기 전에 한 번 채워진다.
   */
  private load: Float64Array = new Float64Array(0);
  /** 이번 평가가 적립 중인 부하. settleLoads 에서 load 로 넘어간다. */
  private pending: Float64Array = new Float64Array(0);
  /** load 로 계산해둔 시설별 품질 0~1. */
  private quality: Float64Array = new Float64Array(0);

  /* ---------------- 조회 ---------------- */

  facilityList(): readonly FacilityRecord[] {
    return this.facilities;
  }

  facilityCount(): number {
    return this.facilities.length;
  }

  /** 종류별 시설 수. 길이 FACILITY_COUNT. */
  countsByKind(): number[] {
    const out = new Array<number>(FACILITY_COUNT).fill(0);
    for (const f of this.facilities) out[f.kind]++;
    return out;
  }

  /** 하루 시설 유지비 합계. 도로가 끊겨 죽은 시설도 낸다 — 실제로 그렇다. */
  dailyUpkeep(): number {
    let sum = 0;
    for (const f of this.facilities) sum += FACILITY_SPECS[f.kind].upkeepPerDay;
    return sum;
  }

  /** 담당이 정원을 넘긴 시설 수(필수 서비스만). */
  overloadedCount(): number {
    let n = 0;
    for (const f of this.facilities) {
      const spec = FACILITY_SPECS[f.kind];
      if (spec.welfare || spec.capacity <= 0) continue;
      if (this.load[f.index] / spec.capacity > 1) n++;
    }
    return n;
  }

  /** 도로에 닿지 않은 시설 수. needsRoad 인 것만 센다(소공원 제외). */
  deadCount(): number {
    let n = 0;
    for (const f of this.facilities) {
      if (FACILITY_SPECS[f.kind].needsRoad && !f.hasRoad) n++;
    }
    return n;
  }

  loadOf(index: number): number {
    return index >= 0 && index < this.load.length ? this.load[index] : 0;
  }

  qualityOf(index: number): number {
    return index >= 0 && index < this.quality.length ? this.quality[index] : 0;
  }

  /* ---------------- 5.2 건물이 자기 담당 시설을 찾는 법 ---------------- */

  /**
   * RoadField.commuteFor 와 완전히 같은 모양이다. footprint 테두리의 도로 칸 중
   * 그 종류 거리가 가장 작은 칸을 고르고, 그 칸의 owner 가 담당 시설이다.
   *
   * 테두리의 **최솟값** 을 쓰는 이유: 소방차는 건물 어느 쪽에든 도착하면 된다.
   * (복지는 반대로 footprint 안 칸들의 평균을 쓴다. 두 규칙이 다른 것은 의도된 것이다.)
   */
  ownerFor(tx: number, ty: number, span: number, kind: number): number {
    let best = SERVICE_DIST_NONE;
    let owner = -1;
    for (const [rx, ry] of edgeNeighbors(tx, ty, span)) {
      const c = this.chunks.get(chunkKey(chunkIndexOf(rx), chunkIndexOf(ry)));
      const dist = c?.dist[kind];
      const own = c?.owner[kind];
      if (!dist || !own) continue;
      const i = localIndexOf(ry) * CHUNK_SIZE + localIndexOf(rx);
      if (dist[i] >= best) continue;
      best = dist[i];
      owner = own[i] === SERVICE_OWNER_NONE ? -1 : own[i];
    }
    return owner;
  }

  distFor(tx: number, ty: number, span: number, kind: number): number {
    let best = SERVICE_DIST_NONE;
    for (const [rx, ry] of edgeNeighbors(tx, ty, span)) {
      const c = this.chunks.get(chunkKey(chunkIndexOf(rx), chunkIndexOf(ry)));
      const dist = c?.dist[kind];
      if (!dist) continue;
      const i = localIndexOf(ry) * CHUNK_SIZE + localIndexOf(rx);
      if (dist[i] < best) best = dist[i];
    }
    return best;
  }

  /* ---------------- 5.3 용량과 품질 ---------------- */

  /**
   * 건물 한 채가 보는 종류별 서비스 품질 0~1.
   *   커버 안 됨 -> 0
   *   커버됨     -> 담당 시설의 품질(정원 안이면 1.0, 넘으면 서서히 떨어진다)
   */
  qualityAt(tx: number, ty: number, span: number, kind: number): number {
    const owner = this.ownerFor(tx, ty, span, kind);
    if (owner < 0) return 0;
    return this.qualityOf(owner);
  }

  /**
   * 5.6 다음 단계가 읽어갈 창구.
   *
   * 이 칸의 종류별 서비스 품질 0~1. **재해 확률·확산·진압 계산의 유일한 입력이다.**
   * 3.4(화재·범죄·질병)는 이것만 읽으면 되고 services.ts 를 고치지 않는다.
   */
  serviceQualityAt(tx: number, ty: number, kind: number): number {
    return this.qualityAt(tx, ty, 1, kind);
  }

  /* ---------------- 5.5 복지 ---------------- */

  /**
   * 이 칸의 복지 점수. 0 이상, 상한 없음(격자에 담기는 최대는 255/40 = 6.375).
   * 계층별 요구량과의 비교는 macro.ts 가 한다.
   *
   * STEP 4 오염 시스템이 "공원이 오염을 상쇄한다" 에 이 값을 쓸 자리이기도 하다.
   * 이번 단계에서는 만들어두기만 하고 오염 쪽에 연결하지 않는다.
   */
  amenityScoreAt(tx: number, ty: number): number {
    const c = this.chunks.get(chunkKey(chunkIndexOf(tx), chunkIndexOf(ty)));
    if (!c?.amenity) return 0;
    const i = localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx);
    return c.amenity[i] / AMENITY_SCORE_SCALE;
  }

  /**
   * 건물용 복지 점수. footprint 안 칸들의 **평균** 을 쓴다.
   *
   * 최댓값을 쓰면 3x3 고급 아파트가 모서리 한 칸만 공원에 걸쳐도 만점을 받는다.
   * 평균이면 건물 전체가 공원에 가까워야 한다.
   */
  amenityForBuilding(tx: number, ty: number, span: number): number {
    let sum = 0;
    for (let dy = 0; dy < span; dy++) {
      for (let dx = 0; dx < span; dx++) {
        sum += this.amenityScoreAt(tx + dx, ty + dy);
      }
    }
    return sum / (span * span);
  }

  /** 반경 안의 복지 시설을 가까운 순으로. 타일 정보 시트가 "가까운 곳" 에 쓴다. */
  nearbyWelfare(tx: number, ty: number, limit = 2): FacilityRecord[] {
    const hits: { f: FacilityRecord; d: number }[] = [];
    for (const f of this.facilities) {
      const spec = FACILITY_SPECS[f.kind];
      if (!spec.welfare) continue;
      const cx = f.tx + (f.span - 1) / 2;
      const cy = f.ty + (f.span - 1) / 2;
      const d = Math.hypot(tx - cx, ty - cy);
      if (d <= spec.range) hits.push({ f, d });
    }
    hits.sort((a, b) => a.d - b.d);
    return hits.slice(0, limit).map((h) => h.f);
  }

  /* ---------------- 5.4 한 틱 지연 ---------------- */

  /**
   * 이 건물이 담당 시설에 얹는 부하를 적립한다. **다음 평가가 쓸 값** 이다.
   *
   * 왜 지연이 필요한가: 품질을 계산하려면 담당 인구를 알아야 하고, 담당 인구를
   * 알려면 입주율을 알아야 하고, 입주율은 만족도에서 나오고, 만족도는 품질에서
   * 나온다. **순환이다.** 끊는 방법은 하나뿐이다 — 직전 평가에서 적립된 부하로
   * 계산한 품질을 쓴다. 도시를 두 바퀴 도는 것보다 싸고, STATS_INTERVAL = 3틱
   * (7.5초)마다 갱신되므로 학생 눈에는 즉각적이다.
   */
  accrueLoad(tx: number, ty: number, span: number, population: number): void {
    for (let kind = 0; kind < SERVICE_KIND_COUNT; kind++) {
      const owner = this.ownerFor(tx, ty, span, kind);
      if (owner < 0) continue;
      // 소방서만 건물 수인 이유: 불은 사람이 아니라 건물에서 난다.
      // 빈 공장 지대도 소방서가 필요하다.
      this.pending[owner] += FACILITY_SPECS[kind].capacityIsBuildings ? 1 : population;
    }
  }

  /**
   * 적립된 부하로 품질을 확정하고 부하 카운터를 비운다. evaluate 루프 끝에서 부른다.
   *
   *   loadRatio  = load / spec.capacity
   *   quality(f) = clamp01(1 - max(0, loadRatio - 1) * OVERLOAD_SLOPE)
   *
   * 정원 안이면 1.0, 넘어서면 서서히 떨어진다. **절벽이 없다** — 정원을 1명
   * 넘겼다고 서비스가 꺼지면 학생이 원인을 못 읽는다.
   */
  settleLoads(): void {
    for (const f of this.facilities) {
      const spec = FACILITY_SPECS[f.kind];
      this.load[f.index] = this.pending[f.index];
      if (spec.welfare || spec.capacity <= 0) {
        // 복지에는 용량도, 부하 적립도, 한 틱 지연도 없다. 순환 문제가 애초에
        // 생기지 않는다 — 복지 점수는 인구와 무관하게 시설 배치만으로 정해진다.
        this.quality[f.index] = 1;
        continue;
      }
      const ratio = this.load[f.index] / spec.capacity;
      this.quality[f.index] = clamp01(1 - Math.max(0, ratio - 1) * OVERLOAD_SLOPE);
    }
    this.pending.fill(0);
  }

  /* ---------------- 재계산 ---------------- */

  /**
   * 전체 재계산. **MacroSim 이 roadField.rebuild 바로 뒤에 부른다.**
   * 별도 주기를 만들지 마라 — 도로가 바뀌면 커버리지도 반드시 같이 바뀐다.
   */
  rebuild(world: World): void {
    const parcels = world.developedParcels();
    this.collectFacilities(world, parcels);
    this.allocate(parcels);
    this.runCoverageBfs(world);
    this.stampAmenity(parcels);
  }

  /**
   * 시설 목록을 모은다.
   *
   * **결정론이 여기서 정해진다.** 시설 목록은 (cy, cx, ly, lx) 순으로 번호를
   * 매기므로 순서가 항상 같다. BFS 동률(거리가 같음)은 먼저 큐에 들어간 시설이
   * 이기는데, 그 순서가 고정이므로 같은 도시에서 항상 같은 owner 가 나온다.
   */
  private collectFacilities(world: World, parcels: readonly Parcel[]): void {
    const sorted = [...parcels].sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    const out: FacilityRecord[] = [];

    for (const p of sorted) {
      if (!p.bld) continue;
      const baseX = p.cx * CHUNK_SIZE;
      const baseY = p.cy * CHUNK_SIZE;
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const code = p.bld[ly * CHUNK_SIZE + lx];
          if (!isFacilityAnchor(code)) continue;
          const kind = facilityKindOfCode(code);
          const span = FACILITY_SPECS[kind].span;
          const tx = baseX + lx;
          const ty = baseY + ly;
          out.push({
            index: out.length,
            kind,
            tx,
            ty,
            span,
            hasRoad: touchesRoadTiles(world, tx, ty, span),
          });
        }
      }
    }

    this.facilities = out;
    // 부하 배열 길이가 바뀌면 다시 만든다. 시설을 짓거나 헐었다는 뜻이므로
    // 부하가 0 에서 다시 채워지는 것이 맞다(다음 evaluate 가 한 번에 채운다).
    if (this.load.length !== out.length) {
      this.load = new Float64Array(out.length);
      this.pending = new Float64Array(out.length);
      this.quality = new Float64Array(out.length);
      // 시설이 방금 생겼을 때 첫 평가에서 품질 0 으로 읽히면 "지었는데 아무
      // 변화가 없다" 로 보인다. 정원 안(1.0)에서 시작한다.
      this.quality.fill(1);
    }
  }

  /** 격자 확보. 시설이 없는 종류·복지 없는 도시는 배열 자체를 만들지 않는다. */
  private allocate(parcels: readonly Parcel[]): void {
    const kindUsed = new Array<boolean>(FACILITY_COUNT).fill(false);
    for (const f of this.facilities) kindUsed[f.kind] = true;
    let anyWelfare = false;
    for (let k = FAC_WELFARE_BASE; k < FACILITY_COUNT; k++) {
      if (kindUsed[k]) anyWelfare = true;
    }

    this.chunks.clear();
    for (const p of parcels) {
      const dist: (Uint8Array | null)[] = [];
      const owner: (Uint16Array | null)[] = [];
      for (let kind = 0; kind < SERVICE_KIND_COUNT; kind++) {
        if (!kindUsed[kind]) {
          dist.push(null);
          owner.push(null);
          continue;
        }
        dist.push(new Uint8Array(CHUNK_TILES).fill(SERVICE_DIST_NONE));
        owner.push(new Uint16Array(CHUNK_TILES).fill(SERVICE_OWNER_NONE));
      }
      this.chunks.set(p.key, {
        dist,
        owner,
        amenity: anyWelfare ? new Uint8Array(CHUNK_TILES) : null,
      });
    }
  }

  /**
   * 5.1 다중 소스 BFS.
   *
   * 시설마다 BFS 를 돌리면 O(시설수 x 도로칸수) 다. 대신 **종류마다 한 번씩,
   * 그 종류의 모든 시설을 동시에 큐에 넣는다.** 비용은 종류당 O(도로칸수) 이고,
   * 종류가 4개니까 총 4패스다. roadGraph.ts:rebuild 가 toJobs/toHomes 로 이미
   * 쓰는 패턴이고 같은 큐 구조를 그대로 쓴다.
   *
   * 거리 단위는 RoadField 와 **같다**(도로 칸 홉 수). 그래야 COMMUTE_GOOD_DIST
   * 같은 기존 상수와 감각이 맞는다.
   */
  private runCoverageBfs(world: World): void {
    for (let kind = 0; kind < SERVICE_KIND_COUNT; kind++) {
      const spec = FACILITY_SPECS[kind];
      const maxDist = Math.min(spec.range, SERVICE_FIELD_MAX_DIST, SERVICE_DIST_NONE - 1);

      // 출발점: 시설 footprint 테두리에 맞닿은 도로 칸.
      // 시설 목록 순서대로 넣으므로 동률에서 항상 같은 쪽이 이긴다.
      let queue: number[] = [];
      for (const f of this.facilities) {
        if (f.kind !== kind) continue;
        for (const [rx, ry] of edgeNeighbors(f.tx, f.ty, f.span)) {
          if (world.getBuild(rx, ry) !== Build.Road) continue;
          if (this.write(rx, ry, kind, 0, f.index)) queue.push(rx, ry);
        }
      }
      if (queue.length === 0) continue;

      for (let dist = 1; dist <= maxDist && queue.length > 0; dist++) {
        const next: number[] = [];
        for (let i = 0; i < queue.length; i += 2) {
          const tx = queue[i];
          const ty = queue[i + 1];
          const owner = this.readOwner(tx, ty, kind);
          if (owner < 0) continue;
          for (const dir of DIRS) {
            const nx = tx + dir[0];
            const ny = ty + dir[1];
            if (world.getBuild(nx, ny) !== Build.Road) continue;
            if (this.write(nx, ny, kind, dist, owner)) next.push(nx, ny);
          }
        }
        queue = next;
      }
    }
  }

  /** 더 가까울 때만 쓴다. 실제로 썼으면 true(= 큐에 넣어야 한다). */
  private write(
    tx: number,
    ty: number,
    kind: number,
    dist: number,
    owner: number,
  ): boolean {
    const c = this.chunks.get(chunkKey(chunkIndexOf(tx), chunkIndexOf(ty)));
    const d = c?.dist[kind];
    const o = c?.owner[kind];
    // 개발되지 않은 청크의 도로는 볼 일이 없다.
    if (!d || !o) return false;
    const i = localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx);
    // 동률(<=)이면 쓰지 않는다 — 먼저 큐에 들어간 시설이 이긴다.
    if (d[i] <= dist) return false;
    d[i] = dist;
    o[i] = owner;
    return true;
  }

  private readOwner(tx: number, ty: number, kind: number): number {
    const c = this.chunks.get(chunkKey(chunkIndexOf(tx), chunkIndexOf(ty)));
    const o = c?.owner[kind];
    if (!o) return -1;
    const v = o[localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx)];
    return v === SERVICE_OWNER_NONE ? -1 : v;
  }

  /**
   * 5.5 복지 — 유클리드 스탬프.
   *
   * BFS 를 쓰지 않는다. 반경이 짧아서(8~16타일) 시설마다 정사각 범위를 한 번
   * 훑고 점수를 더하는 것이 훨씬 싸고, "보이는 거리" 라는 의미에도 맞다.
   *
   *   d = 유클리드 거리(타일, 시설 중심 기준)
   *   if (d <= r) amenity[t] += strength * (1 - d / r)
   *
   * **선형 감쇠** 다. 바로 옆이 strength 전부, 반경 끝이 0. 계단이 아니라 서서히
   * 줄어들어야 학생이 "조금 더 가까이" 를 시도한다.
   *
   * 물·절벽을 가로질러도 효과가 있다. 강 건너 공원이 보이는 것은 맞는 동작이고,
   * 필수 서비스가 도로에서 끊기는 것과 정확히 반대되는 결과가 나와야 한다.
   *
   * 비용은 시설당 (2r+1)². 공원 반경 16이면 1,089칸이고, 복지 시설이 40채여도
   * 4만 칸이다. 도로 갱신 때만 도니까 무시할 수 있다.
   */
  private stampAmenity(parcels: readonly Parcel[]): void {
    let any = false;
    for (const c of this.chunks.values()) {
      if (c.amenity) {
        c.amenity.fill(0);
        any = true;
      }
    }
    if (!any || parcels.length === 0) return;

    // 소수점을 유지할 이유가 없고 배열이 1/4 로 줄어들므로 Uint8 에 담는다.
    // 누적은 실수로 하고 마지막에 한 번만 양자화해야 반올림 오차가 안 쌓인다.
    const acc = new Map<string, Float32Array>();
    for (const p of parcels) acc.set(p.key, new Float32Array(CHUNK_TILES));

    for (const f of this.facilities) {
      const spec = FACILITY_SPECS[f.kind];
      if (!spec.welfare || spec.strength <= 0) continue;
      const r = spec.range;
      const cx = f.tx + (f.span - 1) / 2;
      const cy = f.ty + (f.span - 1) / 2;
      const x0 = Math.ceil(cx - r);
      const x1 = Math.floor(cx + r);
      const y0 = Math.ceil(cy - r);
      const y1 = Math.floor(cy + r);

      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const d = Math.hypot(tx - cx, ty - cy);
          if (d > r) continue;
          const arr = acc.get(chunkKey(chunkIndexOf(tx), chunkIndexOf(ty)));
          if (!arr) continue; // 개발되지 않은 청크에는 격자가 없다
          arr[localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx)] +=
            spec.strength * (1 - d / r);
        }
      }
    }

    for (const [key, arr] of acc) {
      const c = this.chunks.get(key);
      if (!c?.amenity) continue;
      for (let i = 0; i < CHUNK_TILES; i++) {
        if (arr[i] <= 0) continue;
        c.amenity[i] = Math.min(255, Math.round(arr[i] * AMENITY_SCORE_SCALE));
      }
    }
  }

  /* ---------------- 미니맵용 ---------------- */

  /** 이 도로 칸이 그 종류에 커버되는가. 미니맵 커버리지 레이어가 쓴다(이진). */
  roadCoveredAt(tx: number, ty: number, kind: number): boolean {
    const c = this.chunks.get(chunkKey(chunkIndexOf(tx), chunkIndexOf(ty)));
    const d = c?.dist[kind];
    if (!d) return false;
    return d[localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx)] !== SERVICE_DIST_NONE;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
