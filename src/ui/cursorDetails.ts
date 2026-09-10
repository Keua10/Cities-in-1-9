import { TIER_NAMES } from '../sim/buildings';
import { FACILITY_SPECS } from '../sim/facilities';
import type { MacroSim } from '../sim/macro';
import { WATER_SPECS } from '../sim/config/water';
import { AIRPORT_SPECS, HARBOR_SPECS } from '../sim/config/transport';
import { POWER_SPECS, facilityPowerDemand } from '../sim/config/power';
import {
  FAC_COMM_TOWER,
  FAC_PRISON,
  SPECIAL_SPECS,
  isAirportFacility,
  isHarborFacility,
  isSpecialFacility,
} from '../sim/config/special';
import { SERVICE_KIND_COUNT } from '../sim/services';
import { AMENITY_NEED_BY_TIER, FACILITY_NAMES } from '../sim/simConstants';

export function describeFacility(sim: MacroSim, tx: number, ty: number, kind: number): string {
  const spec = FACILITY_SPECS[kind];
  const upkeep = `하루 ₩${Math.round(sim.services.upkeepOfKind(kind)).toLocaleString('ko-KR')}`;

  if (POWER_SPECS[kind])
    return `${spec.name} · 발전 용량 ${POWER_SPECS[kind].capacity.toLocaleString('ko-KR')} · ${sim.power.supplyAt(tx, ty) > 0 ? '가동' : '가동 중지: 도로 확인'} · ${upkeep}`;
  if (WATER_SPECS[kind])
    return `${spec.name} · ${sim.water.facilityStatus(tx, ty)} · 전력 ${Math.round(sim.power.supplyAt(tx, ty) * 100)}% (수요 ${facilityPowerDemand(kind)}) · ${upkeep}`;

  if (isSpecialFacility(kind)) {
    const role = SPECIAL_SPECS[kind].role;
    if (kind === FAC_COMM_TOWER)
      return `${spec.name} · ${role} · 도로·전력 불필요 · 만족도/서비스/수요 영향 없음 · ${upkeep}`;

    const record = sim.services
      .facilityList()
      .find((f) => f.tx === tx && f.ty === ty && f.kind === kind);
    const road = record && spec.needsRoad && !record.hasRoad ? ' · 도로 미연결' : '';
    const power = facilityPowerDemand(kind);
    const powered = sim.power.supplyAt(tx, ty) > 0;

    if (kind === FAC_PRISON && record) {
      const load = Math.round(sim.services.loadOf(record.index));
      const capacity = sim.services.capacityOfKind(kind);
      const over = load > capacity ? ' — 과부하' : '';
      return (
        `${spec.name} · ${role} · 도로 ${spec.range}칸 · ` +
        `담당 인구 ${load.toLocaleString('ko-KR')}/${Math.round(capacity).toLocaleString('ko-KR')}${over} · ` +
        `품질 ${Math.round(sim.services.qualityOf(record.index) * 100)}% · 전력 수요 ${power} · ${upkeep}${road}`
      );
    }

    if (isHarborFacility(kind)) {
      const harbor = HARBOR_SPECS[kind];
      const mode = harbor.mode === 'passenger' ? '여객 전용' : harbor.mode === 'cargo' ? '화물 전용' : '여객+화물 배분';
      return `${spec.name} · ${role} · ${mode} · 최대 ${harbor.maxShips}척 · 수역 인접 · ${powered ? '전력 공급' : '전력 미공급'} (수요 ${power}) · ${upkeep}${road}`;
    }
    if (isAirportFacility(kind)) {
      const airport = AIRPORT_SPECS[kind];
      return `${spec.name} · ${role} · 최대 항공기 ${airport.maxPlanes}대 · 활주로 ${airport.minRunwayTiles}칸 이상 · 유도로 필요 · ${powered ? '전력 공급' : '전력 미공급'} (수요 ${power}) · ${upkeep}${road}`;
    }
    return `${spec.name} · ${role} · ${powered ? '전력 공급' : '전력 미공급'} (수요 ${power}) · ${upkeep}${road}`;
  }

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

export function describeService(
  sim: MacroSim,
  tx: number,
  ty: number,
  here: { tx: number; ty: number; span: number; kind: number | null } | null,
): string {
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
    const ownerRecord = sim.services.facilityList()[owner];
    const ownerKind = ownerRecord?.kind ?? kind;
    const load = Math.round(sim.services.loadOf(owner));
    const capacity = sim.services.capacityOfKind(ownerKind);
    const quality = sim.services.qualityOf(owner);
    const over = capacity > 0 && load > capacity ? ' 과부하' : '';
    const name = ownerKind === FAC_PRISON ? '교도소(경찰 보조)' : FACILITY_NAMES[kind];
    parts.push(
      `${name} ${dots(quality)}(${load.toLocaleString('ko-KR')}/${Math.round(capacity).toLocaleString('ko-KR')}${over})`,
    );
  }
  return parts.join('   ');
}

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

function dots(v: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, v)) * 4);
  return '●'.repeat(filled) + '○'.repeat(4 - filled);
}
