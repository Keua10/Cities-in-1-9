import { TIER_NAMES } from '../sim/buildings';
import { FACILITY_SPECS } from '../sim/facilities';
import type { MacroSim } from '../sim/macro';
import { WATER_SPECS } from '../sim/config/water';
import { POWER_SPECS, facilityPowerDemand } from '../sim/config/power';
import { SERVICE_KIND_COUNT } from '../sim/services';
import { AMENITY_NEED_BY_TIER, FACILITY_NAMES } from '../sim/simConstants';

/* ---------------------------------------------------------------- *
 * 3.3단계: 타일 정보 — 학생이 "왜 여기에 안 들어서는지" 를 읽는 자리
 * ---------------------------------------------------------------- */

/**
 * 시설 칸을 찍었을 때. 담당 범위·부하·유지비를 보여준다.
 * 복지는 정원이 없으므로 반경·세기·유지비를 대신 적는다.
 */
export function describeFacility(sim: MacroSim, tx: number, ty: number, kind: number): string {
  const spec = FACILITY_SPECS[kind];
  const upkeep = `하루 ₩${Math.round(sim.services.upkeepOfKind(kind)).toLocaleString('ko-KR')}`;
  if (POWER_SPECS[kind])
    return `${spec.name} · 발전 용량 ${POWER_SPECS[kind].capacity.toLocaleString('ko-KR')} · ${sim.power.supplyAt(tx, ty) > 0 ? '가동' : '가동 중지: 도로 확인'} · ${upkeep}`;
  if (WATER_SPECS[kind])
    return `${spec.name} · ${sim.water.facilityStatus(tx, ty)} · 전력 ${Math.round(sim.power.supplyAt(tx, ty) * 100)}% (수요 ${facilityPowerDemand(kind)}) · ${upkeep}`;

  if (spec.welfare) {
    return `${spec.name} · 반경 ${spec.range}타일(직선) · 세기 ${spec.strength} · ${upkeep}`;
  }

  const record = sim.services
    .facilityList()
    .find((f) => f.tx === tx && f.ty === ty && f.kind === kind);
  if (!record) return `${spec.name} · ${upkeep}`;

  const load = Math.round(sim.services.loadOf(record.index));
  const unit = spec.capacityIsBuildings ? '건물' : '인구';
  const capacity = sim.services.capacityOfKind(kind);
  const over = load > capacity ? ' — 과부하' : '';
  const dead = spec.needsRoad && !record.hasRoad ? ' · 도로 미연결(담당 없음)' : '';
  return (
    `${spec.name} · 반경 ${spec.range}칸(도로) · ` +
    `담당 ${unit} ${load.toLocaleString('ko-KR')}/${Math.round(capacity).toLocaleString('ko-KR')}${over} · 품질 ${Math.round(sim.services.qualityOf(record.index) * 100)}% · ` +
    `${upkeep}${dead}`
  );
}

/** 필수 서비스 4종의 상태. 종류마다 담당 시설과 부하를 함께 적는다. */
export function describeService(
  sim: MacroSim,
  tx: number,
  ty: number,
  here: { tx: number; ty: number; span: number; kind: number | null } | null,
): string {
  // 건물 위면 그 건물의 footprint 로, 빈 땅이면 그 칸 하나로 본다.
  const bx = here && here.kind === null ? here.tx : tx;
  const by = here && here.kind === null ? here.ty : ty;
  const span = here && here.kind === null ? here.span : 1;

  const parts: string[] = [];
  parts.push(
    `쓰레기 ${Math.round(sim.services.qualityAt(bx, by, span, 14) * 100)}% · 장의 ${Math.round(sim.services.qualityAt(bx, by, span, 15) * 100)}% (주거)`,
  );
  for (let kind = 0; kind < SERVICE_KIND_COUNT; kind++) {
    const owner = sim.services.ownerFor(bx, by, span, kind);
    if (owner < 0) {
      parts.push(`${FACILITY_NAMES[kind]} 없음`);
      continue;
    }
    const spec = FACILITY_SPECS[kind];
    const load = Math.round(sim.services.loadOf(owner));
    const quality = sim.services.qualityOf(owner);
    const over = load > spec.capacity ? ' 과부하' : '';
    parts.push(
      `${FACILITY_NAMES[kind]} ${dots(quality)}(${load.toLocaleString('ko-KR')}/${spec.capacity.toLocaleString('ko-KR')}${over})`,
    );
  }
  return parts.join('   ');
}

/**
 * 복지 상태. **점수와 요구량을 나란히** 보여준다.
 *
 * 이 한 줄이 "이 자리에 고급 아파트가 왜 안 들어서는지" 를 학생에게 직접
 * 알려준다. 같은 자리라도 건물 등급이 달라지면 요구량이 달라지므로, 요구량
 * 옆에 계층 이름을 같이 적는다.
 *
 * 종류별로 쪼개지는 않는다 — 필요한 정보는 "충족했나" 하나지, 그게 소공원
 * 덕인지 체육시설 덕인지가 아니다. 대신 괄호에 반경 안의 복지 시설을 가까운
 * 순으로 두어 개 적어준다.
 */
export function describeAmenity(
  sim: MacroSim,
  tx: number,
  ty: number,
  here: { tx: number; ty: number; span: number; level: number; kind: number | null } | null,
): string {
  const building = here && here.kind === null ? here : null;
  const bx = building ? building.tx : tx;
  const by = building ? building.ty : ty;
  const span = building ? building.span : 1;
  // 빈 땅에서는 중산층 기준으로 보여준다. 학생이 "여기에 뭘 지을 수 있나" 를
  // 가늠하는 자리라 가운데 계층이 기준으로 맞다.
  const tier = building ? building.level - 1 : 1;

  const score = sim.services.amenityForBuilding(bx, by, span);
  const need = AMENITY_NEED_BY_TIER[tier];
  const fulfil = Math.min(1, score / need);
  const state = fulfil >= 1 ? '충족' : '부족';

  const near = sim.services
    .nearbyWelfare(bx, by, 2)
    .map((f) => {
      const d = Math.round(Math.hypot(bx - f.tx, by - f.ty));
      return `${FACILITY_NAMES[f.kind]} ${d}칸`;
    })
    .join(', ');

  return (
    `${dots(fulfil)} ${score.toFixed(2)} / ${need.toFixed(2)} 필요 ` +
    `(${TIER_NAMES[tier]}) — ${state}` +
    (near ? `   가까운 곳: ${near}` : '')
  );
}

/** 0~1 을 네 칸짜리 막대로. 숫자보다 한눈에 읽힌다. */
function dots(v: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, v)) * 4);
  return '●'.repeat(filled) + '○'.repeat(4 - filled);
}
