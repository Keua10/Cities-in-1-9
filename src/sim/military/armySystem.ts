import { chunkIndexOf, chunkKey, parseChunkKey } from '../../core/iso';
import type { MacroState } from '../../net/types';
import {
  AA_BOMB_REDUCE_EACH,
  AIRLIFT_AIRPORTS,
  AIRLIFT_COST,
  AIRLIFT_RANGE_CHUNKS,
  AIRLIFT_BASE_MS,
  AIRLIFT_PER_CHUNK_MS,
  AA_BOMB_REDUCE_MAX,
  AA_INTERCEPT_EACH,
  AA_INTERCEPT_MAX,
  BOMB_FACILITY_VALUE,
  DRAFT_SHARE,
  FAC_BARRACKS,
  FAC_MISSILE_DEFENSE,
  FAC_MUNITIONS,
  FAC_NAVAL_BASE,
  FAC_RADAR,
  FAC_TRENCH,
  MISSILE_DEFENSE_INTERCEPT,
  MISSILE_DEFENSE_RANGE,
  MISSILE_FACILITY_VALUE,
  MISSILE_ORG_LOSS,
  MISSILE_RANGE_CHUNKS,
  MISSILE_UNIT_LOSS,
  MUNITIONS_SPEEDUP,
  RADAR_VISION_CHUNKS,
  VISION_CHUNKS,
  COMM_TOWER_VISION,
  HOSPITAL_RANGE_CHUNKS,
  UNIT_SPECS,
  unitStrength,
  type UnitType,
} from '../config/military';
import { FACILITY_SPECS } from '../facilities';
import { chunkTerrain } from './terrain';
import { visionAt } from './weather';
import { RESOURCE_NAMES } from '../config/resources';
import type { ResourceSystem } from '../resources';
import type { FacilityRecord } from '../services';
import type { TerritorySystem } from '../territory';
import {
  addStrike,
  loseMen,
  ownerOf,
  strikeRoll,
  type Strike,
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
  /** 이번 걸음의 사건(점령 등)을 전쟁 연결이 받아 간다. */
  onEvents?: (events: BattleEvent[]) => void;
  /** 상대가 내보낸 폭격·미사일(내 기기가 요격·피해를 계산한다). */
  enemyStrikes?: Strike[];
  /** 같은 진영 도시들의 땅(지나가고 쉬고 보급받을 수 있다). */
  allyOwned?: Set<string>;
  /** 소규모 전쟁 상대의 땅: 미사일을 쓸 수 없다. */
  noMissile?: Set<string>;
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
  /** 폭격·미사일에 맞은 시설을 헌다(macro 가 넣어 준다). 헐었으면 true. */
  destroyFacility: ((f: FacilityRecord) => boolean) | null = null;
  private raidWarnedAt = 0;

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
    this.scoutSet = new Set(Array.isArray(macro.scouted) ? macro.scouted : []);
  }

  private scoutSet: Set<string>;
  /** 가 본 곳이 늘 때마다 1 씩(대륙 지도가 다시 그릴지 본다). */
  scoutRevision = 0;

  /** 부대가 가 본 청크(시야 2청크). 대륙 지도에서 선명하게 보이고 다른 도시를 찾는다. */
  scouted(): ReadonlySet<string> {
    return this.scoutSet;
  }

  /** 부대 둘레(시야)를 가 본 곳에 더한다. */
  private scout(now: number): void {
    let added = 0;
    const v = visionAt(now, VISION_CHUNKS);
    for (const u of this.army.units) {
      if (u.state === 'training' || u.airlift || UNIT_SPECS[u.type].domain === 'strike') continue;
      for (let dy = -v; dy <= v; dy++)
        for (let dx = -v; dx <= v; dx++) {
          const k = chunkKey(u.cx + dx, u.cy + dy);
          if (this.scoutSet.has(k)) continue;
          this.scoutSet.add(k);
          added++;
        }
    }
    if (!added) return;
    this.macro.scouted = [...this.scoutSet];
    this.scoutRevision++;
    this.changed();
  }

  get units(): readonly Unit[] {
    return this.army.units;
  }

  /** 군대에 가 있는 총인원(식량 소비에 더한다). */
  get soldiers(): number {
    return this.army.units.reduce((s, u) => s + (UNIT_SPECS[u.type].men ? u.men : 0), 0);
  }

  /** 하루 유지비(돈). */
  get upkeepMoney(): number {
    return this.army.units.reduce(
      (s, u) => s + UNIT_SPECS[u.type].upkeep * (u.men / unitStrength(u.type)),
      0,
    );
  }

  barracks(): FacilityRecord[] {
    return this.producers(FAC_BARRACKS);
  }

  /** 이 시설(도로에 이어진 것)들. */
  producers(kind: number): FacilityRecord[] {
    return this.facilities().filter((f) => f.kind === kind && f.hasRoad);
  }

  /** 군수 공장이 있으면 생산 시간 −30%. */
  buildFactor(): number {
    return this.producers(FAC_MUNITIONS).length ? 1 - MUNITIONS_SPEEDUP : 1;
  }

  /** 하루 석유 소모(기계 부대). */
  get fuelPerDay(): number {
    return this.army.units.reduce(
      (s, u) => s + UNIT_SPECS[u.type].fuel * (u.men / unitStrength(u.type)),
      0,
    );
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
    if (!this.producers(spec.facility).length)
      return `도로에 이어진 ${FACILITY_SPECS[spec.facility].name}이(가) 있어야 합니다`;
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
    // 생산 시설이 여럿이면 차례로.
    const list = this.producers(spec.facility);
    const b = list[this.army.nextId % list.length];
    const at = { cx: chunkIndexOf(b.tx + (b.span >> 1)), cy: chunkIndexOf(b.ty + (b.span >> 1)) };
    if (spec.domain === 'sea') {
      // 군함은 기지 옆 바다에서 나온다.
      const sea = nearestSea(at.cx, at.cy);
      if (sea) Object.assign(at, sea);
    }
    newUnit(this.army, type, at, source, now, this.buildFactor());
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
    if (UNIT_SPECS[u.type].domain === 'strike') return this.launch(id, cx, cy, now);
    if (u.airlift) return '비행기로 날아가는 중입니다';
    const bf = this.battlefield(now);
    const path = findPath(u, { cx, cy }, u.type, bf);
    if (!path.length)
      return UNIT_SPECS[u.type].domain === 'air'
        ? '내 땅에서 12청크 안까지만 날아갈 수 있습니다'
        : UNIT_SPECS[u.type].domain === 'sea'
          ? '군함은 바다로만 갑니다'
          : '갈 수 있는 길이 없습니다 (바다·산·남의 영토)';
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
    const canSail = this.producers(FAC_NAVAL_BASE).length > 0;
    const hospitals = new Set<string>();
    const police = new Set<string>();
    for (const f of this.facilities()) {
      const cx = chunkIndexOf(f.tx);
      const cy = chunkIndexOf(f.ty);
      if (f.kind === FAC_HOSPITAL_KIND)
        for (let dy = -HOSPITAL_RANGE_CHUNKS; dy <= HOSPITAL_RANGE_CHUNKS; dy++)
          for (let dx = -HOSPITAL_RANGE_CHUNKS; dx <= HOSPITAL_RANGE_CHUNKS; dx++)
            hospitals.add(chunkKey(cx + dx, cy + dy));
      else if (f.kind === FAC_POLICE_KIND) police.add(chunkKey(cx, cy));
    }
    return {
      uid: this.uid,
      units: this.army.units,
      owned,
      capital,
      trenches,
      urban,
      canSail,
      hospitals,
      police,
    };
  }

  battlefield(now: number): Battlefield {
    const me = this.mySide();
    const war = this.war;
    if (war?.allyOwned?.size) for (const k of war.allyOwned) me.owned.add(k);
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
    if (this.war?.paused) return [];
    const struck = this.resolveStrikes(now);
    if (!this.army.units.length) {
      if (struck.length) this.emit(struck);
      return struck;
    }
    this.scout(now);
    // 오래 비웠다 돌아오면 한 번에 최대 10분만 진행한다(이동·훈련).
    const span = Math.min(dt, 10 * 60_000);
    const events: BattleEvent[] = [];
    for (let t = 0; t < span; t += 1000) {
      const step = Math.min(1000, span - t);
      events.push(...stepArmy(this.army, this.battlefield(now - span + t + step), step));
    }
    events.push(...struck, ...this.radar(now));
    if (events.length) this.emit(events);
    return events;
  }

  /** 대륙 지도 애니메이션용 최근 효과(3초). 화면만 쓰고 저장하지 않는다. */
  effects: MapEffect[] = [];

  private emit(events: BattleEvent[]): void {
    const at = performance.now();
    this.effects = this.effects.filter((e) => at - e.at < 3000);
    for (const e of events) {
      if (e.type === 'strike')
        this.effects.push({
          kind: e.kind === 'missile' ? 'missile' : 'bomb',
          key: e.key,
          from: e.from,
          at,
        });
      else if (e.type === 'struck')
        this.effects.push({ kind: e.intercepted ? 'intercept' : 'boom', key: e.key, at });
      else if (e.type === 'occupied') this.effects.push({ kind: 'occupy', key: e.key, at });
      else if (e.type === 'engaged') this.effects.push({ kind: 'clash', key: e.key, at });
    }
    if (this.effects.length > 40) this.effects.splice(0, this.effects.length - 40);
    for (const e of events) this.onEvent?.(e);
    this.war?.onEvents?.(events);
    this.bump();
  }

  /** 미사일을 (cx,cy) 에 쏜다. 전쟁 중 적 땅만, 미사일 기지에서 60청크 안. */
  launch(id: string, cx: number, cy: number, now = Date.now()): string {
    const u = this.army.units.find((x) => x.id === id);
    if (!u || u.type !== 'missile') return '미사일이 없습니다';
    if (u.state === 'training') return '아직 만드는 중입니다';
    const war = this.war;
    if (!war) return '전쟁 중에만 쏠 수 있습니다';
    if (war.paused) return '전쟁이 멈춰 있습니다';
    const bf = this.battlefield(now);
    const key = chunkKey(cx, cy);
    if (ownerOf(bf, key) !== war.enemy.uid) return '적 땅에만 쏠 수 있습니다';
    if (war.noMissile?.has(key)) return '소규모 전쟁에서는 미사일을 쓸 수 없습니다';
    if (war.capitalProtected && war.enemy.capital.has(key))
      return '소규모 전쟁에서는 수도를 칠 수 없습니다';
    if (Math.max(Math.abs(u.cx - cx), Math.abs(u.cy - cy)) > MISSILE_RANGE_CHUNKS)
      return `사거리(${MISSILE_RANGE_CHUNKS}청크) 밖입니다`;
    addStrike(this.army, {
      id: `${this.uid.slice(0, 6)}-${u.id}-${now}`,
      kind: 'missile',
      key,
      at: now,
      power: UNIT_SPECS.missile.attack,
    });
    this.army.units = this.army.units.filter((x) => x !== u);
    this.emit([{ type: 'strike', key, kind: 'missile', from: chunkKey(u.cx, u.cy) }]);
    return '';
  }

  /** 이 청크에 도로에 이어진 내 공항(공중 수송 출발지)이 있는가. */
  airportAt(cx: number, cy: number): boolean {
    return this.facilities().some(
      (f) =>
        f.hasRoad &&
        (AIRLIFT_AIRPORTS as readonly number[]).includes(f.kind) &&
        chunkIndexOf(f.tx) <= cx &&
        cx <= chunkIndexOf(f.tx + f.span - 1) &&
        chunkIndexOf(f.ty) <= cy &&
        cy <= chunkIndexOf(f.ty + f.span - 1),
    );
  }

  /** 공중 수송을 막는 이유(빈 문자열 = 가능). */
  airliftBlock(id: string, cx: number, cy: number, now = Date.now()): string {
    const u = this.army.units.find((x) => x.id === id);
    if (!u) return '부대가 없습니다';
    if (UNIT_SPECS[u.type].domain !== 'ground') return '땅 부대만 비행기로 옮길 수 있습니다';
    if (u.state === 'training') return '아직 훈련 중입니다';
    if (u.airlift) return '이미 날아가는 중입니다';
    if (u.state === 'fighting') return '전투 중에는 탈 수 없습니다';
    if (this.war?.paused) return '전쟁이 멈춰 있습니다';
    if (!this.airportAt(u.cx, u.cy)) return '부대가 내 공항이 있는 청크에 있어야 합니다';
    const bf = this.battlefield(now);
    if (ownerOf(bf, chunkKey(cx, cy)) !== this.uid)
      return '내 땅(점령지 포함)에만 내릴 수 있습니다';
    if (Math.max(Math.abs(u.cx - cx), Math.abs(u.cy - cy)) > AIRLIFT_RANGE_CHUNKS)
      return `${AIRLIFT_RANGE_CHUNKS}청크 안까지만 날아갈 수 있습니다`;
    if (this.macro.money < AIRLIFT_COST) return '수송비가 모자랍니다';
    return '';
  }

  /** 공중 수송: 공항에서 내 땅으로(30초 + 청크당 1.5초). */
  airlift(id: string, cx: number, cy: number, now = Date.now()): string {
    const why = this.airliftBlock(id, cx, cy, now);
    if (why) return why;
    const u = this.army.units.find((x) => x.id === id)!;
    const dist = Math.max(Math.abs(u.cx - cx), Math.abs(u.cy - cy));
    this.macro.money -= AIRLIFT_COST;
    u.path = [];
    u.progress = 0;
    u.state = 'moving';
    delete u.occupyKey;
    delete u.occupyAt;
    u.airlift = {
      from: chunkKey(u.cx, u.cy),
      to: chunkKey(cx, cy),
      departAt: now,
      arriveAt: now + AIRLIFT_BASE_MS + dist * AIRLIFT_PER_CHUNK_MS,
    };
    this.bump();
    return '';
  }

  /** 미사일 기지에 보관 중인 미사일. */
  missiles(): Unit[] {
    return this.army.units.filter((u) => u.type === 'missile' && u.state !== 'training');
  }

  /** 상대가 보낸 폭격·미사일을 한 번씩 처리한다(요격 → 부대 피해 → 시설 파괴). */
  private resolveStrikes(now: number): BattleEvent[] {
    const list = this.war?.enemyStrikes;
    if (!list?.length) return [];
    const done = (this.army.struckBy ??= {});
    for (const [id, at] of Object.entries(done)) if (now - at > 60 * 60_000) delete done[id];
    const out: BattleEvent[] = [];
    for (const s of list) {
      if (done[s.id] || now - s.at > 15 * 60_000) continue;
      done[s.id] = now;
      const { cx, cy } = parseChunkKey(s.key);
      const near = (r: number) =>
        this.army.units.filter(
          (u) =>
            u.type === 'aa' &&
            u.state !== 'training' &&
            Math.max(Math.abs(u.cx - cx), Math.abs(u.cy - cy)) <= r,
        ).length;
      let power = s.power;
      let intercepted = false;
      if (s.kind === 'missile') {
        const shield = this.producers(FAC_MISSILE_DEFENSE).some(
          (f) =>
            Math.max(Math.abs(chunkIndexOf(f.tx) - cx), Math.abs(chunkIndexOf(f.ty) - cy)) <=
            MISSILE_DEFENSE_RANGE,
        )
          ? MISSILE_DEFENSE_INTERCEPT
          : 0;
        const aa = Math.min(AA_INTERCEPT_MAX, near(0) * AA_INTERCEPT_EACH);
        intercepted = strikeRoll(s.id) < 1 - (1 - shield) * (1 - aa);
      } else power *= 1 - Math.min(AA_BOMB_REDUCE_MAX, near(1) * AA_BOMB_REDUCE_EACH);
      const destroyed: string[] = [];
      if (!intercepted) {
        if (s.kind === 'missile')
          for (const u of this.army.units) {
            if (u.cx !== cx || u.cy !== cy || UNIT_SPECS[u.type].domain === 'strike') continue;
            loseMen(this.army, u, u.men * MISSILE_UNIT_LOSS);
            u.org = Math.max(0, u.org - MISSILE_ORG_LOSS);
          }
        let budget = power * (s.kind === 'missile' ? MISSILE_FACILITY_VALUE : BOMB_FACILITY_VALUE);
        const targets = this.facilities()
          .filter((f) => chunkIndexOf(f.tx) === cx && chunkIndexOf(f.ty) === cy)
          .sort((a, b) => FACILITY_SPECS[b.kind].cost - FACILITY_SPECS[a.kind].cost);
        for (const f of targets) {
          const cost = FACILITY_SPECS[f.kind].cost;
          if (cost > budget) continue;
          if (!this.destroyFacility?.(f)) continue;
          budget -= cost;
          destroyed.push(FACILITY_SPECS[f.kind].name);
          // 부서진 시설 건설비는 상대 전쟁 점수가 된다.
          this.army.lossValue = (this.army.lossValue ?? 0) + cost;
        }
      }
      out.push({ type: 'struck', key: s.key, kind: s.kind, intercepted, destroyed });
    }
    return out;
  }

  /** 레이더: 적 공군이 레이더 6청크 안에 들어오면 공습 경보(1분에 한 번). */
  private radar(now: number): BattleEvent[] {
    const enemy = this.war?.enemy;
    if (!enemy || now - this.raidWarnedAt < 60_000) return [];
    const radars = this.producers(FAC_RADAR);
    if (!radars.length) return [];
    for (const e of enemy.units) {
      if (UNIT_SPECS[e.type].domain !== 'air' || e.state === 'training') continue;
      for (const r of radars)
        if (
          Math.max(Math.abs(chunkIndexOf(r.tx) - e.cx), Math.abs(chunkIndexOf(r.ty) - e.cy)) <=
          RADAR_VISION_CHUNKS
        ) {
          this.raidWarnedAt = now;
          return [{ type: 'airRaid', key: chunkKey(e.cx, e.cy) }];
        }
    }
    return [];
  }

  /** 시야: 부대 둘레 2청크 + 레이더 둘레 6청크(대륙 지도에서 적 부대 보이기). */
  visionSources(): Array<{ cx: number; cy: number; r: number }> {
    const out: Array<{ cx: number; cy: number; r: number }> = [];
    for (const r of this.producers(FAC_RADAR))
      out.push({ cx: chunkIndexOf(r.tx), cy: chunkIndexOf(r.ty), r: RADAR_VISION_CHUNKS });
    for (const t of this.facilities())
      if (t.kind === FAC_COMM_TOWER_KIND)
        out.push({ cx: chunkIndexOf(t.tx), cy: chunkIndexOf(t.ty), r: COMM_TOWER_VISION });
    return out;
  }

  private bump(): void {
    this.revision++;
    this.changed();
  }
}

/** 대륙 지도에 잠깐 그리는 효과. at = performance.now(). */
export interface MapEffect {
  kind: 'missile' | 'bomb' | 'boom' | 'intercept' | 'occupy' | 'clash';
  key: string;
  /** 미사일이 날아오른 청크. */
  from?: string;
  at: number;
}

/** 민간 시설 kind: 경찰서 1, 병원 2, 통신탑 17. */
const FAC_POLICE_KIND = 1;
const FAC_HOSPITAL_KIND = 2;
const FAC_COMM_TOWER_KIND = 17;

/** (cx,cy) 둘레 3청크 안 가장 가까운 바다 청크. */
function nearestSea(cx: number, cy: number): { cx: number; cy: number } | null {
  for (let r = 1; r <= 3; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (
          Math.max(Math.abs(dx), Math.abs(dy)) === r &&
          chunkTerrain(cx + dx, cy + dy).kind === 'sea'
        )
          return { cx: cx + dx, cy: cy + dy };
  return null;
}
