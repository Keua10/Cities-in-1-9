import {
  collection,
  deleteField,
  doc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { parseChunkKey } from '../core/iso';
import {
  CEASEFIRE_PEACE_MS,
  DEFEAT_PEACE_MS,
  WAR_PREP_MS,
  WAR_STALE_MS,
  WAR_SYNC_MS,
} from '../sim/config/war';
import type { MacroSim } from '../sim/macro';
import type { Side, Unit } from '../sim/military/army';
import type { WarLink } from '../sim/military/armySystem';
import {
  capitalOpen,
  ceasefireAccepted,
  ceasefireDead,
  ceasefireDue,
  ceasefireNeeded,
  ceasefireYes,
  contributions,
  declareBlock,
  isBigBattle,
  joinBlock,
  judge,
  judgeDue,
  landProtected,
  membersOf,
  mergeAllClaims,
  otherSide,
  reparations,
  shareOf,
  sideOf,
  sideScore,
  surpriseBlock,
  surrenderAccepted,
  unitValue,
  type CompactUnit,
  type SideDoc,
  type WarDoc,
  type WarKind,
  type WarSide,
} from '../sim/military/warRules';
import { sharedNow } from '../sim/sharedClock';
import { UNIT_SPECS } from '../sim/config/military';
import type { AllianceSession } from './alliances';
import { loadSettings } from './admin';
import { getFirebase } from './firebase';
import type { PublicCity } from './publicCities';

/**
 * 전쟁 연결 (군사 4·5단계).
 *
 *   wars/{id}              양쪽 uid·상태·시작 시각·결과·배상. 둘 다 고칠 수 있다.
 *   wars/{id}/sides/{uid}  한쪽의 전장 스냅숏(부대·점령 주장·잃은 병력 가치). 자기 것만 쓴다.
 *
 * 내 기기는 내 부대만 움직이고 내 부대가 받는 피해만 계산한다. 상대 부대는 상대 스냅숏으로
 * 본다. 상대 스냅숏이 20초 넘게 안 오면 상대가 끊긴 것 — 전쟁만 멈춘다(공사·경제는 계속).
 * 끊긴 지 24시간이 지나면 점수로 판정한다. 상태 전환은 먼저 알아챈 쪽이 문서에 적는다.
 */

export interface WarStatus {
  war: WarDoc | null;
  enemyName: string;
  phase: 'none' | 'prep' | 'active' | 'paused' | 'ended';
  /** 준비 끝까지·휴전까지 남은 ms. */
  prepLeftMs: number;
  scoreMe: number;
  scoreEnemy: number;
  /** 상대가 항복을 신청했다(내가 받아들일 수 있다). */
  surrenderOffered: boolean;
  /** 우리 진영이 항복을 신청해 둔 상태. */
  surrenderPending: boolean;
  /** 내가 진영 대표(선포한 쪽·받은 쪽)인가 — 항복 신청은 대표만. */
  isLeader: boolean;
  /** 올라와 있는 휴전 제안. */
  ceasefire: {
    byMe: boolean;
    byName: string;
    /** 내 표(아직 안 냈으면 undefined). */
    myVote: boolean | undefined;
    yes: number;
    needed: number;
    /** 직접 참여국 찬성 수(0~2, 둘 다 필요). */
    leadersYes: number;
  } | null;
  /** 우리 진영 다른 도시·상대 진영 도시 이름. */
  allies: string[];
  enemies: string[];
}

function compact(u: Unit): CompactUnit {
  return {
    id: u.id,
    t: u.type,
    m: Math.round(u.men * 10) / 10,
    o: Math.round(u.org * 10) / 10,
    mo: Math.round(u.morale * 100) / 100,
    x: u.cx,
    y: u.cy,
    p: Math.round(u.progress * 100) / 100,
    path: u.path.slice(0, 6),
    s: u.state,
    ...(u.arrivedAt ? { ar: u.arrivedAt } : {}),
  };
}

function expand(c: CompactUnit, owner = 'e'): Unit {
  return {
    id: `${owner.slice(0, 6)}:${c.id}`,
    type: c.t,
    men: c.m,
    maxMen: c.m,
    org: c.o,
    morale: c.mo,
    exp: 0,
    cx: c.x,
    cy: c.y,
    progress: c.p,
    path: c.path ?? [],
    state: c.s as Unit['state'],
    arrivedAt: c.ar,
    source: {},
  };
}

/** 전장에서 상대 진영 전체를 하나로 묶어 부르는 이름(점령 표시용). */
const ENEMY = '#enemy';

export class WarSession {
  /** 동맹 연결. 동맹에게 선전포고하면 배신(보증금이 상대에게). */
  alliances: AllianceSession | null = null;
  /** 나와 관련된 전쟁 전부(끝난 것 포함). */
  wars: WarDoc[] = [];
  /** 참가할 수 있는 다른 도시들의 대규모 전쟁(준비·전투 중). */
  openLarge: WarDoc[] = [];
  private unsubWars: Unsubscribe | null = null;
  private unsubOpen: Unsubscribe | null = null;
  private unsubSides: Unsubscribe | null = null;
  private sideWarId = '';
  /** 이 전쟁 참가국들의 전장 스냅숏. */
  private sides = new Map<string, SideDoc>();
  private claims: Record<string, number> = {};
  private lossAtStart = 0;
  private bigBattleAt = 0;
  private menAtStart = 0;
  private lastSync = 0;
  private timer: number | null = null;
  /** 상태가 바뀔 때(화면 알림). */
  onNotice: ((text: string) => void) | null = null;
  revision = 0;

  constructor(
    private uid: string,
    private sim: MacroSim,
    private myName: string,
  ) {}

  start(): void {
    const fb = getFirebase();
    if (!fb) return;
    this.unsubWars = onSnapshot(
      query(collection(fb.db, 'wars'), where('parties', 'array-contains', this.uid)),
      (snap) => {
        const before = this.current();
        const prevJoined = Object.keys(before?.joined ?? {});
        this.wars = snap.docs.map((d) => ({ ...(d.data() as WarDoc), id: d.id }));
        const now = this.current();
        if (now && !before) {
          const mine = sideOf(now, this.uid);
          const enemy = mine ? now[otherSide(mine)] : now.a;
          this.onNotice?.(
            now.a === this.uid
              ? `선전포고했습니다 · ${now.names[enemy] ?? '상대'}${now.surprise ? ' · 기습!' : ' · 5분 뒤 개전'}`
              : now.joined?.[this.uid]
                ? `${now.names[now[mine!]] ?? '동맹'} 진영으로 전쟁에 참가했습니다`
                : `⚠ ${now.names[now.a] ?? '다른 도시'}이(가) ${now.surprise ? '기습해 왔습니다!' : '선전포고했습니다 · 5분 뒤 개전'}`,
          );
        }
        if (now && before && now.id === before.id)
          for (const u of Object.keys(now.joined ?? {}))
            if (!prevJoined.includes(u) && u !== this.uid)
              this.onNotice?.(
                `${now.names[u] ?? '다른 도시'}이(가) ${sideOf(now, u) === sideOf(now, this.uid) ? '우리' : '상대'} 진영으로 참가했습니다`,
              );
        if (
          before &&
          now &&
          before.surrender?.by !== now.surrender?.by &&
          now.surrender &&
          sideOf(now, now.surrender.by) !== sideOf(now, this.uid)
        )
          this.onNotice?.('상대가 항복을 신청했습니다 · 대륙 지도에서 받아들일 수 있습니다');
        if (
          now &&
          now.ceasefireOffer &&
          now.ceasefireOffer.by !== this.uid &&
          before?.ceasefireOffer?.at !== now.ceasefireOffer.at
        )
          this.onNotice?.(
            `🕊 ${now.names[now.ceasefireOffer.by] ?? '참가국'}이(가) 휴전을 제안했습니다 · 대륙 지도에서 찬성·반대`,
          );
        if (before?.ceasefireOffer && now && !now.ceasefireOffer && now.state !== 'ended')
          this.onNotice?.('휴전 제안이 무산되었습니다');
        this.revision++;
        this.attach();
      },
      (err) => console.warn('전쟁 구독 실패', err),
    );
    this.unsubOpen = onSnapshot(
      query(
        collection(fb.db, 'wars'),
        where('kind', '==', 'large'),
        where('state', 'in', ['prep', 'active']),
      ),
      (snap) => {
        this.openLarge = snap.docs
          .map((d) => ({ ...(d.data() as WarDoc), id: d.id }))
          .filter((w) => !w.parties.includes(this.uid));
        this.revision++;
      },
      (err) => console.warn('대규모 전쟁 목록 구독 실패', err),
    );
    this.timer = window.setInterval(() => this.tick(), 500);
  }

  stop(): void {
    this.unsubWars?.();
    this.unsubOpen?.();
    this.unsubSides?.();
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** 진행 중(준비·전투)인 내 전쟁. */
  current(): WarDoc | null {
    return this.wars.find((w) => w.state !== 'ended') ?? null;
  }

  /** 이 도시와 지금 전쟁 중인가(같은 전쟁의 상대 진영). */
  atWarWith(uid: string): boolean {
    const w = this.current();
    if (!w) return false;
    const a = sideOf(w, this.uid);
    const b = sideOf(w, uid);
    return !!a && !!b && a !== b;
  }

  /** 진행 중인 전쟁 참가국들의 스냅숏을 구독한다. */
  private attach(): void {
    const w = this.current();
    const fb = getFirebase();
    if (!w || !fb) {
      // 끝난 전쟁의 마지막 스냅숏은 정산할 때 서버에서 다시 읽는다.
      if (this.sideWarId) {
        this.unsubSides?.();
        this.unsubSides = null;
        this.sideWarId = '';
      }
      return;
    }
    if (this.sideWarId === w.id) return;
    this.unsubSides?.();
    this.sideWarId = w.id;
    this.sides = new Map();
    this.claims = {};
    this.lossAtStart = this.sim.army.army.lossValue ?? 0;
    this.menAtStart = this.sim.army.soldiers;
    this.bigBattleAt = 0;
    this.unsubSides = onSnapshot(collection(fb.db, 'wars', w.id, 'sides'), (snap) => {
      const next = new Map<string, SideDoc>();
      for (const d of snap.docs) if (d.id !== this.uid) next.set(d.id, d.data() as SideDoc);
      this.sides = next;
    });
  }

  private fresh(uid: string, now: number): SideDoc | null {
    const d = this.sides.get(uid);
    return d && now - d.at <= WAR_STALE_MS ? d : null;
  }

  /** 모든 참가국 점령 주장을 합친 것(내 주장은 지금 것). */
  private occupation(w: WarDoc): Map<string, string> {
    const list = [
      { uid: this.uid, claims: this.claims, owned: [...this.sim.territory.ownedKeys()] },
    ];
    for (const [uid, d] of this.sides)
      if (w.parties.includes(uid)) list.push({ uid, claims: d.claims ?? {}, owned: d.owned ?? [] });
    return mergeAllClaims(w, list);
  }

  /** 진영 점수 [내 진영, 상대 진영]. */
  private scores(w: WarDoc, occupied: Map<string, string>): [number, number] {
    const mine = sideOf(w, this.uid)!;
    const myLoss = (this.sim.army.army.lossValue ?? 0) - this.lossAtStart;
    let lossMine = myLoss;
    let lossTheirs = 0;
    for (const [uid, d] of this.sides) {
      const s = sideOf(w, uid);
      if (s === mine) lossMine += d.lossValue ?? 0;
      else if (s) lossTheirs += d.lossValue ?? 0;
    }
    return [
      sideScore(w, mine, occupied, lossTheirs),
      sideScore(w, otherSide(mine), occupied, lossMine),
    ];
  }

  /** 0.5초마다: 전쟁 연결 갱신, 스냅숏 보내기, 상태 전환, 정산. */
  private tick(): void {
    const now = sharedNow();
    this.settleEnded(now);
    const w = this.current();
    const army = this.sim.army;
    if (!w) {
      army.war = null;
      this.sim.atWar = false;
      this.sim.grantsEnabled = true;
      delete this.sim.state.warSince;
      return;
    }
    this.sim.atWar = true;
    this.sim.state.warSince ??= w.startsAt;
    this.sim.grantsEnabled = false;
    const mine = sideOf(w, this.uid)!;
    const enemies = membersOf(w, otherSide(mine));
    const allies = membersOf(w, mine).filter((u) => u !== this.uid);
    const freshEnemies = enemies.filter((u) => this.fresh(u, now));
    const stale = !freshEnemies.length;

    // 준비 → 전투
    if (w.state === 'prep' && now >= w.startsAt) void this.patch(w, { state: 'active' });

    // 내 스냅숏 보내기
    if (now - this.lastSync >= WAR_SYNC_MS && document.visibilityState === 'visible') {
      this.lastSync = now;
      void this.publishSide(w, now);
    }

    // 전쟁 연결: 상대 진영(지금 접속한 도시들)을 하나의 적으로 묶는다.
    if (w.state === 'active' && !stale) {
      const enemySide: Side = {
        uid: ENEMY,
        units: [],
        owned: new Set(),
        capital: new Set(),
        trenches: new Set(),
        urban: new Set(),
      };
      for (const uid of freshEnemies) {
        const d = this.fresh(uid, now)!;
        for (const c of d.units ?? []) enemySide.units.push(expand(c, uid));
        if (!landProtected(w, this.uid, uid)) for (const k of d.owned ?? []) enemySide.owned.add(k);
        if (!capitalOpen(w, uid)) for (const k of d.capital ?? []) enemySide.capital.add(k);
        for (const k of d.trenches ?? []) enemySide.trenches.add(k);
        for (const k of d.urban ?? []) enemySide.urban.add(k);
      }
      const allyOwned = new Set<string>();
      for (const uid of allies) for (const k of this.sides.get(uid)?.owned ?? []) allyOwned.add(k);
      // 전장에서는 우리 진영 점령 = 나, 상대 진영 점령 = ENEMY 로 본다.
      const occupied = new Map<string, string>();
      for (const [k, who] of this.occupation(w))
        occupied.set(k, sideOf(w, who) === mine ? this.uid : ENEMY);
      const strikes = enemies.flatMap((u) =>
        (this.sides.get(u)?.strikes ?? []).filter((x) => x.at >= w.startsAt),
      );
      const link: WarLink = {
        enemy: enemySide,
        occupied,
        capitalProtected: true,
        paused: false,
        enemyStrikes: strikes,
        allyOwned,
        onEvents: (events) => {
          for (const e of events) if (e.type === 'occupied') this.claims[e.key] = sharedNow();
        },
      };
      army.war = link;
      const foreign = new Set(this.sim.territory.foreign);
      for (const uid of enemies) for (const k of this.sides.get(uid)?.owned ?? []) foreign.add(k);
      this.sim.territory.foreign = foreign;
    } else if (w.state === 'active') {
      // 상대 진영이 모두 끊김: 전쟁만 멈춘다.
      if (army.war) army.war.paused = true;
    } else {
      // 준비 중에는 평시 규칙으로 배치만 한다.
      army.war = null;
    }

    // 일시정지 기록
    if (w.state === 'active') {
      if (stale && w.pausedAt === undefined) void this.patch(w, { pausedAt: now });
      if (!stale && w.pausedAt !== undefined) void this.patch(w, { pausedAt: deleteField() });
    }

    // 휴전 제안: 통과하면 휴전, 더 이상 통과할 수 없으면 거둔다.
    if (w.state !== 'ended' && w.ceasefireOffer) {
      if (ceasefireAccepted(w)) {
        void this.end(w, 'ceasefire', now, true);
        return;
      }
      if (ceasefireDead(w)) void this.patch(w, { ceasefireOffer: deleteField() });
    }

    // 항복이 받아들여졌으면 끝낸다(받는 진영 누구든 먼저 본 쪽이).
    if (w.state !== 'ended' && surrenderAccepted(w)) {
      const loser = sideOf(w, w.surrender!.by)!;
      void this.end(w, loser === 'a' ? 'winB' : 'winA', now);
      return;
    }

    // 판정·휴전
    if (w.state === 'active') {
      let last = this.bigBattleAt;
      for (const d of this.sides.values()) last = Math.max(last, d.bigBattleAt ?? 0);
      if (judgeDue(w, now)) {
        const [me, them] = this.scores(w, this.occupation(w));
        void this.end(w, mine === 'a' ? judge(me, them) : judge(them, me), now);
      } else if (!stale && ceasefireDue(w, last, now)) {
        void this.end(w, 'ceasefire', now);
      }
    }
  }

  private async publishSide(w: WarDoc, now: number): Promise<void> {
    const fb = getFirebase();
    if (!fb) return;
    const army = this.sim.army;
    const side = army.mySide();
    const fighting = army.units
      .filter((u) => u.state === 'fighting' && UNIT_SPECS[u.type].men > 0)
      .reduce((s, u) => s + u.men, 0);
    if (isBigBattle(fighting, Math.max(army.soldiers, this.menAtStart))) this.bigBattleAt = now;
    const docData: SideDoc = {
      at: now,
      units: army.units
        .filter((u) => u.state !== 'training' && UNIT_SPECS[u.type].domain !== 'strike')
        .map(compact),
      owned: [...side.owned],
      capital: [...side.capital],
      trenches: [...side.trenches],
      urban: [...side.urban],
      claims: this.claims,
      lossValue: Math.round((army.army.lossValue ?? 0) - this.lossAtStart),
      bigBattleAt: this.bigBattleAt,
      men: Math.round(this.menAtStart),
      strikes: (army.army.strikes ?? []).filter((x) => x.at >= w.startsAt),
    };
    try {
      await setDoc(doc(fb.db, 'wars', w.id, 'sides', this.uid), docData);
    } catch (err) {
      console.warn('전장 스냅숏 실패', err);
    }
  }

  private async patch(w: WarDoc, data: Record<string, unknown>): Promise<void> {
    const fb = getFirebase();
    if (!fb) return;
    try {
      await updateDoc(doc(fb.db, 'wars', w.id), data);
    } catch (err) {
      console.warn('전쟁 문서 갱신 실패', err);
    }
  }

  private ending = '';

  private async end(
    w: WarDoc,
    result: WarDoc['result'],
    now: number,
    agreed = false,
  ): Promise<void> {
    if (this.ending === w.id) return;
    this.ending = w.id;
    const peace =
      result === 'ceasefire' || result === 'truce' ? CEASEFIRE_PEACE_MS : DEFEAT_PEACE_MS;
    const occupied = this.occupation(w);
    const mine = sideOf(w, this.uid)!;
    const [me, them] = this.scores(w, occupied);
    // 기여도: 각자 마지막 스냅숏의 부대 가치 + 점령 청크.
    const armyValue: Record<string, number> = {
      [this.uid]: this.sim.army.units.reduce((s, u) => s + unitValue(u.type, u.men), 0),
    };
    for (const [uid, d] of this.sides)
      armyValue[uid] = (d.units ?? []).reduce((s, u) => s + unitValue(u.t, u.m), 0);
    await this.patch(w, {
      state: 'ended',
      result,
      endedAt: now,
      peaceUntil: now + peace,
      score: { [w[mine]]: me, [w[otherSide(mine)]]: them },
      contrib: contributions(w, occupied, armyValue),
      surrender: deleteField(),
      ceasefireOffer: deleteField(),
      ...(agreed ? { agreedCeasefire: true } : {}),
    });
  }

  private settling = false;

  /** 끝난 전쟁의 배상 주고받기. 한 번만(macro.warsSettled). */
  private settleEnded(now: number): void {
    if (this.settling) return;
    const settled = (this.sim.state.warsSettled ??= {});
    const list = this.wars.filter((x) => x.state === 'ended' && !settled[x.id]);
    if (!list.length) return;
    this.settling = true;
    void (async () => {
      for (const w of list) await this.settle(w, now);
    })().finally(() => {
      this.settling = false;
    });
  }

  private async settle(w: WarDoc, now: number): Promise<void> {
    const settled = (this.sim.state.warsSettled ??= {});
    const mine = sideOf(w, this.uid);
    const winner: WarSide | null = w.result === 'winA' ? 'a' : w.result === 'winB' ? 'b' : null;
    // 전후: 복구 속도(6시간 ×2, 패전 ×3), 승전 기분.
    const st = this.sim.state;
    if ((st.warEndedAt ?? 0) < (w.endedAt ?? now)) {
      st.warEndedAt = w.endedAt ?? now;
      st.warOutcome = !winner || !mine ? 'draw' : winner === mine ? 'win' : 'lose';
    }
    if (!mine || !winner) {
      settled[w.id] = now;
      this.onNotice?.(
        w.adminEnded
          ? '선생님이 전쟁을 멈췄습니다 · 배상 없음, 12시간 동안 다시 전쟁할 수 없습니다'
          : w.result === 'ceasefire'
            ? w.agreedCeasefire
              ? '휴전 협정 · 참가국 2/3 이상이 동의했습니다 · 배상 없음, 12시간 동안 다시 전쟁할 수 없습니다'
              : '휴전 · 큰 전투 없이 1시간이 지났습니다 · 12시간 동안 다시 전쟁할 수 없습니다'
            : '종전 협정 · 피해가 비슷해 배상 없이 끝났습니다',
      );
      this.done();
      return;
    }
    if (mine !== winner) {
      if (w.paid?.[this.uid]) {
        settled[w.id] = now;
        return;
      }
      // 마지막 스냅숏(모든 점령 주장)을 서버에서 읽는다 — 끊겼다 돌아와도 정산할 수 있게.
      const fb = getFirebase();
      if (!fb) return;
      let list: Array<{ uid: string; claims: Record<string, number>; owned: string[] }>;
      try {
        const snap = await getDocs(collection(fb.db, 'wars', w.id, 'sides'));
        list = snap.docs.map((d) => {
          const s = d.data() as SideDoc;
          return { uid: d.id, claims: s.claims ?? {}, owned: s.owned ?? [] };
        });
      } catch (err) {
        console.warn('정산용 스냅숏을 읽지 못했습니다', err);
        return;
      }
      const me = list.find((x) => x.uid === this.uid);
      if (me) me.owned = [...this.sim.territory.ownedKeys()];
      else list.push({ uid: this.uid, claims: {}, owned: [...this.sim.territory.ownedKeys()] });
      const occupied = mergeAllClaims(w, list);
      const chunks: Record<string, string[]> = {};
      const all: string[] = [];
      for (const [k, who] of occupied)
        if (sideOf(w, who) === winner && this.sim.territory.isOwned(...xy(k))) {
          (chunks[who] ??= []).push(k);
          all.push(k);
        }
      // 내가 낸다: 돈 25%, 자원 30%, 상대 진영이 점령한 내 땅.
      const pay = reparations(this.sim.money, this.sim.resources.stockNow);
      this.sim.adjustMoney(-pay.money);
      this.sim.resources.addStock('iron', -pay.iron);
      this.sim.resources.addStock('coal', -pay.coal);
      this.sim.resources.addStock('oil', -pay.oil);
      this.sim.territory.cede(all);
      settled[w.id] = now;
      await this.patch(w, { [`paid.${this.uid}`]: { ...pay, chunks } });
      this.onNotice?.(
        `패전 · 배상 ${Math.round(pay.money).toLocaleString('ko-KR')}만 원, 자원 30%, 영토 ${all.length}청크를 내줬습니다`,
      );
      this.done();
      return;
    }
    // 승전: 패전국마다 낸 배상을 기여도 비율로 받는다(패전국이 접속해 낼 때까지 기다린다).
    const share = shareOf(w, this.uid);
    const losers = membersOf(w, otherSide(winner));
    let got = 0;
    let money = 0;
    let land = 0;
    for (const l of losers) {
      const key = `${w.id}:${l}`;
      const p = w.paid?.[l];
      if (settled[key]) {
        got++;
        continue;
      }
      if (!p) continue;
      this.sim.adjustMoney(p.money * share);
      this.sim.resources.addStock('iron', Math.floor(p.iron * share));
      this.sim.resources.addStock('coal', Math.floor(p.coal * share));
      this.sim.resources.addStock('oil', Math.floor(p.oil * share));
      const mineChunks = p.chunks?.[this.uid] ?? [];
      this.sim.territory.annex(mineChunks);
      settled[key] = now;
      money += p.money * share;
      land += mineChunks.length;
      got++;
    }
    if (money || land)
      this.onNotice?.(
        `승전! 배상 ${Math.round(money).toLocaleString('ko-KR')}만 원과 영토 ${land}청크를 얻었습니다 · 새 땅은 도로로 이어 주세요`,
      );
    if (got === losers.length) {
      settled[w.id] = now;
      for (const l of losers) delete settled[`${w.id}:${l}`];
      this.done();
    }
  }

  private done(): void {
    this.claims = {};
    this.sim.army.war = null;
    this.revision++;
  }

  /* ---------------- 화면에서 부르는 것 ---------------- */

  status(): WarStatus {
    const w =
      this.current() ??
      this.wars
        .filter((x) => x.state === 'ended')
        .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0] ??
      null;
    const mine = w ? sideOf(w, this.uid) : null;
    if (!w || !mine)
      return {
        war: null,
        enemyName: '',
        phase: 'none',
        prepLeftMs: 0,
        scoreMe: 0,
        scoreEnemy: 0,
        surrenderOffered: false,
        surrenderPending: false,
        isLeader: false,
        allies: [],
        enemies: [],
        ceasefire: null,
      };
    const now = sharedNow();
    const other = otherSide(mine);
    const enemies = membersOf(w, other);
    const allies = membersOf(w, mine).filter((u) => u !== this.uid);
    const live = w.state === 'active' ? this.occupation(w) : new Map<string, string>();
    const [sMe, sEnemy] = w.state !== 'ended' ? this.scores(w, live) : [0, 0];
    const stale = w.state === 'active' && !enemies.some((u) => this.fresh(u, now));
    const leader = w[mine] === this.uid;
    const s = w.surrender;
    const surrenderSide = s ? sideOf(w, s.by) : null;
    return {
      war: w,
      enemyName:
        (w.names[w[other]] ?? '상대 도시') +
        (enemies.length > 1 ? ` 외 ${enemies.length - 1}곳` : ''),
      phase:
        w.state === 'ended' ? 'ended' : w.state === 'prep' ? 'prep' : stale ? 'paused' : 'active',
      prepLeftMs: w.state === 'prep' ? Math.max(0, w.startsAt - now) : 0,
      scoreMe: w.score?.[w[mine]] ?? sMe,
      scoreEnemy: w.score?.[w[other]] ?? sEnemy,
      surrenderOffered: !!s && surrenderSide === other && !s.votes?.[this.uid],
      surrenderPending: !!s && surrenderSide === mine,
      isLeader: leader,
      allies: allies.map((u) => w.names[u] ?? u),
      enemies: enemies.map((u) => w.names[u] ?? u),
      ceasefire: w.ceasefireOffer
        ? {
            byMe: w.ceasefireOffer.by === this.uid,
            byName: w.names[w.ceasefireOffer.by] ?? '참가국',
            myVote: w.ceasefireOffer.votes[this.uid],
            yes: ceasefireYes(w),
            needed: ceasefireNeeded(w),
            leadersYes:
              (w.ceasefireOffer.votes[w.a] === true ? 1 : 0) +
              (w.ceasefireOffer.votes[w.b] === true ? 1 : 0),
          }
        : null,
    };
  }

  /** 선전포고(기습이면 준비 시간 없이). 막히면 이유. */
  async declare(
    them: PublicCity,
    me: PublicCity,
    kind: WarKind,
    surprise: boolean,
  ): Promise<string> {
    const fb = getFirebase();
    if (!fb) return '서버에 연결되어 있지 않습니다';
    const now = sharedNow();
    const why = declareBlock({
      now,
      kind,
      me: {
        uid: this.uid,
        online: true,
        capitalLevel: me.capitalLevel,
        cityLevel: me.cityLevel,
        owned: me.owned,
      },
      them: {
        uid: them.uid,
        online: them.online,
        capitalLevel: them.capitalLevel,
        owned: them.owned,
      },
      wars: this.wars,
    });
    if (why) return why;
    if (!(await loadSettings()).warsEnabled) return '지금은 선생님이 선전포고를 막아 두었습니다';
    if (surprise) {
      const s = surpriseBlock({
        now,
        cityLevel: me.cityLevel,
        myId: this.uid,
        wars: this.wars,
        myUnits: this.sim.army.units
          .filter((u) => u.state !== 'training')
          .map((u) => ({ cx: u.cx, cy: u.cy, men: u.men })),
        theirUnits: them.units ?? [],
        theirOwned: them.owned,
      });
      if (s) return s;
    }
    const id = `${this.uid.slice(0, 8)}-${them.uid.slice(0, 8)}-${now}`;
    const war: Omit<WarDoc, 'id'> = {
      a: this.uid,
      b: them.uid,
      parties: [this.uid, them.uid],
      names: { [this.uid]: this.myName, [them.uid]: them.cityName },
      levels: { [this.uid]: me.capitalLevel, [them.uid]: them.capitalLevel },
      kind,
      surprise,
      state: surprise ? 'active' : 'prep',
      declaredAt: now,
      startsAt: surprise ? now : now + WAR_PREP_MS,
    };
    try {
      await setDoc(doc(fb.db, 'wars', id), war);
      if (surprise) this.sim.state.surpriseAt = now;
      await this.alliances?.betray(them.uid);
      return '';
    } catch (err) {
      console.warn('선전포고 실패', err);
      return '선전포고를 보내지 못했습니다';
    }
  }

  /** 대규모 전쟁에 참가할 수 없는 이유(빈 문자열 = 가능). */
  joinWhy(w: WarDoc, side: WarSide, me: PublicCity): string {
    return joinBlock({
      w,
      me: { uid: this.uid, capitalLevel: me.capitalLevel },
      side,
      wars: this.wars,
      alliedWith: (u) => !!this.alliances?.isAllied(u),
    });
  }

  /** 대규모 전쟁에 한 진영으로 참가한다. */
  async join(w: WarDoc, side: WarSide, me: PublicCity): Promise<string> {
    const why = this.joinWhy(w, side, me);
    if (why) return why;
    const fb = getFirebase();
    if (!fb) return '서버에 연결되어 있지 않습니다';
    try {
      await updateDoc(doc(fb.db, 'wars', w.id), {
        parties: [...w.parties, this.uid],
        [`joined.${this.uid}`]: { side, level: me.capitalLevel, at: sharedNow() },
        [`names.${this.uid}`]: this.myName,
      });
      return '';
    } catch (err) {
      console.warn('전쟁 참가 실패', err);
      return '참가하지 못했습니다';
    }
  }

  /** 휴전 제안(참가국 누구나, 전투 중·일시정지 중). 제안한 도시는 찬성으로 셈. */
  async offerCeasefire(): Promise<string> {
    const w = this.current();
    if (!w || w.state !== 'active') return '전투 중에만 휴전을 제안할 수 있습니다';
    if (w.ceasefireOffer) return '이미 휴전 제안이 올라와 있습니다';
    await this.patch(w, {
      ceasefireOffer: { by: this.uid, at: sharedNow(), votes: { [this.uid]: true } },
    });
    return '';
  }

  /** 휴전 제안에 찬성·반대. */
  async voteCeasefire(yes: boolean): Promise<void> {
    const w = this.current();
    if (!w?.ceasefireOffer) return;
    await this.patch(w, { [`ceasefireOffer.votes.${this.uid}`]: yes });
  }

  /** 내가 낸 휴전 제안을 거둔다. */
  async withdrawCeasefire(): Promise<void> {
    const w = this.current();
    if (w?.ceasefireOffer?.by === this.uid) await this.patch(w, { ceasefireOffer: deleteField() });
  }

  /** 항복 신청(진영 대표만). */
  async offerSurrender(): Promise<void> {
    const w = this.current();
    const mine = w && sideOf(w, this.uid);
    if (w && mine && w[mine] === this.uid)
      await this.patch(w, { surrender: { by: this.uid, at: sharedNow(), votes: {} } });
  }

  async withdrawSurrender(): Promise<void> {
    const w = this.current();
    if (w && w.surrender?.by === this.uid) await this.patch(w, { surrender: deleteField() });
  }

  /** 상대 진영의 항복에 동의한다. 대표가 동의하거나 진영 2/3(기습 3/4)가 동의하면 승전. */
  async acceptSurrender(): Promise<void> {
    const w = this.current();
    if (!w || !w.surrender) return;
    const mine = sideOf(w, this.uid);
    if (!mine || sideOf(w, w.surrender.by) === mine) return;
    await this.patch(w, { [`surrender.votes.${this.uid}`]: true });
    const next: WarDoc = {
      ...w,
      surrender: { ...w.surrender, votes: { ...(w.surrender.votes ?? {}), [this.uid]: true } },
    };
    if (surrenderAccepted(next)) await this.end(next, mine === 'a' ? 'winA' : 'winB', sharedNow());
  }
}

function xy(key: string): [number, number] {
  const { cx, cy } = parseChunkKey(key);
  return [cx, cy];
}
