import {
  collection,
  deleteField,
  doc,
  getDoc,
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
  ceasefireDue,
  declareBlock,
  isBigBattle,
  judge,
  judgeDue,
  mergeClaims,
  reparations,
  surpriseBlock,
  warScore,
  type CompactUnit,
  type SideDoc,
  type WarDoc,
  type WarKind,
} from '../sim/military/warRules';
import { sharedNow } from '../sim/sharedClock';
import { UNIT_SPECS } from '../sim/config/military';
import type { AllianceSession } from './alliances';
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
  /** 내가 항복을 신청해 둔 상태. */
  surrenderPending: boolean;
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

function expand(c: CompactUnit): Unit {
  return {
    id: `e${c.id}`,
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

export class WarSession {
  /** 동맹 연결. 동맹에게 선전포고하면 배신(보증금이 상대에게). */
  alliances: AllianceSession | null = null;
  /** 나와 관련된 전쟁 전부(끝난 것 포함). */
  wars: WarDoc[] = [];
  private unsubWars: Unsubscribe | null = null;
  private unsubSide: Unsubscribe | null = null;
  private sideWarId = '';
  private enemySide: SideDoc | null = null;
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
        this.wars = snap.docs.map((d) => ({ ...(d.data() as WarDoc), id: d.id }));
        const now = this.current();
        if (now && !before) {
          const enemy = now.a === this.uid ? now.b : now.a;
          this.onNotice?.(
            now.a === this.uid
              ? `선전포고했습니다 · ${now.names[enemy] ?? '상대'}${now.surprise ? ' · 기습!' : ' · 5분 뒤 개전'}`
              : `⚠ ${now.names[now.a] ?? '다른 도시'}이(가) ${now.surprise ? '기습해 왔습니다!' : '선전포고했습니다 · 5분 뒤 개전'}`,
          );
        }
        if (
          before &&
          now &&
          before.surrender?.by !== now.surrender?.by &&
          now.surrender &&
          now.surrender.by !== this.uid
        )
          this.onNotice?.('상대가 항복을 신청했습니다 · 대륙 지도에서 받아들일 수 있습니다');
        this.revision++;
        this.attach();
      },
      (err) => console.warn('전쟁 구독 실패', err),
    );
    this.timer = window.setInterval(() => this.tick(), 500);
  }

  stop(): void {
    this.unsubWars?.();
    this.unsubSide?.();
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** 진행 중(준비·전투)인 내 전쟁. */
  current(): WarDoc | null {
    return this.wars.find((w) => w.state !== 'ended') ?? null;
  }

  private enemyOf(w: WarDoc): string {
    return w.a === this.uid ? w.b : w.a;
  }

  /** 진행 중인 전쟁의 상대 스냅숏을 구독한다. */
  private attach(): void {
    const w = this.current();
    const fb = getFirebase();
    if (!w || !fb) {
      // 끝난 전쟁의 마지막 스냅숏은 정산할 때 서버에서 다시 읽는다.
      if (this.sideWarId) {
        this.unsubSide?.();
        this.unsubSide = null;
        this.sideWarId = '';
      }
      return;
    }
    if (this.sideWarId === w.id) return;
    this.unsubSide?.();
    this.sideWarId = w.id;
    this.enemySide = null;
    this.claims = {};
    this.lossAtStart = this.sim.army.army.lossValue ?? 0;
    this.menAtStart = this.sim.army.soldiers;
    this.bigBattleAt = 0;
    this.unsubSide = onSnapshot(doc(fb.db, 'wars', w.id, 'sides', this.enemyOf(w)), (snap) => {
      this.enemySide = snap.exists() ? (snap.data() as SideDoc) : null;
    });
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
      return;
    }
    this.sim.atWar = true;
    this.sim.grantsEnabled = false;
    const enemyUid = this.enemyOf(w);
    const enemy = this.enemySide;
    const stale = !enemy || now - enemy.at > WAR_STALE_MS;

    // 준비 → 전투
    if (w.state === 'prep' && now >= w.startsAt) void this.patch(w, { state: 'active' });

    // 내 스냅숏 보내기
    if (now - this.lastSync >= WAR_SYNC_MS && document.visibilityState === 'visible') {
      this.lastSync = now;
      void this.publishSide(w, now);
    }

    // 전쟁 연결
    if (w.state === 'active' && enemy) {
      const mine = army.mySide();
      const enemySide: Side = {
        uid: enemyUid,
        units: (enemy.units ?? []).map(expand),
        owned: new Set(enemy.owned ?? []),
        capital: new Set(enemy.capital ?? []),
        trenches: new Set(enemy.trenches ?? []),
        urban: new Set(enemy.urban ?? []),
      };
      const occupied = mergeClaims(
        { uid: this.uid, claims: this.claims, owned: [...mine.owned] },
        { uid: enemyUid, claims: enemy.claims ?? {}, owned: enemy.owned ?? [] },
      );
      const link: WarLink = {
        enemy: enemySide,
        occupied,
        capitalProtected: w.kind === 'small',
        paused: stale,
        enemyStrikes: (enemy.strikes ?? []).filter((x) => x.at >= w.startsAt),
        onEvents: (events) => {
          for (const e of events) if (e.type === 'occupied') this.claims[e.key] = sharedNow();
        },
      };
      army.war = link;
      this.sim.territory.foreign = new Set([...this.sim.territory.foreign, ...enemySide.owned]);
    } else {
      // 준비 중에는 평시 규칙으로 배치만 한다.
      army.war = null;
    }

    // 일시정지 기록
    if (w.state === 'active') {
      if (stale && w.pausedAt === undefined) void this.patch(w, { pausedAt: now });
      if (!stale && w.pausedAt !== undefined) void this.patch(w, { pausedAt: deleteField() });
    }

    // 판정·휴전
    if (w.state === 'active' && enemy) {
      const last = Math.max(this.bigBattleAt, enemy.bigBattleAt ?? 0);
      const status = this.status();
      if (judgeDue(w, now)) {
        const r = judge(
          w.a === this.uid ? status.scoreMe : status.scoreEnemy,
          w.a === this.uid ? status.scoreEnemy : status.scoreMe,
        );
        void this.end(w, r, status, now);
      } else if (!stale && ceasefireDue(w, last, now)) {
        void this.end(w, 'ceasefire', status, now);
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

  private async end(
    w: WarDoc,
    result: WarDoc['result'],
    status: WarStatus,
    now: number,
  ): Promise<void> {
    const peace =
      result === 'ceasefire'
        ? CEASEFIRE_PEACE_MS
        : result === 'truce'
          ? CEASEFIRE_PEACE_MS
          : DEFEAT_PEACE_MS;
    const enemy = this.enemyOf(w);
    await this.patch(w, {
      state: 'ended',
      result,
      endedAt: now,
      peaceUntil: now + peace,
      score: { [this.uid]: status.scoreMe, [enemy]: status.scoreEnemy },
      surrender: deleteField(),
    });
  }

  private settling = false;

  /** 끝난 전쟁의 배상 주고받기. 한 번만(macro.warsSettled). */
  private settleEnded(now: number): void {
    if (this.settling) return;
    const settled = (this.sim.state.warsSettled ??= {});
    const w = this.wars.find((x) => x.state === 'ended' && !settled[x.id]);
    if (!w) return;
    this.settling = true;
    void this.settle(w, now).finally(() => {
      this.settling = false;
    });
  }

  private async settle(w: WarDoc, now: number): Promise<void> {
    const settled = (this.sim.state.warsSettled ??= {});
    const iWin =
      (w.result === 'winA' && w.a === this.uid) || (w.result === 'winB' && w.b === this.uid);
    const iLose =
      (w.result === 'winA' && w.b === this.uid) || (w.result === 'winB' && w.a === this.uid);
    if (iLose) {
      if (w.paid) {
        settled[w.id] = now;
        return;
      }
      // 마지막 스냅숏(양쪽 점령 주장)을 서버에서 읽는다 — 끊겼다 돌아와도 정산할 수 있게.
      const fb = getFirebase();
      if (!fb) return;
      const enemyUid = this.enemyOf(w);
      let mineDoc: SideDoc | null = null;
      let enemyDoc: SideDoc | null = null;
      try {
        const [a, b] = await Promise.all([
          getDoc(doc(fb.db, 'wars', w.id, 'sides', this.uid)),
          getDoc(doc(fb.db, 'wars', w.id, 'sides', enemyUid)),
        ]);
        mineDoc = a.exists() ? (a.data() as SideDoc) : null;
        enemyDoc = b.exists() ? (b.data() as SideDoc) : null;
      } catch (err) {
        console.warn('정산용 스냅숏을 읽지 못했습니다', err);
        return;
      }
      const occupied = mergeClaims(
        {
          uid: this.uid,
          claims: mineDoc?.claims ?? {},
          owned: [...this.sim.territory.ownedKeys()],
        },
        { uid: enemyUid, claims: enemyDoc?.claims ?? {}, owned: enemyDoc?.owned ?? [] },
      );
      const chunks: string[] = [];
      for (const [k, who] of occupied)
        if (who === enemyUid && this.sim.territory.isOwned(...xy(k))) chunks.push(k);
      // 내가 낸다: 돈 25%, 자원 30%, 상대가 점령한 내 땅.
      const pay = reparations(this.sim.money, this.sim.resources.stockNow);
      this.sim.adjustMoney(-pay.money);
      this.sim.resources.addStock('iron', -pay.iron);
      this.sim.resources.addStock('coal', -pay.coal);
      this.sim.resources.addStock('oil', -pay.oil);
      this.sim.territory.cede(chunks);
      settled[w.id] = now;
      await this.patch(w, { paid: { ...pay, chunks } });
      this.onNotice?.(
        `패전 · 배상 ${Math.round(pay.money).toLocaleString('ko-KR')}만 원, 자원 30%, 영토 ${chunks.length}청크를 내줬습니다`,
      );
    } else if (iWin) {
      if (!w.paid) return; // 상대가 낼 때까지 기다린다(상대가 접속하면 낸다).
      this.sim.adjustMoney(w.paid.money);
      this.sim.resources.addStock('iron', w.paid.iron);
      this.sim.resources.addStock('coal', w.paid.coal);
      this.sim.resources.addStock('oil', w.paid.oil);
      this.sim.territory.annex(w.paid.chunks);
      settled[w.id] = now;
      this.onNotice?.(
        `승전! 배상 ${Math.round(w.paid.money).toLocaleString('ko-KR')}만 원과 영토 ${w.paid.chunks.length}청크를 얻었습니다 · 새 땅은 도로로 이어 주세요`,
      );
    } else {
      settled[w.id] = now;
      this.onNotice?.(
        w.result === 'ceasefire'
          ? '휴전 · 큰 전투 없이 1시간이 지났습니다 · 12시간 동안 다시 전쟁할 수 없습니다'
          : '종전 협정 · 피해가 비슷해 배상 없이 끝났습니다',
      );
    }
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
    if (!w)
      return {
        war: null,
        enemyName: '',
        phase: 'none',
        prepLeftMs: 0,
        scoreMe: 0,
        scoreEnemy: 0,
        surrenderOffered: false,
        surrenderPending: false,
      };
    const now = sharedNow();
    const enemyUid = this.enemyOf(w);
    const enemy = w.state !== 'ended' ? this.enemySide : null;
    const occupied =
      enemy && w.state === 'active'
        ? mergeClaims(
            { uid: this.uid, claims: this.claims, owned: [...this.sim.territory.ownedKeys()] },
            { uid: enemyUid, claims: enemy.claims ?? {}, owned: enemy.owned ?? [] },
          )
        : new Map<string, string>();
    const myLoss = (this.sim.army.army.lossValue ?? 0) - this.lossAtStart;
    const scoreMe = w.score?.[this.uid] ?? warScore(occupied, this.uid, enemy?.lossValue ?? 0);
    const scoreEnemy = w.score?.[enemyUid] ?? warScore(occupied, enemyUid, myLoss);
    const stale = w.state === 'active' && (!enemy || now - enemy.at > WAR_STALE_MS);
    return {
      war: w,
      enemyName: w.names[enemyUid] ?? '상대 도시',
      phase:
        w.state === 'ended' ? 'ended' : w.state === 'prep' ? 'prep' : stale ? 'paused' : 'active',
      prepLeftMs: w.state === 'prep' ? Math.max(0, w.startsAt - now) : 0,
      scoreMe,
      scoreEnemy,
      surrenderOffered: !!w.surrender && w.surrender.by !== this.uid,
      surrenderPending: !!w.surrender && w.surrender.by === this.uid,
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

  async offerSurrender(): Promise<void> {
    const w = this.current();
    if (w) await this.patch(w, { surrender: { by: this.uid, at: sharedNow() } });
  }

  async withdrawSurrender(): Promise<void> {
    const w = this.current();
    if (w) await this.patch(w, { surrender: deleteField() });
  }

  /** 상대의 항복을 받아들인다 → 내 승전. */
  async acceptSurrender(): Promise<void> {
    const w = this.current();
    if (!w || !w.surrender || w.surrender.by === this.uid) return;
    const status = this.status();
    await this.end(w, w.a === this.uid ? 'winA' : 'winB', status, sharedNow());
  }
}

function xy(key: string): [number, number] {
  const { cx, cy } = parseChunkKey(key);
  return [cx, cy];
}
