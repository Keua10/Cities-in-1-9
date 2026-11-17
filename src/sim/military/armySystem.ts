import { chunkIndexOf, chunkKey, parseChunkKey } from '../../core/iso';
import type { MacroState } from '../../net/types';
import {
  DRAFT_SHARE,
  FAC_BARRACKS,
  FAC_TRENCH,
  UNIT_SPECS,
  type UnitType,
} from '../config/military';
import { RESOURCE_NAMES } from '../config/resources';
import type { ResourceSystem } from '../resources';
import type { FacilityRecord } from '../services';
import type { TerritorySystem } from '../territory';
import {
  draftMen,
  draftRoom,
  findPath,
  newUnit,
  normalizeArmy,
  removeUnit,
  stepArmy,
  type ArmyState,
  type Battlefield,
  type BattleEvent,
  type Side,
  type Unit,
} from './army';

/**
 * 도시 쪽 군대 관리 (군사 4단계): 징병·해산·이동 명령·유지비. 저장은 macro.army.
 *
 * 평시에는 내 부대만 움직인다(남의 영토로는 못 간다). 전쟁 중에는 전쟁 연결(war)이
 * 상대 부대와 점령 상태를 넣어 준다(net/warSession.ts).
 */

export interface WarLink {
  enemy: Side;
  occupied: Map<string, string>;
  capitalProtected: boolean;
  /** 일시정지(한쪽 접속 끊김) 동안은 부대가 멈춘다. */
  paused: boolean;
}

/** 시가전으로 보는 청크: 거주+유동 인구가 이 이상. */
export const URBAN_PEOPLE = 400;

export class ArmySystem {
  readonly army: ArmyState;
  private lastAt = 0;
  /** 전쟁 중이면 전쟁 연결. */
  war: WarLink | null = null;
  /** 평시 남의 영토(대륙 지도를 열면 채워진다). */
  foreignOwned = new Set<string>();
  onEvent: ((e: BattleEvent) => void) | null = null;
  /** 부대가 바뀔 때마다 오른다(화면 다시 그리기). */
  revision = 0;
  /** 내 uid(전쟁에서 점령 표시에 쓴다). 둘러보기는 'me'. */
  uid = 'me';

  constructor(
    private macro: MacroState,
    private territory: TerritorySystem,
    private resources: ResourceSystem,
    private facilities: () => readonly FacilityRecord[],
    private cityLevel: () => number,
    private changed: () => void,
  ) {
    this.army = normalizeArmy(macro.army);
    macro.army = this.army;
  }

  get units(): readonly Unit[] {
    return this.army.units;
  }

  /** 군대에 가 있는 총인원(식량 소비에 더한다). */
  get soldiers(): number {
    return this.army.units.reduce((s, u) => s + u.men, 0);
  }

  /** 하루 유지비(돈). */
  get upkeepMoney(): number {
    return this.army.units.reduce(
      (s, u) => s + UNIT_SPECS[u.type].upkeep * (u.men / (UNIT_SPECS[u.type].men || 1)),
      0,
    );
  }

  barracks(): FacilityRecord[] {
    return this.facilities().filter((f) => f.kind === FAC_BARRACKS && f.hasRoad);
  }

  /** 징병에 쓸 청크별 원래 거주 인구(내 영토만). */
  private residents(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [key, p] of this.territory.people) {
      if (p.raw <= 0) continue;
      const { cx, cy } = parseChunkKey(key);
      if (this.territory.isOwned(cx, cy)) out.set(key, p.raw);
    }
    return out;
  }

  draftRoom(): number {
    return draftRoom(this.army, this.residents(), DRAFT_SHARE);
  }

  /** 이 병종을 지금 뽑을 수 없는 이유. 빈 문자열이면 된다. */
  recruitBlock(type: UnitType): string {
    const spec = UNIT_SPECS[type];
    if (!spec.available) return `${spec.name}은 다음 단계에서 열립니다`;
    if (this.cityLevel() < spec.unlock) return `도시 레벨 ${spec.unlock}부터 뽑을 수 있습니다`;
    if (!this.barracks().length) return '도로에 이어진 병영이 있어야 합니다';
    if (this.macro.money < spec.cost) return '돈이 모자랍니다';
    const stock = this.resources.stockNow;
    if (stock.iron < spec.iron) return `${RESOURCE_NAMES.iron}이 ${spec.iron} 필요합니다`;
    if (stock.coal < spec.coal) return `${RESOURCE_NAMES.coal}이 ${spec.coal} 필요합니다`;
    if (stock.oil < spec.oil) return `${RESOURCE_NAMES.oil}가 ${spec.oil} 필요합니다`;
    if (spec.men && this.draftRoom() < spec.men)
      return `징병할 사람이 모자랍니다 (청크마다 거주 인구의 20%까지 · 지금 ${this.draftRoom()}명)`;
    return '';
  }

  recruit(type: UnitType, now = Date.now()): string {
    const why = this.recruitBlock(type);
    if (why) return why;
    const spec = UNIT_SPECS[type];
    const source = spec.men ? draftMen(this.army, this.residents(), spec.men, DRAFT_SHARE) : {};
    if (!source) return '징병할 사람이 모자랍니다';
    this.macro.money -= spec.cost;
    if (spec.iron) this.resources.addStock('iron', -spec.iron);
    if (spec.coal) this.resources.addStock('coal', -spec.coal);
    if (spec.oil) this.resources.addStock('oil', -spec.oil);
    // 생산 시간이 짧게 남은 병영에서(병영이 여럿이면 차례로).
    const list = this.barracks();
    const b = list[this.army.nextId % list.length];
    newUnit(this.army, type, { cx: chunkIndexOf(b.tx), cy: chunkIndexOf(b.ty) }, source, now);
    this.bump();
    return '';
  }

  disband(id: string): void {
    removeUnit(this.army, id, true);
    this.bump();
  }

  /** 부대 id 를 (cx,cy) 로 보낸다. 길이 없으면 이유. */
  order(id: string, cx: number, cy: number, now = Date.now()): string {
    const u = this.army.units.find((x) => x.id === id);
    if (!u) return '부대가 없습니다';
    if (u.state === 'training') return '아직 훈련 중입니다';
    const bf = this.battlefield(now);
    const path = findPath(u, { cx, cy }, u.type, bf);
    if (!path.length) return '갈 수 있는 길이 없습니다 (바다·산·남의 영토)';
    u.path = path;
    u.progress = 0;
    if (u.state !== 'fighting') u.state = 'moving';
    else u.state = 'retreating'; // 싸우는 중에 다른 곳으로 보내면 빠져나간다.
    this.bump();
    return '';
  }

  /** 내 쪽 전장 정보. */
  mySide(): Side {
    const owned = new Set(this.territory.ownedKeys());
    const capital = new Set<string>();
    const cap = this.territory.capitalRect();
    for (let y = cap.cy; y < cap.cy + cap.span; y++)
      for (let x = cap.cx; x < cap.cx + cap.span; x++) capital.add(chunkKey(x, y));
    const trenches = new Set<string>();
    for (const f of this.facilities())
      if (f.kind === FAC_TRENCH) trenches.add(chunkKey(chunkIndexOf(f.tx), chunkIndexOf(f.ty)));
    const urban = new Set<string>();
    for (const [key, p] of this.territory.people)
      if (p.residents + p.floating >= URBAN_PEOPLE) urban.add(key);
    return { uid: this.uid, units: this.army.units, owned, capital, trenches, urban };
  }

  battlefield(now: number): Battlefield {
    const me = this.mySide();
    const war = this.war;
    return {
      now,
      me,
      enemy: war ? war.enemy : null,
      occupied: war ? war.occupied : new Map(),
      capitalProtected: war ? war.capitalProtected : true,
      foreign: (key) => this.foreignOwned.has(key),
    };
  }

  /** 실제 시간으로 부른다. */
  update(now = Date.now()): BattleEvent[] {
    if (!this.lastAt) this.lastAt = now;
    const dt = now - this.lastAt;
    if (dt < 250) return [];
    this.lastAt = now;
    if (!this.army.units.length || this.war?.paused) return [];
    // 오래 비웠다 돌아오면 한 번에 최대 10분만 진행한다(이동·훈련).
    const span = Math.min(dt, 10 * 60_000);
    const events: BattleEvent[] = [];
    for (let t = 0; t < span; t += 1000) {
      const step = Math.min(1000, span - t);
      events.push(...stepArmy(this.army, this.battlefield(now - span + t + step), step));
    }
    if (events.length) {
      for (const e of events) this.onEvent?.(e);
      this.bump();
    }
    return events;
  }

  private bump(): void {
    this.revision++;
    this.changed();
  }
}
