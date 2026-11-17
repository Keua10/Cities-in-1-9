import { TIER_NAMES } from '../sim/buildings';
import { formatMoney } from './money';
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
import { FOOD_SPECS } from '../sim/config/food';
import {
  CONSUMER_SPECS,
  DIFFICULTY_NAMES,
  MINE_SPECS,
  RESOURCE_NAMES,
} from '../sim/config/resources';
import { MINE_STATE_TEXT } from '../sim/resources';
import type { InfoCard } from './infoCard';

/**
 * 커서 아래 시설·건물 정보 카드(gameHud → hud). 긴 문장 대신
 * 상태 배지 · 숫자 몇 줄 · 고칠 것(빨간 칩) · 유지비, 설명은 ⓘ.
 */

const n = (v: number) => Math.round(v).toLocaleString('ko-KR');

export function facilityCard(sim: MacroSim, tx: number, ty: number, kind: number): InfoCard {
  const spec = FACILITY_SPECS[kind];
  const card: InfoCard = {
    title: spec.name,
    foot: `유지비 하루 ${formatMoney(sim.services.upkeepOfKind(kind))}`,
    facts: [],
    problems: [],
  };
  const ok = (text = '가동 중') => (card.status = { text, tone: 'ok' });
  const stop = (why: string) => (card.status = { text: `멈춤 · ${why}`, tone: 'bad' });

  const mine = MINE_SPECS[kind];
  if (mine) {
    const m = sim.resources.mineAt(tx, ty);
    card.sub = `${RESOURCE_NAMES[mine.resource]} 채굴`;
    if (!m) return card;
    const d = m.deposit;
    if (m.state === 'ok') {
      ok();
      card.facts!.push(`하루 ${n(m.output)} 생산`);
    } else stop(MINE_STATE_TEXT[m.state]);
    if (d) {
      card.facts!.push(`남은 양 ${n(m.remaining)} / ${n(d.reserve)}`);
      card.meters = [{ label: '매장량', value: d.reserve ? m.remaining / d.reserve : 0 }];
      card.sub += ` · ${DIFFICULTY_NAMES[d.difficulty]}`;
    } else card.problems!.push('매장지 없음');
    return card;
  }

  const consumer = CONSUMER_SPECS[kind];
  if (consumer) {
    const c = sim.resources.consumerAt(tx, ty);
    if (c) {
      if (c.active) ok();
      else stop(c.reason);
    }
    card.help = consumer.blurb;
    return card;
  }

  const food = FOOD_SPECS[kind];
  if (food) {
    const farm = sim.food.farmAt(tx, ty);
    const summary = sim.food.summary;
    card.help = food.blurb;
    if (food.output <= 0) {
      card.meters = [
        { label: '비축', value: summary.capacity ? summary.stock / summary.capacity : 0 },
      ];
      card.facts!.push(`${n(summary.stock)} / ${n(summary.capacity)}`);
      return card;
    }
    if (!farm || !farm.active) {
      stop('도로 연결 필요');
      card.problems!.push('도로 미연결');
      return card;
    }
    ok();
    card.facts!.push(`식량 하루 ${n(farm.output)}`);
    if (food.fertilityWeight > 0) card.meters = [{ label: '비옥도', value: farm.fertility }];
    return card;
  }

  const powered = sim.power.supplyAt(tx, ty) > 0;
  if (POWER_SPECS[kind]) {
    if (powered) ok();
    else stop('도로 확인');
    card.facts!.push(`발전 용량 ${n(POWER_SPECS[kind].capacity)}`);
    return card;
  }
  if (WATER_SPECS[kind]) {
    card.status = { text: sim.water.facilityStatus(tx, ty), tone: powered ? 'ok' : 'warn' };
    card.meters = [{ label: '전력', value: sim.power.supplyAt(tx, ty) }];
    card.facts!.push(`전력 수요 ${facilityPowerDemand(kind)}`);
    return card;
  }

  const record = sim.services
    .facilityList()
    .find((f) => f.tx === tx && f.ty === ty && f.kind === kind);
  const noRoad = !!record && spec.needsRoad && !record.hasRoad;
  if (noRoad) card.problems!.push('도로 미연결');

  if (isSpecialFacility(kind)) {
    card.help = SPECIAL_SPECS[kind].role;
    if (kind === FAC_COMM_TOWER) {
      ok();
      card.facts!.push('도로·전력 필요 없음');
      return card;
    }
    if (!powered) card.problems!.push('전력 미공급');
    card.facts!.push(`전력 수요 ${facilityPowerDemand(kind)}`);
    if (kind === FAC_PRISON && record) {
      const load = sim.services.loadOf(record.index);
      const capacity = sim.services.capacityOfKind(kind);
      card.meters = [{ label: '품질', value: sim.services.qualityOf(record.index) }];
      card.facts!.unshift(`담당 인구 ${n(load)} / ${n(capacity)} · 도로 ${spec.range}칸`);
      if (load > capacity) card.problems!.push('과부하');
    } else if (isHarborFacility(kind)) {
      const harbor = HARBOR_SPECS[kind];
      card.sub =
        harbor.mode === 'passenger' ? '여객' : harbor.mode === 'cargo' ? '화물' : '여객+화물';
      card.facts!.unshift(`최대 ${harbor.maxShips}척`);
    } else if (isAirportFacility(kind)) {
      const airport = AIRPORT_SPECS[kind];
      card.facts!.unshift(`최대 ${airport.maxPlanes}대 · 활주로 ${airport.minRunwayTiles}칸 이상`);
    }
    if (!card.problems!.length) ok();
    return card;
  }

  if (spec.welfare) {
    ok('효과 중');
    card.facts!.push(`반경 ${spec.range}칸 · 세기 ${spec.strength}`);
    return card;
  }

  if (!record) return card;
  const load = sim.services.loadOf(record.index);
  const capacity = sim.services.capacityOfKind(kind);
  card.meters = [{ label: '품질', value: sim.services.qualityOf(record.index) }];
  card.facts!.push(
    `담당 ${spec.capacityIsBuildings ? '건물' : '인구'} ${n(load)} / ${n(capacity)} · 도로 ${spec.range}칸`,
  );
  if (load > capacity) card.problems!.push('과부하');
  if (noRoad) stop('도로 미연결');
  else if (load > capacity) card.status = { text: '과부하', tone: 'warn' };
  else ok();
  return card;
}

/** 건물 칸의 서비스: 소방·경찰·병원·학교 + 쓰레기·장의. */
export function buildingServices(
  sim: MacroSim,
  bx: number,
  by: number,
  span: number,
): NonNullable<InfoCard['services']> {
  const out: NonNullable<InfoCard['services']> = [];
  for (let kind = 0; kind < SERVICE_KIND_COUNT; kind++) {
    const owner = sim.services.ownerFor(bx, by, span, kind);
    const label = FACILITY_NAMES[kind].replace(/서$|시설$/, '');
    if (owner < 0) {
      out.push({ label, value: 0, none: true });
      continue;
    }
    const ownerKind = sim.services.facilityList()[owner]?.kind ?? kind;
    const capacity = sim.services.capacityOfKind(ownerKind);
    out.push({
      label,
      value: sim.services.qualityOf(owner),
      over: capacity > 0 && sim.services.loadOf(owner) > capacity,
    });
  }
  out.push({ label: '쓰레기', value: sim.services.qualityAt(bx, by, span, 14) });
  out.push({ label: '장의', value: sim.services.qualityAt(bx, by, span, 15) });
  return out;
}

/** 복지 충족(0~1)과 부족할 때의 칩 글. */
export function buildingAmenity(
  sim: MacroSim,
  bx: number,
  by: number,
  span: number,
  level: number,
): { value: number; problem: string | null } {
  const tier = level - 1;
  const score = sim.services.amenityForBuilding(bx, by, span);
  const value = Math.min(1, score / AMENITY_NEED_BY_TIER[tier]);
  return { value, problem: value >= 1 ? null : `${TIER_NAMES[tier]} 복지 부족` };
}
