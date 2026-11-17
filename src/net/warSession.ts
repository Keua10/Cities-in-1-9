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
  WAR_JUDGE_AFTER_MS,
  WAR_PREP_MS,
  WAR_STALE_MS,
  WAR_SYNC_MS,
} from '../sim/config/war';
import type { MacroSim } from '../sim/macro';
import type { Side, Strike, Unit } from '../sim/military/army';
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
import { isNight } from '../sim/military/weather';
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

/** 진행 중인 전쟁 하나의 전선 상태. */
interface Front {
  sides: Map<string, SideDoc>;
  claims: Record<string, number>;
  lossAtStart: number;
  menAtStart: number;
  bigBattleAt: number;
  lastSync: number;
  unsub: () => void;
}

export class WarSession {
  /** 동맹 연결. 동맹에게 선전포고하면 배신(보증금이 상대에게). */
  alliances: AllianceSession | null = null;
  /** 나와 관련된 전쟁 전부(끝난 것 포함). */
  wars: WarDoc[] = [];
  /** 참가할 수 있는 다른 도시들의 대규모 전쟁(준비·전투 중). */
  openLarge: WarDoc[] = [];
  private unsubWars: Unsubscribe | null = null;
  private unsubOpen: Unsubscribe | null = null;
  /** 진행 중인 전쟁마다의 전선(스냅숏 구독·점령 주장·시작 때 병력). 동시에 최대 2개(3개 도시). */
  private fronts = new Map<string, Front>();
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
        const prev = new Map(this.currentWars().map((w) => [w.id, w]));
        this.wars = snap.docs.map((d) => ({ ...(d.data() as WarDoc), id: d.id }));
        for (const now of this.currentWars()) {
          const before = prev.get(now.id);
          const mine = sideOf(now, this.uid);
          if (!before) {
            const enemy = mine ? now[otherSide(mine)] : now.a;
            this.onNotice?.(
              now.a === this.uid
                ? `선전포고했습니다 · ${now.names[enemy] ?? '상대'}${now.surprise ? ' · 기습!' : ' · 5분 뒤 개전'}`
                : now.joined?.[this.uid]
                  ? `${now.names[now[mine!]] ?? '동맹'} 진영으로 전쟁에 참가했습니다`
                  : `⚠ ${now.names[now.a] ?? '다른 도시'}이(가) ${now.surprise ? '기습해 왔습니다!' : '선전포고했습니다 · 5분 뒤 개전'}`,
            );
            continue;
          }
          const prevJoined = Object.keys(before.joined ?? {});
          for (const u of Object.keys(now.joined ?? {}))
            if (!prevJoined.includes(u) && u !== this.uid)
              this.onNotice?.(
                `${now.names[u] ?? '다른 도시'}이(가) ${sideOf(now, u) === mine ? '우리' : '상대'} 진영으로 참가했습니다`,
              );
          if (
            before.surrender?.by !== now.surrender?.by &&
            now.surrender &&
            sideOf(now, now.surrender.by) !== mine
          )
            this.onNotice?.(
              `${now.names[now.surrender.by] ?? '상대'}이(가) 항복을 신청했습니다 · 대륙 지도에서 받아들일 수 있습니다`,
            );
          if (
            now.ceasefireOffer &&
            now.ceasefireOffer.by !== this.uid &&
            before.ceasefireOffer?.at !== now.ceasefireOffer.at
          )
            this.onNotice?.(
              `🕊 ${now.names[now.ceasefireOffer.by] ?? '참가국'}이(가) 휴전을 제안했습니다 · 대륙 지도에서 찬성·반대`,
            );
          if (before.ceasefireOffer && !now.ceasefireOffer)
            this.onNotice?.('휴전 제안이 무산되었습니다');
        }
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
    for (const f of this.fronts.values()) f.unsub();
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** 진행 중(준비·전투)인 내 전쟁들(한 도시가 동시에 두 나라와 싸울 수 있다). */
  currentWars(): WarDoc[] {
    return this.wars.filter((w) => w.state !== 'ended');
  }

  /** 진행 중인 전쟁 하나(id 를 주면 그 전쟁, 없으면 가장 먼저 시작한 것). */
  current(id?: string): WarDoc | null {
    const list = this.currentWars();
    return (id ? list.find((w) => w.id === id) : list[0]) ?? null;
  }

  /** 이 도시와 지금 전쟁 중인가(어느 전쟁에서든 상대 진영). */
  atWarWith(uid: string): boolean {
    return this.currentWars().some((w) => {
      const a = sideOf(w, this.uid);
      const b = sideOf(w, uid);
      return !!a && !!b && a !== b;
    });
  }

  /** 진행 중인 전쟁마다 참가국 스냅숏을 구독한다. */
  private attach(): void {
    const fb = getFirebase();
    const live = new Set(this.currentWars().map((w) => w.id));
    // 끝난 전쟁의 마지막 스냅숏은 정산할 때 서버에서 다시 읽는다.
    for (const [id, f] of this.fronts)
      if (!live.has(id)) {
        f.unsub();
        this.fronts.delete(id);
      }
    if (!fb) return;
    for (const w of this.currentWars()) {
      if (this.fronts.has(w.id)) continue;
      const f: Front = {
        sides: new Map(),
        claims: {},
        lossAtStart: this.sim.army.army.lossValue ?? 0,
        menAtStart: this.sim.army.soldiers,
        bigBattleAt: 0,
        lastSync: 0,
        unsub: () => {},
      };
      f.unsub = onSnapshot(collection(fb.db, 'wars', w.id, 'sides'), (snap) => {
        const next = new Map<string, SideDoc>();
        for (const d of snap.docs) if (d.id !== this.uid) next.set(d.id, d.data() as SideDoc);
        f.sides = next;
      });
      this.fronts.set(w.id, f);
    }
  }

  private front(w: WarDoc): Front {
    let f = this.fronts.get(w.id);
    if (!f) {
      f = {
        sides: new Map(),
        claims: {},
        lossAtStart: this.sim.army.army.lossValue ?? 0,
        menAtStart: this.sim.army.soldiers,
        bigBattleAt: 0,
        lastSync: 0,
        unsub: () => {},
      };
      this.fronts.set(w.id, f);
    }
    return f;
  }

  private fresh(w: WarDoc, uid: string, now: number): SideDoc | null {
    const d = this.fronts.get(w.id)?.sides.get(uid);
    return d && now - d.at <= WAR_STALE_MS ? d : null;
  }

  /** 모든 참가국 점령 주장을 합친 것(내 주장은 지금 것). */
  private occupation(w: WarDoc): Map<string, string> {
    const f = this.front(w);
    const list = [{ uid: this.uid, claims: f.claims, owned: [...this.sim.territory.ownedKeys()] }];
    for (const [uid, d] of f.sides)
      if (w.parties.includes(uid)) list.push({ uid, claims: d.claims ?? {}, owned: d.owned ?? [] });
    return mergeAllClaims(w, list);
  }

  /** 진영 점수 [내 진영, 상대 진영]. */
  private scores(w: WarDoc, occupied: Map<string, string>): [number, number] {
    const f = this.front(w);
    const mine = sideOf(w, this.uid)!;
    const myLoss = (this.sim.army.army.lossValue ?? 0) - f.lossAtStart;
    let lossMine = myLoss;
    let lossTheirs = 0;
    for (const [uid, d] of f.sides) {
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
    const wars = this.currentWars();
    const army = this.sim.army;
    if (!wars.length) {
      army.war = null;
      this.sim.atWar = false;
      this.sim.grantsEnabled = true;
      delete this.sim.state.warSince;
      return;
    }
    this.sim.atWar = true;
    this.sim.state.warSince ??= Math.min(...wars.map((w) => w.startsAt));
    this.sim.grantsEnabled = false;

    // 모든 전쟁의 상대(지금 접속한 도시들)를 하나의 적으로 묶는다. 세 나라가 서로 싸워도
    // 내 기기에서는 "나 대 적" 이다(적끼리의 싸움은 그 도시들 기기가 계산한다).
    const enemySide: Side = {
      uid: ENEMY,
      units: [],
      owned: new Set(),
      capital: new Set(),
      trenches: new Set(),
      urban: new Set(),
    };
    const allyOwned = new Set<string>();
    const occupied = new Map<string, string>();
    const strikes: Strike[] = [];
    const noMissile = new Set<string>();
    /** 청크 → 그 청크가 걸린 전쟁(점령 주장을 어느 전쟁에 적을지). */
    const warOf = new Map<string, string>();
    const foreign = new Set(this.sim.territory.foreign);
    let anyActive = false;
    let anyLive = false;

    for (const w of wars) {
      const f = this.front(w);
      const mine = sideOf(w, this.uid);
      if (!mine) continue;
      const enemies = membersOf(w, otherSide(mine));
      const allies = membersOf(w, mine).filter((u) => u !== this.uid);
      const freshEnemies = enemies.filter((u) => this.fresh(w, u, now));
      const stale = !freshEnemies.length;

      // 준비 → 전투
      if (w.state === 'prep' && now >= w.startsAt) void this.patch(w, { state: 'active' });

      // 내 스냅숏 보내기
      if (now - f.lastSync >= WAR_SYNC_MS && document.visibilityState === 'visible') {
        f.lastSync = now;
        void this.publishSide(w, now);
      }

      if (w.state === 'active') {
        anyActive = true;
        if (!stale) {
          anyLive = true;
          for (const uid of freshEnemies) {
            const d = this.fresh(w, uid, now)!;
            for (const c of d.units ?? []) enemySide.units.push(expand(c, uid));
            if (!landProtected(w, this.uid, uid))
              for (const k of d.owned ?? []) {
                enemySide.owned.add(k);
                warOf.set(k, w.id);
                if (w.kind === 'small') noMissile.add(k);
              }
            if (!capitalOpen(w, uid)) for (const k of d.capital ?? []) enemySide.capital.add(k);
            for (const k of d.trenches ?? []) enemySide.trenches.add(k);
            for (const k of d.urban ?? []) enemySide.urban.add(k);
          }
          for (const uid of allies) for (const k of f.sides.get(uid)?.owned ?? []) allyOwned.add(k);
          // 전장에서는 우리 진영 점령 = 나, 상대 진영 점령 = ENEMY 로 본다.
          for (const [k, who] of this.occupation(w)) {
            occupied.set(k, sideOf(w, who) === mine ? this.uid : ENEMY);
            if (!warOf.has(k)) warOf.set(k, w.id);
          }
          for (const u of enemies)
            strikes.push(...(f.sides.get(u)?.strikes ?? []).filter((x) => x.at >= w.startsAt));
          for (const uid of enemies) for (const k of f.sides.get(uid)?.owned ?? []) foreign.add(k);
        }
        // 일시정지 기록
        if (stale && w.pausedAt === undefined) void this.patch(w, { pausedAt: now });
        if (!stale && w.pausedAt !== undefined) void this.patch(w, { pausedAt: deleteField() });
      }

      // 휴전 제안: 통과하면 휴전, 더 이상 통과할 수 없으면 거둔다.
      if (w.ceasefireOffer) {
        if (ceasefireAccepted(w)) {
          void this.end(w, 'ceasefire', now, 'agreed');
          continue;
        }
        if (ceasefireDead(w)) void this.patch(w, { ceasefireOffer: deleteField() });
      }

      // 항복이 받아들여졌으면 끝낸다(받는 진영 누구든 먼저 본 쪽이).
      if (surrenderAccepted(w)) {
        const loser = sideOf(w, w.surrender!.by)!;
        void this.end(w, loser === 'a' ? 'winB' : 'winA', now, 'surrender');
        continue;
      }

      // 판정·휴전
      if (w.state === 'active') {
        let last = f.bigBattleAt;
        for (const d of f.sides.values()) last = Math.max(last, d.bigBattleAt ?? 0);
        if (judgeDue(w, now)) {
          const [me, them] = this.scores(w, this.occupation(w));
          void this.end(w, mine === 'a' ? judge(me, them) : judge(them, me), now, 'judge');
        } else if (!stale && ceasefireDue(w, last, now)) {
          void this.end(w, 'ceasefire', now, 'ceasefire');
        }
      }
    }

    if (anyLive) {
      army.war = {
        enemy: enemySide,
        occupied,
        capitalProtected: true,
        paused: false,
        enemyStrikes: strikes,
        allyOwned,
        noMissile,
        onEvents: (events) => {
          for (const e of events) {
            if (e.type !== 'occupied') continue;
            const id = warOf.get(e.key);
            const fr = id ? this.fronts.get(id) : undefined;
            if (fr) fr.claims[e.key] = sharedNow();
            else for (const x of this.fronts.values()) x.claims[e.key] = sharedNow();
          }
        },
      } satisfies WarLink;
      this.sim.territory.foreign = foreign;
    } else if (anyActive) {
      // 상대가 모두 끊김: 전쟁만 멈춘다.
      if (army.war) army.war.paused = true;
    } else {
      // 준비 중에는 평시 규칙으로 배치만 한다.
      army.war = null;
    }
  }

  private async publishSide(w: WarDoc, now: number): Promise<void> {
    const fb = getFirebase();
    if (!fb) return;
    const f = this.front(w);
    const army = this.sim.army;
    const side = army.mySide();
    const fighting = army.units
      .filter((u) => u.state === 'fighting' && UNIT_SPECS[u.type].men > 0)
      .reduce((s, u) => s + u.men, 0);
    if (isBigBattle(fighting, Math.max(army.soldiers, f.menAtStart))) f.bigBattleAt = now;
    const docData: SideDoc = {
      at: now,
      units: army.units
        .filter(
          (u) => u.state !== 'training' && !u.airlift && UNIT_SPECS[u.type].domain !== 'strike',
        )
        .map(compact),
      owned: [...side.owned],
      capital: [...side.capital],
      trenches: [...side.trenches],
      urban: [...side.urban],
      claims: f.claims,
      lossValue: Math.round((army.army.lossValue ?? 0) - f.lossAtStart),
      bigBattleAt: f.bigBattleAt,
      men: Math.round(f.menAtStart),
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

  private ending = new Set<string>();

  private async end(
    w: WarDoc,
    result: WarDoc['result'],
    now: number,
    reason: NonNullable<WarDoc['endReason']>,
  ): Promise<void> {
    if (this.ending.has(w.id)) return;
    this.ending.add(w.id);
    const peace =
      result === 'ceasefire' || result === 'truce' ? CEASEFIRE_PEACE_MS : DEFEAT_PEACE_MS;
    const occupied = this.occupation(w);
    const mine = sideOf(w, this.uid)!;
    const [me, them] = this.scores(w, occupied);
    // 기여도: 각자 마지막 스냅숏의 부대 가치 + 점령 청크.
    const armyValue: Record<string, number> = {
      [this.uid]: this.sim.army.units.reduce((s, u) => s + unitValue(u.type, u.men), 0),
    };
    for (const [uid, d] of this.front(w).sides)
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
      endReason: reason,
      ...(reason === 'surrender' && w.surrender ? { surrenderBy: w.surrender.by } : {}),
      ...(reason === 'agreed' ? { agreedCeasefire: true } : {}),
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
              : '휴전 · 큰 전투 없이 20분이 지났습니다 · 12시간 동안 다시 전쟁할 수 없습니다'
            : '종전 협정 · 피해가 비슷해 배상 없이 끝났습니다',
      );
      this.done(w);
      return;
    }
    if (mine !== winner) {
      if (w.paid?.[this.uid]) {
        settled[w.id] = now;
        return;
      }
      // 배상은 정당하게 끝난 전쟁에서만 낸다: 우리 진영이 항복했거나(대표인 나는 내가 신청한
      // 기록이 있어야), 끊긴 지 24시간이 지나 판정됐을 때. 그 밖의 "승패" 기록은 무시한다.
      const legit =
        (w.endReason === 'surrender' &&
          !!w.surrenderBy &&
          sideOf(w, w.surrenderBy) === mine &&
          (w.surrenderBy !== this.uid || this.sim.state.surrenderSent === w.id)) ||
        (w.endReason === 'judge' &&
          w.pausedAt !== undefined &&
          (w.endedAt ?? 0) - w.pausedAt >= WAR_JUDGE_AFTER_MS);
      if (!legit) {
        settled[w.id] = now;
        st.warOutcome = 'draw';
        this.onNotice?.('전쟁 종료 기록이 올바르지 않아 배상 없이 끝냅니다');
        this.done(w);
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
      this.sim.resources.addStock('wood', -(pay.wood ?? 0));
      this.sim.resources.addStock('ammo', -(pay.ammo ?? 0));
      this.sim.territory.cede(all);
      settled[w.id] = now;
      await this.patch(w, { [`paid.${this.uid}`]: { ...pay, chunks } });
      this.onNotice?.(
        `패전 · 배상 ${Math.round(pay.money).toLocaleString('ko-KR')}만 원, 자원 30%, 영토 ${all.length}청크를 내줬습니다`,
      );
      this.done(w);
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
      this.sim.resources.addStock('wood', Math.floor((p.wood ?? 0) * share));
      this.sim.resources.addStock('ammo', Math.floor((p.ammo ?? 0) * share));
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
      this.done(w);
    }
  }

  private done(w: WarDoc): void {
    this.fronts.get(w.id)?.unsub();
    this.fronts.delete(w.id);
    if (!this.currentWars().length) this.sim.army.war = null;
    this.revision++;
  }

  /* ---------------- 화면에서 부르는 것 ---------------- */

  /** 진행 중인 전쟁마다의 상태(두 전선이면 둘). */
  statuses(): WarStatus[] {
    const list = this.currentWars().map((w) => this.status(w.id));
    return list.length ? list : [this.status()];
  }

  status(id?: string): WarStatus {
    const w =
      this.current(id) ??
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
    const stale = w.state === 'active' && !enemies.some((u) => this.fresh(w, u, now));
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
    // 상대가 다른 도시와 전쟁 중인지·패전 보호 중인지는 상대 전쟁 기록을 한 번 읽어 본다.
    let theirWars: WarDoc[] = [];
    const otherWars: WarDoc[] = [];
    try {
      const snap = await getDocs(
        query(collection(fb.db, 'wars'), where('parties', 'array-contains', them.uid)),
      );
      theirWars = snap.docs.map((d) => ({ ...(d.data() as WarDoc), id: d.id }));
      // 나·상대와 싸우는 도시들의 전쟁도 읽어 둔다(동시 전쟁 3곳 제한).
      const near = new Set<string>();
      for (const w of [...this.wars, ...theirWars])
        if (w.state !== 'ended') for (const u of [w.a, w.b]) near.add(u);
      near.delete(this.uid);
      near.delete(them.uid);
      for (const u of near) {
        const more = await getDocs(
          query(collection(fb.db, 'wars'), where('parties', 'array-contains', u)),
        );
        otherWars.push(...more.docs.map((d) => ({ ...(d.data() as WarDoc), id: d.id })));
      }
    } catch (err) {
      console.warn('상대 전쟁 기록을 읽지 못했습니다', err);
      return '상대 정보를 읽지 못했습니다. 잠시 뒤 다시 해 주세요';
    }
    const why = declareBlock({
      now,
      kind,
      theirWars,
      otherWars,
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
        night: isNight(now),
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
      // 상대 진영에 동맹이 있으면 그 동맹은 배신이 된다(보증금이 상대에게).
      for (const u of membersOf(w, otherSide(side)))
        if (this.alliances?.isAllied(u)) await this.alliances.betray(u);
      return '';
    } catch (err) {
      console.warn('전쟁 참가 실패', err);
      return '참가하지 못했습니다';
    }
  }

  /** 휴전 제안(참가국 누구나, 전투 중·일시정지 중). 제안한 도시는 찬성으로 셈. */
  async offerCeasefire(id?: string): Promise<string> {
    const w = this.current(id);
    if (!w || w.state !== 'active') return '전투 중에만 휴전을 제안할 수 있습니다';
    if (w.ceasefireOffer) return '이미 휴전 제안이 올라와 있습니다';
    await this.patch(w, {
      ceasefireOffer: { by: this.uid, at: sharedNow(), votes: { [this.uid]: true } },
    });
    return '';
  }

  /** 휴전 제안에 찬성·반대. */
  async voteCeasefire(yes: boolean, id?: string): Promise<void> {
    const w = this.current(id);
    if (!w?.ceasefireOffer) return;
    await this.patch(w, { [`ceasefireOffer.votes.${this.uid}`]: yes });
  }

  /** 내가 낸 휴전 제안을 거둔다. */
  async withdrawCeasefire(id?: string): Promise<void> {
    const w = this.current(id);
    if (w?.ceasefireOffer?.by === this.uid) await this.patch(w, { ceasefireOffer: deleteField() });
  }

  /** 항복 신청(진영 대표만). */
  async offerSurrender(id?: string): Promise<void> {
    const w = this.current(id);
    const mine = w && sideOf(w, this.uid);
    if (w && mine && w[mine] === this.uid) {
      // 내가 실제로 항복을 신청했다는 기록(정산 때 위조된 "항복" 종료를 걸러낸다).
      this.sim.state.surrenderSent = w.id;
      await this.patch(w, { surrender: { by: this.uid, at: sharedNow(), votes: {} } });
    }
  }

  async withdrawSurrender(id?: string): Promise<void> {
    const w = this.current(id);
    if (w && w.surrender?.by === this.uid) await this.patch(w, { surrender: deleteField() });
  }

  /** 상대 진영의 항복에 동의한다. 대표가 동의하거나 진영 2/3(기습 3/4)가 동의하면 승전. */
  async acceptSurrender(id?: string): Promise<void> {
    const w = this.current(id);
    if (!w || !w.surrender) return;
    const mine = sideOf(w, this.uid);
    if (!mine || sideOf(w, w.surrender.by) === mine) return;
    await this.patch(w, { [`surrender.votes.${this.uid}`]: true });
    const next: WarDoc = {
      ...w,
      surrender: { ...w.surrender, votes: { ...(w.surrender.votes ?? {}), [this.uid]: true } },
    };
    if (surrenderAccepted(next))
      await this.end(next, mine === 'a' ? 'winA' : 'winB', sharedNow(), 'surrender');
  }
}

function xy(key: string): [number, number] {
  const { cx, cy } = parseChunkKey(key);
  return [cx, cy];
}
