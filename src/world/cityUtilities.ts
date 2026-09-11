import { BASE_CHUNK_SPAN, CHUNK_SIZE } from '../core/constants';
import {
  capacityOf,
  facilityKindOfCode,
  isAnchor,
  isFacilityAnchor,
  levelOfCode,
  zoneOfCode,
  ZONE_R,
} from '../sim/buildings';
import { FAC_GAS, facilityPowerDemand, POWER_SPECS } from '../sim/config/power';
import {
  DISCHARGE_RADIUS,
  FAC_GROUNDWATER,
  FAC_RIVER_PUMP,
  FAC_TREATMENT,
  PIPE_SEWER,
  PIPE_WATER,
  WATER_SPECS,
} from '../sim/config/water';
import { FAC_INCINERATOR, FAC_CREMATORIUM, FAC_CEMETERY } from '../sim/config/sanitation';
import { FAC_COMM_TOWER, FAC_HARBOR, FAC_PRISON, SPECIAL_SPECS } from '../sim/config/special';
import {
  canPlaceFacility,
  FACILITY_SPECS,
  touchesRoadTiles,
  touchesWater,
} from '../sim/facilities';
import { edgeNeighbors } from '../sim/roadGraph';
import { Build } from './build';
import { Terrain, isWater } from './terrain';
import { deriveSeed, Rng } from './rng';
import type { World } from './world';

/**
 * 새 도시의 기반시설: 전기·상하수도·위생·특수 시설.
 *
 * ---------------------------------------------------------------
 * 예전 판이 무엇을 틀렸는가
 * ---------------------------------------------------------------
 * - **부지를 못 찾으면 예외를 던졌다.** 이 함수는 첫 접속 경로(main.ts)에서
 *   불리므로, 지형이 조금만 험해도 게임이 시작조차 못 하고 죽는다.
 * - **배관과 전선을 2x2 청크 전면에 깔았다.** 도시가 없는 들판 밑에도 상수도가
 *   지나가고, 그만큼 유지비만 나갔다.
 * - **소각장·화장장·묘지를 도시 크기와 무관하게 9곳씩 놓았다.** 시설 유지비가
 *   수입을 넘는 데 크게 한몫했다.
 *
 * ---------------------------------------------------------------
 * 이 판의 규칙
 * ---------------------------------------------------------------
 * - 모든 배치는 **도시 발자국(도로가 실제로 깔린 범위)** 안에서만 한다.
 * - 개수는 전부 정원에서 역산한다. 넉넉하되 남지 않게.
 * - 자리를 못 찾으면 그냥 덜 놓는다. **절대 던지지 않는다.**
 * - 상수관과 하수관은 서로 맞닿지 않는다. 맞닿는 순간 water.ts 가 상수도를
 *   오염(pollution = 1)으로 표시하고 도시 전체 건강 점수가 내려간다.
 */

const SPAN = BASE_CHUNK_SPAN * CHUNK_SIZE;
/** 영역 가장자리 여유. cityGen 의 EDGE 와 같은 값이어야 한다. */
const EDGE = 4;
/** 배관 간격. PIPE_REACH 가 4(맨해튼)이므로 8칸마다면 빈틈이 없다. */
const PIPE_ROW_STEP = 8;
/** 전선 간격. POWER_REACH 3 + 건물 중계를 감안하면 6칸이면 넉넉하다. */
const WIRE_ROW_STEP = 6;

interface Footprint {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** New-city bootstrap only. Existing saves never enter this path. */
export function seedCityUtilities(world: World, bornDay: number, seed = 0): void {
  const ox = world.baseCx * CHUNK_SIZE;
  const oy = world.baseCy * CHUNK_SIZE;
  const rng = new Rng(deriveSeed(seed, 0x7f1));

  const foot = roadFootprint(world, ox, oy);
  if (!foot) return;

  const demand = measureDemand(world);
  const area = Math.max(1, (foot.x1 - foot.x0 + 1) * (foot.y1 - foot.y0 + 1));
  layPipes(world, ox, oy, foot);
  layWires(world, ox, oy, foot);

  const spots = candidateSpots(world, ox, oy, foot, rng);
  const place = (
    kind: number,
    count: number,
    record?: Array<[number, number]>,
    avoid?: ReadonlyArray<[number, number]>,
  ): number => installFacilities(world, spots, kind, count, bornDay, area, record, avoid);

  /* ---------------- 위생 ---------------- */
  /*
   * 위생은 **도시 전체 만족도에서 가장 큰 단일 감점** 이다.
   * macro.evaluate 는 주거 건물마다
   *   0.15 x (1 - 소각 품질) + 0.10 x (1 - 화장 품질)
   * 을 깎는다. 합쳐서 0.25 — 서비스 감점 상한(0.45)에 버금가고, 통근이나
   * 공업 혐오보다도 크다. 실제로 예전 판의 개수로 재 보면 주거 건물 평균
   * 감점이 0.163 이었다. 입주율이 0.6 에서 안 올라가던 진짜 이유가 이거다.
   *
   * 그래서 정원과 도달 범위를 둘 다 본다. 이 세 시설은 반경 64 짜리 도로 BFS
   * 서비스라 한 채가 도시의 한쪽만 덮는다.
   */
  const reach = (range: number): number => Math.ceil(area / (range * range * 0.45));
  const need = (value: number, per: number, range: number): number =>
    Math.max(1, Math.ceil((value * 1.15) / per), reach(range));

  place(FAC_INCINERATOR, need(demand.total, 10_000, 64));
  // 화장장(정원 6,000)과 묘지(5,000)는 같은 서비스 채널을 쓴다. 둘을 합쳐
  // 주거 정원을 덮되, 6:4 로 나눠 화장장 쪽에 조금 더 싣는다.
  place(FAC_CREMATORIUM, need(demand.residents * 0.6, 6_000, 64));
  place(FAC_CEMETERY, need(demand.residents * 0.4, 5_000, 64));

  /* ---------------- 특수 시설 ---------------- */
  /*
   * 상하수도보다 **먼저** 놓는다. 아래 하수 처리장은 내륙이면 옆에 방류 수로를
   * 파는데, 그 인공 수로가 남으면 항구가 그 도랑 옆에 서 버린다. 항구는 진짜
   * 물가에만 서야 한다.
   */
  // 교도소는 경찰 서비스를 보조한다(정원 1,200).
  place(FAC_PRISON, demand.residents >= 6_000 ? 1 : 0);
  // 통신탑은 STEP 5 예약 시설이다. 유지비도 전력 수요도 0이라 미리 세워 둔다.
  place(FAC_COMM_TOWER, 2);
  // 항구는 수역에 닿아야 한다. 물가 도시에만 선다.
  place(FAC_HARBOR, 1);

  /* ---------------- 상하수도 ---------------- */
  // 하천 취수장(정원 4,000)이 지하수 펌프(1,000)보다 네 배 싸게 먹힌다.
  // 물가가 있으면 그쪽을 먼저 쓰고, 모자란 만큼만 지하수로 채운다.
  const waterNeed = Math.ceil(demand.total * 1.3);
  const intakes: Array<[number, number]> = [];
  const rivers = place(FAC_RIVER_PUMP, Math.ceil(waterNeed / 4_000), intakes);
  const stillNeeded = Math.max(0, waterNeed - rivers * 4_000);
  place(FAC_GROUNDWATER, sized(stillNeeded, 1_000));

  // 하수: 처리장(정원 5,000)은 물가가 필요하다. 물이 없는 내륙 도시에는
  // 처리장 옆에 짧은 방류 수로를 파 준다(예전 판과 같은 방식).
  //
  // **취수장에서 DISCHARGE_RADIUS(12) 밖에 지어야 한다.** 처리수에도 오염이
  // 0.15 남아 있어서, 가까이 붙으면 그 물을 그대로 다시 퍼 올린다. 실제로
  // 도시 하나에서 오염된 물을 마시는 건물이 603채 나왔다.
  place(FAC_TREATMENT, sized(demand.total * 1.3, 5_000), undefined, intakes);

  /* ---------------- 전력 ---------------- */
  // 가스 발전소 12,000. 건물 + 시설 수요를 모두 더한 뒤 25% 여유를 둔다.
  const powerNeed = (demand.total + facilityPowerTotal(world)) * 1.35;
  place(FAC_GAS, sized(powerNeed, POWER_SPECS[FAC_GAS].capacity));
}

function sized(value: number, per: number): number {
  return value <= 0 ? 0 : Math.max(1, Math.ceil(value / per));
}

/** 도시에 실제로 도로가 깔린 범위. 배관·전선·발전소를 여기 안에만 둔다. */
function roadFootprint(world: World, ox: number, oy: number): Footprint | null {
  let x0 = SPAN;
  let y0 = SPAN;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < SPAN; y++) {
    for (let x = 0; x < SPAN; x++) {
      if (world.getBuild(ox + x, oy + y) !== Build.Road) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  // 배관은 건물 바깥으로 한 칸씩 더 나가야 가장자리 건물까지 닿는다.
  // 생성기와 같은 여유(EDGE)를 지킨다. 도시는 2x2 청크 안에서 끝난다.
  return {
    x0: Math.max(EDGE, x0 - 1),
    y0: Math.max(EDGE, y0 - 1),
    x1: Math.min(SPAN - EDGE - 1, x1 + 1),
    y1: Math.min(SPAN - EDGE - 1, y1 + 1),
  };
}

function measureDemand(world: World): { residents: number; total: number } {
  let residents = 0;
  let total = 0;
  for (const p of world.developedParcels()) {
    if (!p.bld) continue;
    for (const code of p.bld) {
      if (!isAnchor(code)) continue;
      const zone = zoneOfCode(code);
      const cap = capacityOf(zone, levelOfCode(code));
      total += cap;
      if (zone === ZONE_R) residents += cap;
    }
  }
  return { residents, total };
}

function facilityPowerTotal(world: World): number {
  let sum = 0;
  for (const p of world.developedParcels()) {
    if (!p.bld) continue;
    for (const code of p.bld) {
      if (isFacilityAnchor(code)) sum += facilityPowerDemand(facilityKindOfCode(code));
    }
  }
  return sum;
}

/**
 * 상수관과 하수관을 **빗살 두 개** 로 깐다.
 *
 * 상수 줄기는 도시 왼쪽 세로선, 하수 줄기는 오른쪽 세로선. 가지는 가로로
 * 뻗되 상수와 하수가 세로로 정확히 4칸씩 엇갈린다. 가지의 끝도 반대쪽 줄기에
 * 닿기 전에 두 칸 앞에서 멈춘다. 이렇게 해야 두 관이 같은 칸에 겹치지도,
 * 4방향으로 맞닿지도 않는다 — water.ts 는 맞닿는 순간 상수도 전체를
 * 오염(pollution = 1)으로 본다.
 *
 * **빗살은 도시보다 네 칸 넓게 깐다.** PIPE_REACH 가 맨해튼 4 이므로 가지
 * 간격 8 이면 사이는 다 덮이지만, 도시의 위아래 끝 네 칸은 마지막 가지에서
 * 멀어 물이 안 간다. 실제로 그 때문에 급수율이 0.9988 에서 멈췄다. 관은 땅속에
 * 있으니 도시 밖으로 조금 나가도 문제될 것이 없다(기본 2x2 청크 안에서 끝난다).
 */
function layPipes(world: World, ox: number, oy: number, f: Footprint): void {
  /*
   * 관은 도시보다 사방 네 칸 넓게 깐다.
   *
   * 하수 줄기가 오른쪽 세로선을 통째로 차지하므로 상수 가지는 그보다 두 칸
   * 앞에서 멈춰야 한다(맞닿으면 water.ts 가 상수도를 오염으로 본다). 그래서
   * 관을 도시 폭에 딱 맞춰 깔면 오른쪽 끝 두 줄의 급수 거리가 2만큼 줄고,
   * 하필 가지 사이(±4)에 있는 집은 물을 못 받는다 — 실제로 도시 전체 급수율이
   * 0.9996 에서 멈춘 원인이 그 집 한 채였다.
   *
   * 관은 땅속이고 지구·건물·도로와 겹쳐도 되므로, 도시 발자국이 아니라
   * **기본 2x2 청크 전체(테두리 한 칸만 남김)** 까지 넓힐 수 있다. 생성기는
   * EDGE(4) 안쪽에만 건물을 놓으므로 이러면 언제나 여유가 남는다.
   */
  const trunkW = Math.max(1, f.x0 - 4);
  const trunkS = Math.min(SPAN - 2, f.x1 + 4);
  const top = Math.max(1, f.y0 - 4);
  const bottom = Math.min(SPAN - 2, f.y1 + 4);
  const height = bottom - top;
  if (trunkS - trunkW < 6 || height < 8) return;

  // 가지를 **양 끝에 딱 맞춰** 균등하게 나눈다. 고정 간격으로 위에서부터 찍으면
  // 마지막 가지와 도시 아래 끝 사이에 최대 일곱 칸이 남고, 그만큼이 급수 사각이
  // 된다(실제로 도시 하나의 급수율이 0.9938 에서 멈췄다).
  const bands = Math.max(1, Math.min(Math.ceil(height / PIPE_ROW_STEP), Math.floor(height / 4)));
  const step = height / bands;

  for (let y = top; y <= bottom; y++) {
    world.setPipe(ox + trunkW, oy + y, PIPE_WATER);
    world.setPipe(ox + trunkS, oy + y, PIPE_SEWER);
  }
  for (let k = 0; k <= bands; k++) {
    const y = Math.round(top + k * step);
    for (let x = trunkW; x <= trunkS - 2; x++) world.setPipe(ox + x, oy + y, PIPE_WATER);
  }
  for (let k = 0; k < bands; k++) {
    const y = Math.round(top + (k + 0.5) * step);
    for (let x = trunkW + 2; x <= trunkS; x++) world.setPipe(ox + x, oy + y, PIPE_SEWER);
  }
}

/** 전선. 발전소와 도시 반대편을 한 망으로 묶는 최소한의 뼈대만 깐다. */
function layWires(world: World, ox: number, oy: number, f: Footprint): void {
  for (let y = f.y0; y <= f.y1; y++) world.setWire(ox + f.x0 + 1, oy + y, true);
  for (let y = f.y0 + 3; y <= f.y1; y += WIRE_ROW_STEP) {
    for (let x = f.x0 + 1; x <= f.x1; x++) world.setWire(ox + x, oy + y, true);
  }
}

/**
 * 시설을 놓을 만한 자리 목록.
 *
 * 도로에 닿은 평평한 땅이면 된다. 순서를 섞어 두고 앞에서부터 쓰므로 발전소가
 * 한쪽 구석에 줄지어 서지 않는다. 같은 목록을 모든 종류가 공유하고, 쓴 자리는
 * 다음 종류에서 자동으로 걸러진다(canPlaceFacility 가 거부한다).
 */
function candidateSpots(
  world: World,
  ox: number,
  oy: number,
  f: Footprint,
  rng: Rng,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = f.y0; y <= f.y1; y++) {
    for (let x = f.x0; x <= f.x1; x++) {
      const tx = ox + x;
      const ty = oy + y;
      if (isWater(world.getTile(tx, ty))) continue;
      if (world.getBuild(tx, ty) === Build.Road) continue;
      out.push([tx, ty]);
    }
  }
  return rng.shuffle(out);
}

/**
 * 시설 `count` 채를 **도시 전체에 고르게** 놓는다.
 *
 * 고르게 놓는 것이 중요하다. 소각장·화장장은 정원이 5만이나 되어 수치상으로는
 * 서너 채로 충분해 보이지만, 서비스가 반경 64 짜리 도로 BFS 로 퍼지기 때문에
 * 한쪽에 몰리면 반대편 동네는 쓰레기 처리율이 0 이다. 실제로 몰아 놓았더니
 * 도시 쓰레기 처리율이 0.89 까지 내려갔다.
 *
 * 그래서 도시 넓이와 개수에서 목표 간격을 잡고, 그 간격을 지키는 자리만
 * 고른다. 못 채우면 간격을 절반씩 줄여 다시 돈다.
 *
 * 자리를 끝내 못 찾으면 놓은 만큼만 돌려준다. **예외를 던지지 않는다** —
 * 기반시설 하나가 모자란 것보다 게임이 안 켜지는 쪽이 훨씬 나쁘다.
 */
function installFacilities(
  world: World,
  spots: ReadonlyArray<[number, number]>,
  kind: number,
  count: number,
  bornDay: number,
  area: number,
  record?: Array<[number, number]>,
  avoid?: ReadonlyArray<[number, number]>,
): number {
  if (count <= 0) return 0;
  const span = FACILITY_SPECS[kind].span;
  const placed: Array<[number, number]> = [];
  let minGap = Math.max(span + 2, Math.round(Math.sqrt(area / count) * 0.8));

  for (let pass = 0; pass < 4 && placed.length < count; pass++, minGap = Math.floor(minGap / 2)) {
    for (const [tx, ty] of spots) {
      if (placed.length >= count) break;
      let tooClose = false;
      for (const [px, py] of placed) {
        if (Math.abs(px - tx) + Math.abs(py - ty) < minGap) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      if (avoid?.some(([px, py]) => Math.hypot(px - tx, py - ty) <= DISCHARGE_RADIUS + 1)) continue;
      if (!plotFits(world, tx, ty, span, kind)) continue;

      let outlet: [number, number] | undefined;
      if (kind === FAC_TREATMENT && !touchesWater(world, tx, ty, span)) {
        // 내륙 도시의 하수 처리장 옆에는 짧은 방류 수로를 파 준다.
        outlet = [...edgeNeighbors(tx, ty, span)].find(
          ([x, y]) =>
            world.getBuild(x, y) === Build.None &&
            !world.buildingCovering(x, y) &&
            !isWater(world.getTile(x, y)),
        );
        if (!outlet) continue;
      }

      for (let dy = 0; dy < span; dy++)
        for (let dx = 0; dx < span; dx++) world.setBuild(tx + dx, ty + dy, Build.None, false);
      if (outlet) world.setTile(outlet[0], outlet[1], Terrain.WaterShallow);
      if (!canPlaceFacility(world, tx, ty, kind, 5).ok) continue;
      world.placeFacility(tx, ty, kind, bornDay);
      placed.push([tx, ty]);
      record?.push([tx, ty]);
    }
  }
  return placed.length;
}

/**
 * 평평하고, 도로에 닿고, 남의 건물을 반만 허물지 않는 자리인가.
 *
 * **지구를 걷어내기 전에** 전부 확인한다. 확인을 뒤로 미루면 자리를 못 쓰는데
 * 지구만 밀어 버린 땅이 남는다.
 */
function plotFits(world: World, tx: number, ty: number, span: number, kind: number): boolean {
  if (FACILITY_SPECS[kind].needsRoad && !touchesRoadTiles(world, tx, ty, span)) return false;
  const needsWater =
    (WATER_SPECS[kind]?.needsWater ?? false) || (SPECIAL_SPECS[kind]?.needsWater ?? false);
  // 하수 처리장만은 옆에 수로를 파서 조건을 만들 수 있다. 나머지는 진짜 물가라야 한다.
  if (needsWater && kind !== FAC_TREATMENT && !touchesWater(world, tx, ty, span)) return false;
  const height = world.sampleHeight(tx, ty);
  for (let dy = 0; dy < span; dy++) {
    for (let dx = 0; dx < span; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      const build = world.getBuild(x, y);
      if (build === Build.Road || build === Build.Civic) return false;
      if (isWater(world.getTile(x, y))) return false;
      if (world.sampleHeight(x, y) !== height) return false;
      const info = world.buildingCovering(x, y);
      if (!info) continue;
      if (
        info.tx < tx ||
        info.ty < ty ||
        info.tx + info.span > tx + span ||
        info.ty + info.span > ty + span
      )
        return false;
    }
  }
  return true;
}
