import type { PassSession } from '../net/passes';
import {
  airspace,
  bound,
  INCIDENT_COOLDOWN_MS,
  PASS_RULE_NAMES,
  passValid,
  territorialSea,
  type PassRule,
} from '../sim/military/waters';
import { CONTINENT_H, CONTINENT_W, CONTINENT_X0, CONTINENT_Y0 } from '../world/continent';
import { parseChunkKey } from '../core/iso';
import type { PublicCity } from '../net/publicCities';
import { sharedClockOffset, sharedNow } from '../sim/sharedClock';
import { loadOverview } from './startPicker';
import {
  isNight,
  visionAt,
  weatherAt,
  WEATHER_NAMES,
  WEATHER_REGION,
} from '../sim/military/weather';
import {
  expRank,
  AIRLIFT_COST,
  AIRLIFT_RANGE_CHUNKS,
  OCCUPY_SECONDS,
  UNIT_SPECS,
  VISION_CHUNKS,
  type UnitType,
} from '../sim/config/military';
import { unitPosition, type Unit } from '../sim/military/army';
import type { ArmySystem } from '../sim/military/armySystem';
import type { WarSession } from '../net/warSession';
import type { AllianceSession } from '../net/alliances';
import { ALLIANCE_DEPOSITS, BETRAYAL_LOCK_MS } from '../sim/config/war';
import { formatMoney } from './money';
import { FACILITY_SPECS } from '../sim/facilities';
import './continentMap.css';

/**
 * 대륙 지도 (군사 3단계): 모든 도시의 영토·수도·레벨·접속 여부를 한 화면에.
 *
 * 앞으로 전쟁(4단계~)을 지휘하는 화면이 된다. 지금은 보기만 한다.
 *   - 도시마다 다른 색으로 영토 청크를 칠하고, 수도는 금색 테두리.
 *   - 오른쪽 목록: 이름·레벨·인구·영토·접속(● 접속 중 / ○ n분 전). 누르면 그 도시로 이동.
 *   - 내 도시는 지금 화면의 최신 영토로 그린다(공개 문서는 저장할 때만 바뀌므로).
 */

const PX_PER_CHUNK = 2;

export interface ContinentMapSource {
  /** 다른 도시들(서버). 둘러보기면 빈 목록. */
  load: () => Promise<PublicCity[]>;
  /** 내 도시(지금 상태). */
  mine: () => PublicCity;
  online: boolean;
  /** 내 군대. */
  army: ArmySystem;
  /** 내 도시 레벨(모집 버튼을 다음 레벨 것까지만 보인다). */
  cityLevel?: () => number;
  /** 화면 위 알림(짧은 문장). */
  announce: (text: string) => void;
  /** 전쟁 연결(로그인했을 때만). */
  war: WarSession | null;
  /** 동맹 연결(로그인했을 때만). */
  alliances?: AllianceSession | null;
  /**
   * 내가 아는 청크(개척한 땅·내 영토·부대가 가 본 곳·레이더 시야). 여기만 선명하게
   * 보이고, 다른 도시는 이 안에 땅이 있거나 동맹·전쟁 상대일 때만 보인다.
   */
  known?: () => ReadonlySet<string>;
  /** 관리자: 지도 전체와 모든 도시가 보인다. */
  seeAll?: boolean;
  /** 다른 도시 영토를 새로 읽었을 때(자동 점령 막기). */
  onForeign?: (owned: Set<string>) => void;
  /** 영해·영공 통과(로그인했을 때만). */
  passes?: PassSession | null;
  /** 내 영해·영공 규율. */
  passRule?: () => PassRule;
  setPassRule?: (r: PassRule) => void;
}

const UNIT_LETTER: Record<UnitType, string> = {
  infantry: '보',
  engineer: '공',
  artillery: '포',
  armor: '기',
  aa: '대',
  fighter: '전',
  bomber: '폭',
  ship: '함',
  missile: '미',
};
const STATE_TEXT: Record<Unit['state'], string> = {
  training: '훈련 중',
  idle: '대기',
  moving: '이동',
  fighting: '전투 중',
  retreating: '후퇴',
};

function cityColor(index: number, alpha: number): string {
  const hue = (index * 137.508) % 360;
  return `hsla(${hue.toFixed(0)}, 70%, 58%, ${alpha})`;
}

function ago(ms: number): string {
  if (ms <= 0) return '접속 기록 없음';
  const min = Math.floor((sharedNow() - ms) / 60_000);
  if (min < 60) return `${Math.max(1, min)}분 전`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

export class ContinentMap {
  private root = document.createElement('div');
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private list: HTMLElement;
  private status: HTMLElement;
  private overview: HTMLImageElement | null = null;
  /** 안 가 본 곳에 쓰는 흐린 지도(작게 줄였다 늘려서 흐리게 — 오래된 아이패드에서도 됨). */
  private blurred: HTMLCanvasElement | null = null;
  /** ✈ 를 누른 뒤: 다음 지도 누르기 = 공중 수송 목적지. */
  private airliftMode = false;
  /** 부대가 화면에 그려진 자리(스냅숏 사이를 부드럽게 잇는다). */
  private shown = new Map<string, { x: number; y: number }>();
  private lastFrameAt = 0;
  /** 이번 프레임에 움직이는 것(부대 이동·전투·효과)이 있었는가. */
  private animating = false;
  /** 아직 못 찾은 도시 수(목록 아래 안내). */
  private hiddenCount = 0;
  private cities: PublicCity[] = [];
  private scale = 1;
  private fitScale = 1;
  private ox = 0;
  private oy = 0;
  private refreshTimer: number | null = null;
  private selected: string | null = null;
  /** 고른 내 부대 id. */
  private selectedUnit: string | null = null;
  /** 길게 눌러 고른 여러 부대(한꺼번에 이동·합치기). */
  private picked = new Set<string>();
  private pickEl!: HTMLElement;
  private tab: 'cities' | 'army' = 'cities';
  private frame = 0;
  private lastArmyRevision = -1;
  private unitsEl: HTMLElement;
  private recruitEl: HTMLElement;
  private armyInfoEl: HTMLElement;
  private armyMsgEl: HTMLElement;
  private warEl: HTMLElement;
  private declareEl: HTMLElement;
  private incomingEl!: HTMLElement;
  private openWarsEl!: HTMLElement;
  private openWarsRev = -1;
  private allyRev = -1;
  private passRev = -1;
  private trespassEl!: HTMLElement;
  private trespassSig = '';
  private space = { sig: '', sea: new Set<string>(), air: new Set<string>() };
  /** 두 전선이면 위쪽 전쟁 줄에 보이는 전쟁. */
  private warFocus: string | null = null;

  constructor(private source: ContinentMapSource) {
    this.root.id = 'continent-map';
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="cm-head">
        <b>대륙 지도</b>
        <span class="cm-status" role="status"></span>
        <div class="cm-war" hidden>
          <span class="cm-war-fronts"></span>
          <span class="cm-war-text"></span>
          <button type="button" class="cm-war-surrender">항복 신청</button>
          <button type="button" class="cm-war-accept" hidden>항복 받아들이기</button>
          <button type="button" class="cm-war-truce">휴전 제안</button>
          <button type="button" class="cm-war-truce-yes" hidden>휴전 찬성</button>
          <button type="button" class="cm-war-truce-no" hidden>휴전 반대</button>
        </div>
        <button type="button" class="cm-close" aria-label="대륙 지도 닫기">×</button>
      </header>
      <div class="cm-body">
        <div class="cm-map"></div>
        <aside class="cm-side">
          <div class="cm-tabs" role="tablist">
            <button type="button" data-tab="cities" aria-pressed="true">도시</button>
            <button type="button" data-tab="army" aria-pressed="false">군대</button>
          </div>
          <div class="cm-pane" data-pane="cities">
            <div class="cm-legend">금색 테두리 = 수도 · ● 접속 중 · 전쟁은 양쪽이 접속해 있어야 합니다</div>
            <div class="cm-incoming" hidden></div>
            <div class="cm-open-wars" hidden></div>
            <ol class="cm-list"></ol>
            <div class="cm-declare" hidden>
              <div class="cm-declare-title"></div>
              <div class="cm-ally">
                <div class="cm-ally-state"></div>
                <div class="cm-ally-row">
                  <select class="cm-ally-deposit" aria-label="동맹 보증금"></select>
                  <button type="button" class="cm-ally-go">동맹 신청</button>
                </div>
              </div>
              <div class="cm-declare-warn"></div>
              <div class="cm-pass" hidden>
                <span class="cm-pass-state"></span>
                <button type="button" class="cm-pass-go"></button>
              </div>
              <button type="button" data-war="small">소규모 전쟁 선포 (준비 5분)</button>
              <button type="button" data-war="surprise">기습 (준비 없이)</button>
              <button type="button" data-war="large">대규모 전쟁 선포</button>
              <div class="cm-declare-msg" role="status"></div>
            </div>
          </div>
          <div class="cm-pane" data-pane="army" hidden>
            <label class="cm-pass-rule">영해·영공
              <select>
                <option value="open">자유 통과</option>
                <option value="notify">신고 후 통과</option>
                <option value="permit">허가 후 통과</option>
              </select>
            </label>
            <div class="cm-trespass" hidden></div>
            <div class="cm-army-info cm-legend"></div>
            <div class="cm-recruit"></div>
            <div class="cm-army-msg" role="status"></div>
            <div class="cm-pick" hidden>
              <span class="cm-pick-text"></span>
              <button type="button" class="cm-pick-merge">합치기</button>
              <button type="button" class="cm-pick-split">나누기</button>
              <button type="button" class="cm-pick-clear">선택 해제</button>
            </div>
            <ol class="cm-units"></ol>
          </div>
        </aside>
      </div>`;
    this.root.querySelector('.cm-map')!.append(this.canvas);
    this.list = this.root.querySelector('.cm-list')!;
    this.status = this.root.querySelector('.cm-status')!;
    this.unitsEl = this.root.querySelector('.cm-units')!;
    this.pickEl = this.root.querySelector('.cm-pick')!;
    this.pickEl.querySelector('.cm-pick-merge')!.addEventListener('click', () => {
      const ids = this.pickedIds();
      const why = this.source.army.merge(ids);
      this.armyMsgEl.textContent = why || '부대를 합쳤습니다';
      if (!why) {
        this.selectedUnit = ids[0];
        this.picked.clear();
      }
      this.refreshArmy();
    });
    this.pickEl.querySelector('.cm-pick-split')!.addEventListener('click', () => {
      const id = this.pickedIds()[0];
      if (!id) return;
      const r = this.source.army.split(id);
      this.armyMsgEl.textContent = typeof r === 'string' ? r : '부대를 둘로 나눴습니다';
      if (typeof r !== 'string') {
        this.picked = new Set([id, r.id]);
        this.selectedUnit = null;
      }
      this.refreshArmy();
    });
    this.pickEl.querySelector('.cm-pick-clear')!.addEventListener('click', () => {
      this.picked.clear();
      this.refreshArmy();
    });
    this.recruitEl = this.root.querySelector('.cm-recruit')!;
    this.armyInfoEl = this.root.querySelector('.cm-army-info')!;
    this.armyMsgEl = this.root.querySelector('.cm-army-msg')!;
    this.warEl = this.root.querySelector('.cm-war')!;
    this.declareEl = this.root.querySelector('.cm-declare')!;
    this.incomingEl = this.root.querySelector('.cm-incoming')!;
    this.trespassEl = this.root.querySelector('.cm-trespass')!;
    const ruleSel = this.root.querySelector<HTMLSelectElement>('.cm-pass-rule select')!;
    ruleSel.value = this.source.passRule?.() ?? 'open';
    this.root.querySelector<HTMLElement>('.cm-pass-rule')!.hidden = !this.source.setPassRule;
    ruleSel.addEventListener('change', () => {
      this.source.setPassRule?.(ruleSel.value as PassRule);
      this.source.announce(`영해·영공: ${PASS_RULE_NAMES[ruleSel.value as PassRule]}`);
    });
    this.root.querySelector('.cm-pass-go')!.addEventListener('click', async () => {
      const them = this.cities.find((c) => c.uid === this.selected);
      const ps = this.source.passes;
      if (!them || !ps) return;
      const why = await ps.request(them.uid, them.pass ?? 'open');
      this.source.announce(
        why || (them.pass === 'permit' ? '통과 허가를 요청했습니다' : '통과를 신고했습니다'),
      );
    });
    this.openWarsEl = this.root.querySelector('.cm-open-wars')!;
    const deposit = this.root.querySelector<HTMLSelectElement>('.cm-ally-deposit')!;
    for (const d of ALLIANCE_DEPOSITS) {
      const o = document.createElement('option');
      o.value = String(d);
      o.textContent = d ? `보증금 ${formatMoney(d)}` : '보증금 없음';
      deposit.append(o);
    }
    this.root.querySelector('.cm-ally-go')!.addEventListener('click', () => void this.allyAction());
    this.root.querySelector('.cm-war-surrender')!.addEventListener('click', () => {
      const war = this.source.war;
      if (!war) return;
      const id = this.warFocus ?? undefined;
      if (war.status(id).surrenderPending) void war.withdrawSurrender(id);
      else void war.offerSurrender(id);
    });
    this.root.querySelector('.cm-war-accept')!.addEventListener('click', () => {
      void this.source.war?.acceptSurrender(this.warFocus ?? undefined);
    });
    this.root.querySelector('.cm-war-truce')!.addEventListener('click', async () => {
      const war = this.source.war;
      if (!war) return;
      const id = this.warFocus ?? undefined;
      if (war.status(id).ceasefire?.byMe) await war.withdrawCeasefire(id);
      else {
        const why = await war.offerCeasefire(id);
        this.source.announce(
          why || '휴전을 제안했습니다 · 참가국 2/3(직접 참여국 둘 다 포함)가 찬성하면 휴전',
        );
      }
    });
    this.root.querySelector('.cm-war-truce-yes')!.addEventListener('click', () => {
      void this.source.war?.voteCeasefire(true, this.warFocus ?? undefined);
    });
    this.root.querySelector('.cm-war-truce-no')!.addEventListener('click', () => {
      void this.source.war?.voteCeasefire(false, this.warFocus ?? undefined);
    });
    for (const b of this.declareEl.querySelectorAll<HTMLButtonElement>('button[data-war]'))
      b.addEventListener(
        'click',
        () => void this.declare(b.dataset.war as 'small' | 'surprise' | 'large'),
      );
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.cm-tabs button'))
      b.addEventListener('click', () => this.setTab(b.dataset.tab as 'cities' | 'army'));
    for (const type of Object.keys(UNIT_SPECS) as UnitType[]) {
      const spec = UNIT_SPECS[type];
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.unit = type;
      b.innerHTML = `<b>${spec.name} 모집</b><small></small>`;
      b.addEventListener('click', () => {
        const why = this.source.army.recruit(type);
        this.armyMsgEl.textContent = why
          ? why
          : `${spec.name} 모집 · ${Math.round(spec.buildSec / 60)}분 뒤 출동 (${FACILITY_SPECS[spec.facility].name})`;
        this.renderArmy(true);
      });
      this.recruitEl.append(b);
    }
    this.root.querySelector('.cm-close')!.addEventListener('click', () => this.close());
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    document.body.append(this.root);
    this.bindPointer();
    window.addEventListener('resize', () => {
      if (!this.root.hidden) {
        this.fit();
        this.draw();
      }
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  async open(): Promise<void> {
    this.root.hidden = false;
    if (!this.overview) {
      this.status.textContent = '지도를 펼치는 중…';
      try {
        this.overview = await loadOverview();
      } catch {
        this.status.textContent = '대륙 지도를 불러오지 못했습니다';
      }
    }
    this.fit();
    const mine = this.source.mine();
    this.cities = [mine];
    this.selected = mine.uid;
    this.focus(mine);
    this.renderList();
    this.draw();
    this.renderArmy(true);
    const loop = () => {
      if (this.root.hidden) return;
      this.renderArmy(false);
      this.renderWar();
      if (this.source.war && this.source.war.revision !== this.openWarsRev) {
        this.openWarsRev = this.source.war.revision;
        this.renderOpenWars();
      }
      if (this.source.passes && this.source.passes.revision !== this.passRev) {
        this.passRev = this.source.passes.revision;
        this.renderIncoming();
        this.renderDeclare();
      }
      this.renderTrespass();
      if (this.source.alliances && this.source.alliances.revision !== this.allyRev) {
        this.allyRev = this.source.alliances.revision;
        this.renderIncoming();
        this.renderDeclare();
        this.renderList();
      }
      this.draw();
      // 움직이는 것이 있으면 부드럽게(약 30fps), 없으면 아껴서(8fps).
      this.frame = window.setTimeout(() => requestAnimationFrame(loop), this.animating ? 16 : 120);
    };
    loop();
    await this.refresh();
    if (this.refreshTimer === null)
      this.refreshTimer = window.setInterval(() => void this.refresh(), 60_000);
  }

  /** 위쪽 전쟁 줄: 상대·단계·남은 시간·점수, 항복 버튼. */
  private renderWar(): void {
    const war = this.source.war;
    const fronts = war?.currentWars() ?? [];
    if (!fronts.some((w) => w.id === this.warFocus)) this.warFocus = fronts[0]?.id ?? null;
    const st = war?.status(this.warFocus ?? undefined);
    if (!war || !st || st.phase === 'none' || st.phase === 'ended') {
      this.warEl.hidden = true;
      return;
    }
    this.warEl.hidden = false;
    // 두 나라와 동시에 싸우면 전선을 골라 본다.
    const frontsEl = this.warEl.querySelector<HTMLElement>('.cm-war-fronts')!;
    const sig = fronts.map((w) => w.id).join('|') + '#' + this.warFocus;
    if (frontsEl.dataset.sig !== sig) {
      frontsEl.dataset.sig = sig;
      frontsEl.innerHTML = '';
      if (fronts.length > 1)
        for (const w of fronts) {
          const b = document.createElement('button');
          b.type = 'button';
          const s2 = war.status(w.id);
          b.textContent = s2.enemyName;
          b.classList.toggle('on', w.id === this.warFocus);
          b.addEventListener('click', () => {
            this.warFocus = w.id;
            this.renderWar();
          });
          frontsEl.append(b);
        }
    }
    const mmss = (ms: number) => {
      const s = Math.ceil(ms / 1000);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    const phase =
      st.phase === 'prep'
        ? `준비 ${mmss(st.prepLeftMs)} — 부대를 국경에 배치하세요`
        : st.phase === 'paused'
          ? '일시정지 — 상대가 접속을 끊었습니다(24시간 뒤 판정)'
          : '전투 중';
    this.warEl.querySelector('.cm-war-text')!.textContent =
      `⚔ ${st.enemyName}와 ${st.war?.kind === 'large' ? '대규모' : '소규모'} 전쟁 · ${phase} · 점수 ${st.scoreMe.toLocaleString('ko-KR')} : ${st.scoreEnemy.toLocaleString('ko-KR')}` +
      (st.allies.length ? ` · 우리 진영: ${st.allies.join(', ')}` : '') +
      ` · ${this.skyText()}`;
    const surrender = this.warEl.querySelector<HTMLButtonElement>('.cm-war-surrender')!;
    // 항복 신청·철회는 진영 대표만.
    surrender.hidden = !st.isLeader;
    surrender.textContent = st.surrenderPending ? '항복 철회' : '항복 신청';
    const accept = this.warEl.querySelector<HTMLButtonElement>('.cm-war-accept')!;
    accept.hidden = !st.surrenderOffered;
    accept.textContent = st.allies.length ? '항복에 동의(대표 동의 또는 2/3)' : '항복 받아들이기';
    // 휴전: 참가국 누구나 제안, 모든 진영 2/3 + 직접 참여국 둘 다 찬성이면 휴전.
    const c = st.ceasefire;
    const truce = this.warEl.querySelector<HTMLButtonElement>('.cm-war-truce')!;
    truce.hidden = st.phase === 'prep' || (!!c && !c.byMe);
    truce.textContent = c?.byMe ? `휴전 제안 철회 (찬성 ${c.yes}/${c.needed})` : '휴전 제안';
    const voting = !!c && !c.byMe;
    const yes = this.warEl.querySelector<HTMLButtonElement>('.cm-war-truce-yes')!;
    const no = this.warEl.querySelector<HTMLButtonElement>('.cm-war-truce-no')!;
    yes.hidden = no.hidden = !voting;
    if (c && voting) {
      yes.textContent = `${c.byName}의 휴전 제안 찬성 (${c.yes}/${c.needed}${c.myVote === true ? ' ✓' : ''})`;
      no.textContent = c.myVote === false ? '반대함' : '반대';
      yes.disabled = c.myVote === true;
      no.disabled = c.myVote === false;
    }
  }

  /** 고른 다른 도시에 대한 선전포고 칸. */
  private renderDeclare(): void {
    const mine = this.source.mine();
    const them = this.cities.find((c) => c.uid === this.selected);
    if (!them || them.uid === mine.uid || !this.source.war) {
      this.declareEl.hidden = true;
      return;
    }
    this.declareEl.hidden = false;
    this.declareEl.querySelector('.cm-declare-title')!.textContent = `${them.cityName}에 대해`;
    const al = this.source.alliances;
    const allyEl = this.declareEl.querySelector<HTMLElement>('.cm-ally')!;
    const warn = this.declareEl.querySelector<HTMLElement>('.cm-declare-warn')!;
    allyEl.hidden = !al;
    warn.textContent = '';
    const passEl = this.declareEl.querySelector<HTMLElement>('.cm-pass')!;
    const ps = this.source.passes;
    const rule = them.pass ?? 'open';
    passEl.hidden = !ps;
    if (ps) {
      const p = ps.pass(mine.uid, them.uid);
      const ok = passValid(rule, p, Date.now());
      const st =
        rule === 'open'
          ? ''
          : ok
            ? ' · 통과 가능'
            : p?.state === 'asked'
              ? ' · 허가 기다리는 중'
              : p?.state === 'denied'
                ? ' · 거절됨'
                : '';
      passEl.querySelector('.cm-pass-state')!.textContent =
        `영해·영공: ${PASS_RULE_NAMES[rule]}${st}`;
      const go = passEl.querySelector<HTMLButtonElement>('.cm-pass-go')!;
      go.hidden = rule === 'open' || ok || p?.state === 'asked';
      go.textContent = rule === 'permit' ? '통과 허가 요청' : '통과 신고';
    }
    if (!al) return;
    const open = al.openWith(them.uid);
    const stateEl = allyEl.querySelector<HTMLElement>('.cm-ally-state')!;
    const go = allyEl.querySelector<HTMLButtonElement>('.cm-ally-go')!;
    const select = allyEl.querySelector<HTMLSelectElement>('.cm-ally-deposit')!;
    select.hidden = !!open;
    if (!open) {
      stateEl.textContent = '동맹 아님 · 보증금은 양쪽이 같은 금액을 겁니다(배신하면 상대에게)';
      go.textContent = '동맹 신청';
    } else if (open.state === 'active') {
      stateEl.textContent = `🤝 동맹${open.deposit ? ` · 보증금 각 ${formatMoney(open.deposit)}` : ''}`;
      go.textContent = '동맹 해제(보증금 돌려받음)';
      warn.textContent = `⚠ 선전포고하면 배신입니다 — ${open.deposit ? `보증금 ${formatMoney(open.deposit)}이 상대에게 가고, ` : ''}${Math.round(BETRAYAL_LOCK_MS / 3_600_000)}시간 동안 새 동맹을 맺을 수 없습니다`;
    } else if (open.from === mine.uid) {
      stateEl.textContent = '동맹 신청을 보냈습니다 · 답을 기다리는 중';
      go.textContent = '신청 취소(보증금 돌려받음)';
    } else {
      stateEl.textContent = '이 도시가 동맹을 신청했습니다 · 위 알림에서 답하세요';
      go.textContent = '거절';
    }
  }

  /** 내 수도 위 밤낮·날씨 한 줄(효과 포함). */
  private skyText(): string {
    const now = Date.now();
    const { cx, cy } = parseChunkKey(this.source.mine().capital);
    const w = weatherAt(now, cx, cy);
    const effect =
      w === 'rain' || w === 'snow' ? '(땅 부대 이동 −20%)' : w === 'wind' ? '(공군 공격 −30%)' : '';
    return `${isNight(now) ? '🌙 밤(시야 절반)' : '☀ 낮'} · ${WEATHER_NAMES[w]}${effect}`;
  }

  /** 다른 도시들의 대규모 전쟁: 동맹한 진영으로 참가. */
  private renderOpenWars(): void {
    const war = this.source.war;
    const list = war?.openLarge ?? [];
    this.openWarsEl.hidden = !list.length;
    this.openWarsEl.innerHTML = '';
    const me = this.source.mine();
    for (const w of list) {
      const row = document.createElement('div');
      row.className = 'cm-open-war';
      const text = document.createElement('span');
      const count = (side: 'a' | 'b') =>
        1 + Object.values(w.joined ?? {}).filter((j) => j.side === side).length;
      text.textContent = `⚔ 대규모 전쟁: ${w.names[w.a] ?? '?'} 진영(${count('a')}) vs ${w.names[w.b] ?? '?'} 진영(${count('b')})`;
      row.append(text);
      for (const side of ['a', 'b'] as const) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `${w.names[w[side]] ?? '?'} 진영으로 참가`;
        const why = war!.joinWhy(w, side, me);
        b.disabled = !!why;
        b.title = why;
        b.addEventListener('click', async () => {
          const r = await war!.join(w, side, this.source.mine());
          this.source.announce(r || '전쟁에 참가했습니다 · 5분 준비 뒤 개전(이미 시작했으면 바로)');
        });
        row.append(b);
      }
      this.openWarsEl.append(row);
    }
  }

  /** 받은 동맹 신청(수락·거절). */
  /** 내 영해·영공에 규율을 어기고 들어온 다른 나라 군함·군용기(전쟁 없이 공격 가능). */
  private renderTrespass(): void {
    const ps = this.source.passes;
    const mine = this.source.mine();
    if (!ps || !this.source.passRule) {
      this.trespassEl.hidden = true;
      return;
    }
    const rule = this.source.passRule();
    const spaceSig = `${mine.owned.length}|${mine.owned[0] ?? ''}|${mine.owned.at(-1) ?? ''}`;
    if (this.space.sig !== spaceSig) {
      const sea = territorialSea(mine.owned);
      this.space = { sig: spaceSig, sea, air: airspace(mine.owned, sea) };
    }
    const { sea, air } = this.space;
    const now = Date.now();
    const found: Array<{ uid: string; name: string; cx: number; cy: number; t: UnitType }> = [];
    for (const c of this.cities) {
      if (c.uid === mine.uid || this.source.war?.atWarWith(c.uid)) continue;
      const pass = ps.pass(c.uid, mine.uid);
      for (const u of c.units ?? []) {
        if (!u.t || !bound(u.t)) continue;
        const key = `${u.cx},${u.cy}`;
        const inside = UNIT_SPECS[u.t].domain === 'sea' ? sea.has(key) : air.has(key);
        if (inside && !passValid(rule, pass, now))
          found.push({ uid: c.uid, name: c.cityName, cx: u.cx, cy: u.cy, t: u.t });
      }
    }
    const sig = found.map((f) => `${f.uid}|${f.cx},${f.cy}|${f.t}`).join(';');
    if (sig === this.trespassSig) return;
    this.trespassSig = sig;
    this.trespassEl.hidden = !found.length;
    this.trespassEl.innerHTML = '';
    for (const f of found) {
      const row = document.createElement('div');
      row.className = 'cm-incoming-row';
      const text = document.createElement('span');
      text.textContent = `⚠ ${f.name} ${UNIT_SPECS[f.t].name} 무단 진입 (${f.cx},${f.cy})`;
      const hit = document.createElement('button');
      hit.type = 'button';
      hit.textContent = '공격';
      hit.addEventListener('click', async () => {
        const power = this.source.army.incidentPower(f.cx, f.cy);
        const why = await ps.attack(f.uid, `${f.cx},${f.cy}`, power, INCIDENT_COOLDOWN_MS);
        this.armyMsgEl.textContent = why || '공격했습니다';
      });
      row.append(text, hit);
      this.trespassEl.append(row);
    }
  }

  private renderIncoming(): void {
    const al = this.source.alliances;
    const list = al?.incoming() ?? [];
    const ps = this.source.passes;
    const me = this.source.mine().uid;
    const asks = (ps?.passes ?? []).filter((p) => p.to === me && p.state === 'asked');
    this.incomingEl.hidden = !list.length && !asks.length;
    this.incomingEl.innerHTML = '';
    for (const p of asks) {
      const row = document.createElement('div');
      row.className = 'cm-incoming-row';
      const text = document.createElement('span');
      text.textContent = `🛂 ${this.cities.find((c) => c.uid === p.from)?.cityName ?? '다른 도시'} 통과 요청`;
      const yes = document.createElement('button');
      yes.type = 'button';
      yes.textContent = '허가';
      const no = document.createElement('button');
      no.type = 'button';
      no.textContent = '거절';
      yes.addEventListener('click', () => void ps!.answer(p.from, true));
      no.addEventListener('click', () => void ps!.answer(p.from, false));
      row.append(text, yes, no);
      this.incomingEl.append(row);
    }
    for (const a of list) {
      const row = document.createElement('div');
      row.className = 'cm-incoming-row';
      const text = document.createElement('span');
      text.textContent = `🤝 ${a.names[a.from] ?? '다른 도시'}의 동맹 신청${a.deposit ? ` · 보증금 ${formatMoney(a.deposit)}` : ''}`;
      const yes = document.createElement('button');
      yes.type = 'button';
      yes.textContent = '수락';
      const no = document.createElement('button');
      no.type = 'button';
      no.textContent = '거절';
      yes.addEventListener('click', async () => {
        const why = await al!.accept(a.id);
        this.source.announce(why || '동맹을 맺었습니다');
      });
      no.addEventListener('click', () => void al!.close(a.id));
      row.append(text, yes, no);
      this.incomingEl.append(row);
    }
  }

  private async allyAction(): Promise<void> {
    const al = this.source.alliances;
    const them = this.cities.find((c) => c.uid === this.selected);
    if (!al || !them) return;
    const msg = this.declareEl.querySelector('.cm-declare-msg')!;
    const open = al.openWith(them.uid);
    if (open) {
      const why = await al.close(open.id);
      msg.textContent = why || (open.state === 'active' ? '동맹을 해제했습니다' : '처리했습니다');
      return;
    }
    const deposit = Number(this.root.querySelector<HTMLSelectElement>('.cm-ally-deposit')!.value);
    msg.textContent = '보내는 중…';
    const why = await al.request(them.uid, them.cityName, deposit);
    msg.textContent = why || '동맹을 신청했습니다';
  }

  private async declare(how: 'small' | 'surprise' | 'large'): Promise<void> {
    const war = this.source.war;
    const them = this.cities.find((c) => c.uid === this.selected);
    if (!war || !them) return;
    const msg = this.declareEl.querySelector('.cm-declare-msg')!;
    msg.textContent = '보내는 중…';
    const why = await war.declare(
      them,
      this.source.mine(),
      how === 'large' ? 'large' : 'small',
      how === 'surprise',
    );
    msg.textContent = why || '선전포고했습니다';
    this.renderWar();
  }

  private setTab(tab: 'cities' | 'army'): void {
    this.tab = tab;
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.cm-tabs button'))
      b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
    for (const p of this.root.querySelectorAll<HTMLElement>('.cm-pane'))
      p.hidden = p.dataset.pane !== tab;
    if (tab === 'army') this.renderArmy(true);
  }

  /** 군대 칸: 모집 버튼 상태, 부대 목록. */
  private renderArmy(force: boolean): void {
    const army = this.source.army;
    if (!force && army.revision === this.lastArmyRevision && this.tab !== 'army') return;
    const units = army.units;
    const men = army.soldiers;
    this.armyInfoEl.textContent =
      `병영 ${army.barracks().length}곳 · 부대 ${units.length}개 · 병력 ${Math.round(men).toLocaleString('ko-KR')}명 · 더 뽑을 수 있는 인원 ${army.draftRoom().toLocaleString('ko-KR')}명` +
      ` · 유지비 ${formatMoney(army.upkeepMoney)}/일` +
      '\n부대를 누르고 지도에서 갈 곳을 누르세요. 적 땅 부대가 없는 적 청크에 1분 머물면 점령합니다(땅 부대만).' +
      (army.missiles().length
        ? `\n미사일 ${army.missiles().length}발 · 미사일을 누르고 적 땅을 누르면 발사(60청크)`
        : '');
    for (const b of this.recruitEl.querySelectorAll<HTMLButtonElement>('button[data-unit]')) {
      const type = b.dataset.unit as UnitType;
      const spec = UNIT_SPECS[type];
      const why = army.recruitBlock(type);
      b.disabled = !!why;
      b.title = why;
      // 도시 레벨이 한참 모자란 병종은 숨겨서 목록을 짧게 둔다(기본 3종 + 다음 레벨 것까지).
      b.hidden =
        this.source.cityLevel !== undefined &&
        Math.max(4, this.source.cityLevel() + 1) < spec.unlock;
      b.querySelector('small')!.textContent =
        `${formatMoney(spec.cost)} · 철 ${spec.iron}${spec.coal ? ` · 석탄 ${spec.coal}` : ''}${spec.oil ? ` · 석유 ${spec.oil}` : ''} · ${spec.men ? `${spec.men}명` : '기계'} · ${Math.round(spec.buildSec / 60)}분` +
        (why ? ` — ${why}` : '');
    }
    if (!force && army.revision === this.lastArmyRevision) {
      // 진행 막대만 고친다.
      for (const li of this.unitsEl.querySelectorAll<HTMLElement>('li[data-id]')) {
        const u = units.find((x) => x.id === li.dataset.id);
        if (u) this.fillUnitRow(li, u);
      }
      return;
    }
    this.lastArmyRevision = army.revision;
    this.unitsEl.innerHTML = '';
    if (!units.length) {
      const li = document.createElement('li');
      li.className = 'cm-empty';
      li.textContent = '부대가 없습니다. 내 영토에 병영을 짓고 위에서 모집하세요.';
      this.unitsEl.append(li);
    }
    for (const u of units) {
      const li = document.createElement('li');
      li.dataset.id = u.id;
      li.className =
        'cm-unit' +
        (u.id === this.selectedUnit ? ' selected' : '') +
        (this.picked.has(u.id) ? ' picked' : '');
      let pressTimer = 0;
      let pressed = false;
      li.addEventListener('pointerdown', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        pressed = false;
        pressTimer = window.setTimeout(() => {
          pressed = true;
          this.togglePick(u.id);
        }, 450);
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel'])
        li.addEventListener(ev, () => clearTimeout(pressTimer));
      li.innerHTML = `<span class="cm-unit-badge"></span><span class="cm-unit-text"></span>
        <span class="cm-bar"><i class="org"></i></span>
        <button type="button" class="cm-airlift" title="공중 수송: 공항에서 내 땅으로" hidden>✈</button>
        <button type="button" class="cm-disband" title="해산: 남은 인원이 인구로 돌아갑니다">해산</button>`;
      li.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.cm-disband, .cm-airlift')) return;
        if (pressed) return;
        if (this.picked.size) {
          this.togglePick(u.id);
          return;
        }
        this.selectedUnit = u.id === this.selectedUnit ? null : u.id;
        if (this.selectedUnit) this.focusUnit(u);
        this.lastArmyRevision = -1;
        this.renderArmy(true);
        this.draw();
      });
      const fly = li.querySelector<HTMLButtonElement>('.cm-airlift')!;
      fly.hidden =
        UNIT_SPECS[u.type].domain !== 'ground' ||
        u.state === 'training' ||
        !!u.airlift ||
        !army.airportAt(u.cx, u.cy);
      fly.addEventListener('click', () => {
        this.selectedUnit = u.id;
        this.airliftMode = true;
        this.armyMsgEl.textContent = `✈ 공중 수송: 내릴 내 땅을 지도에서 누르세요 (${formatMoney(AIRLIFT_COST)}, ${AIRLIFT_RANGE_CHUNKS}청크 안)`;
        this.lastArmyRevision = -1;
        this.renderArmy(true);
        this.draw();
      });
      li.querySelector('.cm-disband')!.addEventListener('click', () => {
        if (u.state === 'fighting') {
          this.armyMsgEl.textContent = '전투 중인 부대는 해산할 수 없습니다';
          return;
        }
        army.disband(u.id);
        if (this.selectedUnit === u.id) this.selectedUnit = null;
        this.armyMsgEl.textContent = `${UNIT_SPECS[u.type].name} 부대를 해산했습니다 · 인원이 도시로 돌아갑니다`;
        this.renderArmy(true);
      });
      this.fillUnitRow(li, u);
      this.unitsEl.append(li);
    }
  }

  private fillUnitRow(li: HTMLElement, u: Unit): void {
    const spec = UNIT_SPECS[u.type];
    li.querySelector('.cm-unit-badge')!.textContent = UNIT_LETTER[u.type];
    const train =
      u.state === 'training' && u.readyAt
        ? ` ${Math.max(0, Math.ceil((u.readyAt - Date.now()) / 1000))}초`
        : '';
    li.querySelector('.cm-unit-text')!.textContent =
      `${spec.name} ${u.id.slice(1)} · ${Math.round(u.men)}/${u.maxMen}명 · ${STATE_TEXT[u.state]}${train}` +
      (u.path.length ? ` · ${u.path.length}청크 남음` : '') +
      (expRank(u.exp) !== '보통' ? ` · ${expRank(u.exp)}` : '') +
      (u.noAmmo ? ' · 탄약 없음' : '');
    (li.querySelector('.cm-bar i') as HTMLElement).style.width = `${Math.round(u.org)}%`;
  }

  /** 지금 고른 부대들(길게 눌러 고른 것 + 눌러 고른 것). */
  private pickedIds(): string[] {
    const live = new Set(this.source.army.units.map((u) => u.id));
    const out = [...this.picked].filter((id) => live.has(id));
    if (this.selectedUnit && live.has(this.selectedUnit) && !out.includes(this.selectedUnit))
      out.unshift(this.selectedUnit);
    return out;
  }

  /** 길게 누르기: 여러 부대 고르기에 넣거나 뺀다. */
  private togglePick(id: string): void {
    if (this.picked.has(id)) this.picked.delete(id);
    else this.picked.add(id);
    if (this.selectedUnit && !this.picked.has(this.selectedUnit)) {
      this.picked.add(this.selectedUnit);
      this.selectedUnit = null;
    }
    this.refreshArmy();
  }

  private refreshArmy(): void {
    this.lastArmyRevision = -1;
    this.renderArmy(true);
    this.renderPick();
    this.draw();
  }

  private renderPick(): void {
    const ids = this.pickedIds();
    const many = this.picked.size > 0;
    this.pickEl.hidden = !many;
    if (!many) return;
    this.pickEl.querySelector('.cm-pick-text')!.textContent = `${ids.length}개 선택`;
    this.pickEl.querySelector<HTMLButtonElement>('.cm-pick-merge')!.disabled = ids.length < 2;
    this.pickEl.querySelector<HTMLButtonElement>('.cm-pick-split')!.disabled = ids.length !== 1;
  }

  private focusUnit(u: Unit): void {
    const p = unitPosition(u);
    const w = this.canvas.clientWidth || 640;
    const h = this.canvas.clientHeight || 448;
    this.scale = Math.max(this.scale, 5);
    const s = this.scale * PX_PER_CHUNK;
    this.ox = w / 2 - (p.x - CONTINENT_X0) * s;
    this.oy = h / 2 - (p.y - CONTINENT_Y0) * s;
    this.clampPan();
  }

  close(): void {
    this.root.hidden = true;
    clearTimeout(this.frame);
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private async refresh(): Promise<void> {
    const mine = this.source.mine();
    if (!this.source.online) {
      this.cities = [mine];
      this.status.textContent = '둘러보기 모드: 내 도시만 보입니다';
    } else {
      this.status.textContent = '다른 도시를 불러오는 중…';
      try {
        const others = (await this.source.load()).filter((c) => c.uid !== mine.uid);
        const found = others.filter((c) => this.discovered(c));
        this.hiddenCount = others.length - found.length;
        this.cities = [mine, ...found];
        // 평시에는 남의 영토로 부대를 보낼 수 없다.
        const foreign = new Set<string>();
        for (const c of others) for (const k of c.owned) foreign.add(k);
        this.source.army.foreignOwned = foreign;
        this.source.onForeign?.(foreign);
        const online = this.cities.filter((c) => c.online).length;
        const clock = sharedClockOffset();
        this.status.textContent =
          `찾은 도시 ${this.cities.length}곳 · 접속 중 ${online}곳` +
          (this.hiddenCount ? ` · 아직 못 찾은 도시가 있습니다(부대로 탐사)` : '') +
          (clock.synced ? ` · 서버 시각 ${new Date(sharedNow()).toLocaleTimeString('ko-KR')}` : '');
      } catch (err) {
        console.warn('다른 도시를 읽지 못했습니다', err);
        this.cities = [mine];
        this.status.textContent = '다른 도시를 불러오지 못했습니다 · 잠시 뒤 다시 엽니다';
      }
    }
    this.renderList();
    this.draw();
  }

  /** 내가 아는 청크(관리자는 null = 전부). */
  private knownSet(): ReadonlySet<string> | null {
    if (this.source.seeAll) return null;
    return this.source.known?.() ?? null;
  }

  /** 이 도시를 찾았는가: 아는 땅에 영토가 있거나, 동맹(신청 포함)·전쟁 상대. */
  private discovered(c: PublicCity): boolean {
    if (c.uid === this.source.mine().uid || this.source.seeAll) return true;
    if (this.source.alliances?.openWith(c.uid)) return true;
    if (this.source.war?.currentWars().some((w) => w.parties.includes(c.uid))) return true;
    const known = this.knownSet();
    if (!known) return true;
    return c.owned.some((k) => known.has(k));
  }

  /** 흐린 지도를 한 번 만든다. */
  private makeBlurred(): void {
    const img = this.overview;
    if (!img || this.blurred) return;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(w / 10));
    small.height = Math.max(1, Math.round(h / 10));
    const sctx = small.getContext('2d')!;
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(img, 0, 0, small.width, small.height);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d')!;
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(small, 0, 0, w, h);
    // 색을 죽이고 어둡게: 지형 윤곽만 어렴풋이.
    octx.globalCompositeOperation = 'saturation';
    octx.fillStyle = 'hsl(0, 0%, 50%)';
    octx.globalAlpha = 0.7;
    octx.fillRect(0, 0, w, h);
    octx.globalCompositeOperation = 'source-over';
    octx.globalAlpha = 1;
    octx.fillStyle = 'rgba(12, 20, 26, 0.55)';
    octx.fillRect(0, 0, w, h);
    this.blurred = out;
  }

  private renderList(): void {
    this.list.innerHTML = '';
    const mineUid = this.source.mine().uid;
    for (const c of this.cities) {
      const li = document.createElement('li');
      li.className = 'cm-city' + (c.uid === this.selected ? ' selected' : '');
      const dot = c.uid === mineUid || c.online ? '●' : '○';
      li.innerHTML = `
        <span class="cm-swatch" style="background:${cityColor(c.cityIndex, 1)}"></span>
        <span class="cm-name"></span>
        <span class="cm-meta"></span>`;
      li.querySelector('.cm-name')!.textContent =
        `${c.cityName}${c.uid === mineUid ? ' (내 도시)' : ''}${this.source.alliances?.isAllied(c.uid) ? ' 🤝' : ''}`;
      li.querySelector('.cm-meta')!.textContent =
        `${dot} ${c.uid === mineUid ? '접속 중' : c.online ? '접속 중' : ago(c.lastSeen)} · Lv.${c.cityLevel} · 인구 ${Math.round(c.population).toLocaleString('ko-KR')} · 영토 ${c.owned.length}청크 · 수도 Lv.${c.capitalLevel}`;
      li.addEventListener('click', () => {
        this.selected = c.uid;
        this.focus(c);
        this.renderList();
        this.renderDeclare();
        this.draw();
      });
      this.list.append(li);
    }
  }

  /* ---------------- 그리기 ---------------- */

  private fit(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || 640;
    const h = this.canvas.clientHeight || 448;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const mw = CONTINENT_W * PX_PER_CHUNK;
    const mh = CONTINENT_H * PX_PER_CHUNK;
    this.fitScale = Math.min(w / mw, h / mh);
    if (this.scale < this.fitScale) this.scale = this.fitScale;
    this.clampPan();
  }

  /** 도시가 화면 가운데 오게, 적당히 확대해서. */
  private focus(c: PublicCity): void {
    const known = this.knownSet();
    const anchor =
      !known || c.uid === this.source.mine().uid || known.has(c.capital)
        ? c.capital
        : (c.owned.find((k) => known.has(k)) ?? this.source.mine().capital);
    const { cx, cy } = parseChunkKey(anchor);
    const w = this.canvas.clientWidth || 640;
    const h = this.canvas.clientHeight || 448;
    this.scale = Math.max(this.fitScale, 3);
    const s = this.scale * PX_PER_CHUNK;
    this.ox = w / 2 - (cx + 1 - CONTINENT_X0) * s;
    this.oy = h / 2 - (cy + 1 - CONTINENT_Y0) * s;
    this.clampPan();
  }

  private zoomAt(factor: number, px: number, py: number): void {
    const next = Math.min(16, Math.max(this.fitScale, this.scale * factor));
    const k = next / this.scale;
    this.ox = px - (px - this.ox) * k;
    this.oy = py - (py - this.oy) * k;
    this.scale = next;
    this.clampPan();
  }

  private clampPan(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const mw = CONTINENT_W * PX_PER_CHUNK * this.scale;
    const mh = CONTINENT_H * PX_PER_CHUNK * this.scale;
    this.ox = mw <= w ? (w - mw) / 2 : Math.min(0, Math.max(w - mw, this.ox));
    this.oy = mh <= h ? (h - mh) / 2 : Math.min(0, Math.max(h - mh, this.oy));
  }

  private draw(): void {
    const ctx = this.ctx;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const dpr = this.canvas.width / Math.max(1, cw);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#122a38';
    ctx.fillRect(0, 0, cw, ch);
    const s = this.scale * PX_PER_CHUNK;
    const mw = CONTINENT_W * s;
    const mh = CONTINENT_H * s;
    const X = (cx: number) => this.ox + (cx - CONTINENT_X0) * s;
    const Y = (cy: number) => this.oy + (cy - CONTINENT_Y0) * s;
    const known = this.knownSet();
    if (this.overview) {
      if (known) {
        // 안 가 본 곳은 흐리게, 아는 곳만 선명하게.
        this.makeBlurred();
        ctx.imageSmoothingEnabled = true;
        if (this.blurred) ctx.drawImage(this.blurred, this.ox, this.oy, mw, mh);
        ctx.save();
        ctx.beginPath();
        for (const k of known) {
          const { cx, cy } = parseChunkKey(k);
          ctx.rect(X(cx) - 0.25, Y(cy) - 0.25, s + 0.5, s + 0.5);
        }
        ctx.clip();
        ctx.imageSmoothingEnabled = this.scale < 1.5;
        ctx.drawImage(this.overview, this.ox, this.oy, mw, mh);
        ctx.restore();
      } else {
        ctx.imageSmoothingEnabled = this.scale < 1.5;
        ctx.drawImage(this.overview, this.ox, this.oy, mw, mh);
      }
    }
    const mineUid = this.source.mine().uid;
    for (const c of this.cities) {
      // 다른 도시는 내가 아는 땅에 걸친 부분만 보인다.
      // 동맹(맺은 것)과 지금 같은 전쟁의 도시는 영토 전체를 안다.
      const full = !known || c.uid === mineUid || !!this.source.war?.atWarWith(c.uid);
      const owned = new Set(full ? c.owned : c.owned.filter((k) => known.has(k)));
      if (!owned.size) continue;
      const capKnown = full || owned.has(c.capital);
      ctx.fillStyle = cityColor(c.cityIndex, c.uid === mineUid ? 0.55 : 0.45);
      ctx.beginPath();
      for (const key of owned) {
        const { cx, cy } = parseChunkKey(key);
        ctx.rect(X(cx), Y(cy), s + 0.5, s + 0.5);
      }
      ctx.fill();
      // 바깥 경계선
      ctx.strokeStyle = cityColor(c.cityIndex, 1);
      ctx.lineWidth = c.uid === this.selected ? 2.5 : 1.5;
      ctx.beginPath();
      for (const key of owned) {
        const { cx, cy } = parseChunkKey(key);
        const x0 = X(cx);
        const y0 = Y(cy);
        if (!owned.has(`${cx},${cy - 1}`)) (ctx.moveTo(x0, y0), ctx.lineTo(x0 + s, y0));
        if (!owned.has(`${cx + 1},${cy}`)) (ctx.moveTo(x0 + s, y0), ctx.lineTo(x0 + s, y0 + s));
        if (!owned.has(`${cx},${cy + 1}`)) (ctx.moveTo(x0, y0 + s), ctx.lineTo(x0 + s, y0 + s));
        if (!owned.has(`${cx - 1},${cy}`)) (ctx.moveTo(x0, y0), ctx.lineTo(x0, y0 + s));
      }
      ctx.stroke();
      const cap = parseChunkKey(capKnown ? c.capital : [...owned][0]);
      const span = capKnown ? [2, 4, 6][c.capitalLevel - 1] : 1;
      if (capKnown) {
        ctx.strokeStyle = '#1b1408';
        ctx.lineWidth = 3;
        ctx.strokeRect(X(cap.cx), Y(cap.cy), span * s, span * s);
        ctx.strokeStyle = '#f2cf7a';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(X(cap.cx), Y(cap.cy), span * s, span * s);
      }
      // 이름표
      if (s >= 3 || c.uid === this.selected) {
        const label = `${c.cityName} Lv.${c.cityLevel}`;
        const lx = X(cap.cx) + (span * s) / 2;
        const ly = Y(cap.cy) - 6;
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(10, 16, 20, 0.85)';
        ctx.strokeText(label, lx, ly);
        ctx.fillStyle = '#f4f1e6';
        ctx.fillText(label, lx, ly);
        const online = c.uid === mineUid || c.online;
        ctx.fillStyle = online ? '#6fe08a' : '#7d8a90';
        ctx.beginPath();
        ctx.arc(lx - ctx.measureText(label).width / 2 - 8, ly - 4, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    this.drawUnits(X, Y, s);
  }

  private drawUnits(X: (cx: number) => number, Y: (cy: number) => number, s: number): void {
    const ctx = this.ctx;
    const army = this.source.army;
    const war = army.war;
    // 점령한/빼앗긴 청크
    if (war) {
      for (const [key, who] of war.occupied) {
        const { cx, cy } = parseChunkKey(key);
        ctx.fillStyle = who === army.uid ? 'rgba(111, 211, 184, 0.55)' : 'rgba(226, 87, 76, 0.55)';
        ctx.fillRect(X(cx), Y(cy), s, s);
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(X(cx), Y(cy) + s);
        ctx.lineTo(X(cx) + s, Y(cy));
        ctx.stroke();
      }
    }
    const r = Math.max(7, Math.min(14, s * 0.45));
    const now = performance.now();
    const dt = Math.min(0.2, (now - (this.lastFrameAt || now)) / 1000);
    this.lastFrameAt = now;
    const pulse = (Math.sin(now / 160) + 1) / 2;
    let moving = false;
    const seen = new Set<string>();
    /** 그릴 자리: 목표(계산된 위치) 쪽으로 미끄러지듯. 3청크 넘게 튀면 바로 옮긴다. */
    const place = (u: Unit, mine: boolean): { x: number; y: number } => {
      const target = unitPosition(u);
      const id = `${mine ? 'm' : 'e'}${u.id}`;
      seen.add(id);
      const cur = this.shown.get(id);
      if (!cur || Math.hypot(cur.x - target.x, cur.y - target.y) > 3) {
        this.shown.set(id, { ...target });
        return target;
      }
      const k = Math.min(1, dt * 6);
      cur.x += (target.x - cur.x) * k;
      cur.y += (target.y - cur.y) * k;
      if (Math.hypot(cur.x - target.x, cur.y - target.y) > 0.01) moving = true;
      return cur;
    };
    const drawUnit = (u: Unit, mine: boolean) => {
      if (u.airlift) {
        // 수송기: 출발지 → 도착지 점선 위를 나는 비행기
        const a = parseChunkKey(u.airlift.from);
        const b = parseChunkKey(u.airlift.to);
        const p = unitPosition(u);
        const x = X(p.x - 0.5) + s / 2;
        const y = Y(p.y - 0.5) + s / 2;
        ctx.strokeStyle = 'rgba(242, 207, 122, 0.6)';
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(X(a.cx) + s / 2, Y(a.cy) + s / 2);
        ctx.lineTo(X(b.cx) + s / 2, Y(b.cy) + s / 2);
        ctx.stroke();
        ctx.setLineDash([]);
        const ang = Math.atan2(b.cy - a.cy, b.cx - a.cx);
        ctx.save();
        ctx.translate(x, y - 4);
        ctx.rotate(ang);
        ctx.fillStyle = '#e8eef2';
        ctx.strokeStyle = '#0d1418';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(r, 0);
        ctx.lineTo(-r * 0.8, -r * 0.25);
        ctx.lineTo(-r * 0.8, r * 0.25);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillRect(-r * 0.2, -r * 0.8, r * 0.35, r * 1.6);
        ctx.restore();
        moving = true;
        return;
      }
      const p = place(u, mine);
      if (u.state === 'moving' || u.state === 'retreating' || u.state === 'fighting') moving = true;
      const x = X(p.x - 0.5) + s / 2;
      const y = Y(p.y - 0.5) + s / 2;
      // 전투 중: 붉은 고리가 맥박치고 불꽃이 튄다.
      if (u.state === 'fighting') {
        ctx.strokeStyle = `rgba(255, 96, 64, ${0.35 + pulse * 0.5})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, r * (1.3 + pulse * 0.35), 0, Math.PI * 2);
        ctx.stroke();
        const a = (now / 90 + u.id.length) % (Math.PI * 2);
        ctx.fillStyle = '#ffd36b';
        ctx.fillRect(x + Math.cos(a) * r * 1.2 - 1.5, y + Math.sin(a) * r * 1.2 - 1.5, 3, 3);
      }
      // 후퇴: 흐릿하게 깜빡인다.
      ctx.globalAlpha = u.state === 'retreating' ? 0.55 + pulse * 0.35 : 1;
      if (mine && u.state === 'training' && u.readyAt) {
        // 훈련 진행 고리
        const total = UNIT_SPECS[u.type].buildSec * 1000;
        const f = Math.max(0, Math.min(1, 1 - (u.readyAt - Date.now()) / total));
        ctx.strokeStyle = '#9fb3bd';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.35, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
        ctx.stroke();
      }
      if (mine && u.occupyAt !== undefined) {
        // 점령 진행 고리(60초)
        const f = Math.max(0, Math.min(1, (Date.now() - u.occupyAt) / (OCCUPY_SECONDS * 1000)));
        ctx.strokeStyle = '#6fd3b8';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.45, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
        ctx.stroke();
        moving = true;
      }
      if (mine && u.id === this.selectedUnit && u.path.length) {
        ctx.strokeStyle = '#f2cf7a';
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (const k of u.path) {
          const c = parseChunkKey(k);
          ctx.lineTo(X(c.cx) + s / 2, Y(c.cy) + s / 2);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = mine ? (u.state === 'training' ? '#5b6e78' : '#2f6fd0') : '#c8402f';
      const on = mine && (u.id === this.selectedUnit || this.picked.has(u.id));
      ctx.strokeStyle = on ? '#f2cf7a' : '#0d1418';
      ctx.lineWidth = on ? 3 : 1.5;
      ctx.beginPath();
      ctx.rect(x - r, y - r * 0.75, r * 2, r * 1.5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${Math.round(r * 0.95)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(UNIT_LETTER[u.type], x, y + 1);
      // 조직력 막대 + 인원
      ctx.fillStyle = '#0d1418';
      ctx.fillRect(x - r, y + r * 0.75 + 2, r * 2, 3);
      ctx.fillStyle = u.org > 40 ? '#6fe08a' : '#e2a44c';
      ctx.fillRect(x - r, y + r * 0.75 + 2, (r * 2 * u.org) / 100, 3);
      if (s >= 6) {
        ctx.font = '600 10px system-ui, sans-serif';
        ctx.fillStyle = '#f4f1e6';
        ctx.fillText(`${Math.round(u.men)}`, x, y + r * 0.75 + 12);
      }
      ctx.textBaseline = 'alphabetic';
      ctx.globalAlpha = 1;
    };
    for (const u of army.units) drawUnit(u, true);
    if (war) {
      // 적 부대는 내 부대·영토에서 시야(2청크), 레이더(6청크) 안에 있을 때만 보인다.
      const radar = army.visionSources();
      // 밤에는 시야 절반.
      const vis = visionAt(Date.now(), VISION_CHUNKS);
      const seeing = (e: Unit) => {
        for (const u of army.units)
          if (
            u.state !== 'training' &&
            Math.max(Math.abs(u.cx - e.cx), Math.abs(u.cy - e.cy)) <= vis
          )
            return true;
        for (let dy = -vis; dy <= vis; dy++)
          for (let dx = -vis; dx <= vis; dx++)
            if (this.source.army.mySide().owned.has(`${e.cx + dx},${e.cy + dy}`)) return true;
        for (const r of radar)
          if (Math.max(Math.abs(r.cx - e.cx), Math.abs(r.cy - e.cy)) <= r.r) return true;
        return false;
      };
      for (const e of war.enemy.units) if (e.state !== 'training' && seeing(e)) drawUnit(e, false);
    }
    for (const id of [...this.shown.keys()]) if (!seen.has(id)) this.shown.delete(id);
    const fx = this.drawEffects(X, Y, s, now);
    const sky = this.drawSky(X, Y, s, now);
    this.animating = moving || fx || sky;
  }

  /** 미사일·폭발·요격·점령·교전 효과. 그린 게 있으면 true. */
  private drawEffects(
    X: (cx: number) => number,
    Y: (cy: number) => number,
    s: number,
    now: number,
  ): boolean {
    const ctx = this.ctx;
    const list = this.source.army.effects.filter((e) => now - e.at < 3000);
    const center = (key: string) => {
      const { cx, cy } = parseChunkKey(key);
      return { x: X(cx) + s / 2, y: Y(cy) + s / 2 };
    };
    for (const e of list) {
      const t = (now - e.at) / 1000;
      const c = center(e.key);
      if (e.kind === 'missile' && e.from) {
        // 1.2초 동안 포물선으로 날아가 터진다.
        const a = center(e.from);
        const f = Math.min(1, t / 1.2);
        const lift = Math.hypot(c.x - a.x, c.y - a.y) * 0.35;
        const px = a.x + (c.x - a.x) * f;
        const py = a.y + (c.y - a.y) * f - Math.sin(f * Math.PI) * lift;
        if (f < 1) {
          ctx.strokeStyle = 'rgba(255, 220, 160, 0.6)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let i = 0; i <= 12; i++) {
            const g = (f * i) / 12;
            const x = a.x + (c.x - a.x) * g;
            const y = a.y + (c.y - a.y) * g - Math.sin(g * Math.PI) * lift;
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          }
          ctx.stroke();
          ctx.fillStyle = '#fff3c4';
          ctx.beginPath();
          ctx.arc(px, py, 3.5, 0, Math.PI * 2);
          ctx.fill();
        } else this.boom(c.x, c.y, s, t - 1.2);
      } else if (e.kind === 'boom' || e.kind === 'bomb') this.boom(c.x, c.y, s, t);
      else if (e.kind === 'intercept') {
        // 공중에서 막힘: 하얀 섬광 + 방패 고리
        const f = Math.min(1, t / 0.8);
        ctx.strokeStyle = `rgba(150, 210, 255, ${1 - f})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(c.x, c.y - s * 0.6, s * (0.3 + f), 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.kind === 'occupy') {
        // 깃발이 올라간다
        const f = Math.min(1, t / 0.6);
        ctx.globalAlpha = Math.min(1, (3 - t) / 0.6);
        ctx.strokeStyle = '#1b1408';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(c.x, c.y + s * 0.3);
        ctx.lineTo(c.x, c.y - s * 0.5 * f);
        ctx.stroke();
        ctx.fillStyle = '#6fd3b8';
        ctx.fillRect(c.x, c.y - s * 0.5 * f, s * 0.35, s * 0.22);
        ctx.globalAlpha = 1;
      } else if (e.kind === 'clash') {
        const f = Math.min(1, t / 0.7);
        ctx.strokeStyle = `rgba(255, 210, 120, ${1 - f})`;
        ctx.lineWidth = 2;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(c.x + Math.cos(a) * s * 0.2 * f, c.y + Math.sin(a) * s * 0.2 * f);
          ctx.lineTo(c.x + Math.cos(a) * s * 0.6 * f, c.y + Math.sin(a) * s * 0.6 * f);
          ctx.stroke();
        }
      }
    }
    return list.length > 0;
  }

  /**
   * 밤·날씨: 밤이면 지도 전체를 어둡게, 날씨 지역(16×16청크)마다 비·눈·바람을 흘린다.
   * 화면에 보이는 지역만 그린다. 그린 게 있으면 true(계속 움직이므로).
   */
  private drawSky(
    X: (cx: number) => number,
    Y: (cy: number) => number,
    s: number,
    now: number,
  ): boolean {
    const ctx = this.ctx;
    const wall = Date.now();
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (isNight(wall)) {
      ctx.fillStyle = 'rgba(10, 18, 48, 0.32)';
      ctx.fillRect(0, 0, cw, ch);
    }
    const R = WEATHER_REGION;
    // 날씨는 내가 아는 땅 위에서만 보인다(모르는 곳의 하늘은 모른다).
    const known = this.knownSet();
    const knowsRegion = (rx: number, ry: number): boolean => {
      if (!known) return true;
      for (const k of known) {
        const { cx, cy } = parseChunkKey(k);
        if (cx >= rx && cx < rx + R && cy >= ry && cy < ry + R) return true;
      }
      return false;
    };
    const cx0 = Math.floor((CONTINENT_X0 + (0 - this.ox) / s) / R) * R;
    const cy0 = Math.floor((CONTINENT_Y0 + (0 - this.oy) / s) / R) * R;
    const cx1 = CONTINENT_X0 + (cw - this.ox) / s;
    const cy1 = CONTINENT_Y0 + (ch - this.oy) / s;
    let any = false;
    const t = now / 1000;
    for (let ry = cy0; ry < cy1; ry += R)
      for (let rx = cx0; rx < cx1; rx += R) {
        const w = weatherAt(wall, rx, ry);
        if (w === 'clear' || !knowsRegion(rx, ry)) continue;
        const x0 = X(rx);
        const y0 = Y(ry);
        const size = R * s;
        ctx.save();
        ctx.beginPath();
        if (known) {
          for (const k of known) {
            const { cx, cy } = parseChunkKey(k);
            if (cx >= rx && cx < rx + R && cy >= ry && cy < ry + R) ctx.rect(X(cx), Y(cy), s, s);
          }
        } else ctx.rect(x0, y0, size, size);
        ctx.clip();
        ctx.fillStyle = w === 'snow' ? 'rgba(220,230,240,0.06)' : 'rgba(40,60,80,0.07)';
        ctx.fillRect(x0, y0, size, size);
        if (s < 12) {
          // 멀리서 볼 때는 지역마다 작은 표시만(움직이지 않음).
          ctx.restore();
          ctx.font = `${Math.max(10, Math.min(16, size * 0.3))}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.globalAlpha = 0.7;
          ctx.fillText(
            w === 'rain' ? '🌧' : w === 'snow' ? '❄' : '💨',
            x0 + size / 2,
            y0 + size / 2,
          );
          ctx.globalAlpha = 1;
          continue;
        }
        any = true;
        const n = Math.min(40, Math.max(8, Math.round(size / 14)));
        for (let i = 0; i < n; i++) {
          // 입자마다 고정 위치에서 시간에 따라 흘러간다(난수 대신 i 로).
          const fx = ((i * 0.6180339) % 1) * size;
          const fy = ((i * 0.4142135) % 1) * size;
          if (w === 'rain') {
            const y = y0 + ((fy + t * 220) % size);
            const x = x0 + ((fx + t * 40) % size);
            ctx.strokeStyle = 'rgba(170, 200, 230, 0.55)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x - 3, y + 9);
            ctx.stroke();
          } else if (w === 'snow') {
            const y = y0 + ((fy + t * 30) % size);
            const x = x0 + ((fx + Math.sin(t + i) * 8 + size) % size);
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.fillRect(x, y, 2, 2);
          } else {
            const x = x0 + ((fx + t * 160) % size);
            const y = y0 + fy + Math.sin(t * 2 + i) * 3;
            ctx.strokeStyle = 'rgba(230, 240, 245, 0.35)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.quadraticCurveTo(x + 8, y - 3, x + 16, y);
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    return any;
  }

  /** 폭발: 섬광 → 불덩이 → 연기 고리. t = 터진 뒤 초. */
  private boom(x: number, y: number, s: number, t: number): void {
    if (t < 0 || t > 1.8) return;
    const ctx = this.ctx;
    const R = Math.max(8, s * 0.9);
    const f = t / 1.8;
    ctx.fillStyle = `rgba(255, 240, 200, ${Math.max(0, 0.9 - t * 4)})`;
    ctx.beginPath();
    ctx.arc(x, y, R * (0.4 + t * 2), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255, 120, 40, ${Math.max(0, 0.8 - f)})`;
    ctx.beginPath();
    ctx.arc(x, y, R * (0.3 + f * 0.7), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(60, 60, 60, ${Math.max(0, 0.6 - f * 0.6)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, R * (0.5 + f * 1.2), 0, Math.PI * 2);
    ctx.stroke();
  }

  /** 화면 좌표 근처의 내 부대. */
  private unitAt(px: number, py: number): Unit | null {
    const s = this.scale * PX_PER_CHUNK;
    const r = Math.max(9, Math.min(16, s * 0.5));
    let best: Unit | null = null;
    let bd = Infinity;
    for (const u of this.source.army.units) {
      const p = unitPosition(u);
      const x = this.ox + (p.x - CONTINENT_X0) * s;
      const y = this.oy + (p.y - CONTINENT_Y0) * s;
      const d = Math.hypot(px - x, py - y);
      if (d < r && d < bd) {
        bd = d;
        best = u;
      }
    }
    return best;
  }

  private tapAt(px: number, py: number): void {
    const hit = this.unitAt(px, py);
    if (hit && this.picked.size) {
      this.togglePick(hit.id);
      this.setTab('army');
      return;
    }
    if (!hit && this.picked.size && !this.airliftMode) {
      const s = this.scale * PX_PER_CHUNK;
      const cx = Math.floor(CONTINENT_X0 + (px - this.ox) / s);
      const cy = Math.floor(CONTINENT_Y0 + (py - this.oy) / s);
      let ok = 0;
      let why = '';
      for (const id of this.pickedIds()) {
        const r = this.source.army.order(id, cx, cy);
        if (r) why = r;
        else ok++;
      }
      this.armyMsgEl.textContent = ok
        ? `${ok}개 부대에 이동 명령을 내렸습니다${why ? ` · 못 간 부대: ${why}` : ''}`
        : why;
      this.refreshArmy();
      return;
    }
    if (hit) {
      this.selectedUnit = hit.id === this.selectedUnit ? null : hit.id;
      this.setTab('army');
      this.lastArmyRevision = -1;
      this.renderArmy(true);
      this.draw();
      return;
    }
    if (!this.selectedUnit) return;
    const s = this.scale * PX_PER_CHUNK;
    const cx = Math.floor(CONTINENT_X0 + (px - this.ox) / s);
    const cy = Math.floor(CONTINENT_Y0 + (py - this.oy) / s);
    if (this.airliftMode) {
      this.airliftMode = false;
      const why = this.source.army.airlift(this.selectedUnit, cx, cy);
      this.armyMsgEl.textContent = why || '✈ 이륙! 잠시 뒤 내립니다';
      if (why) this.source.announce(why);
      this.renderArmy(true);
      this.draw();
      return;
    }
    const missile =
      this.source.army.units.find((u) => u.id === this.selectedUnit)?.type === 'missile';
    const why = this.source.army.order(this.selectedUnit, cx, cy);
    if (missile && !why) this.selectedUnit = null;
    this.armyMsgEl.textContent = why || (missile ? '미사일 발사!' : '이동 명령을 내렸습니다');
    if (why) this.source.announce(why);
    this.renderArmy(true);
    this.draw();
  }

  /* ---------------- 입력 ---------------- */

  private bindPointer(): void {
    const c = this.canvas;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    let downAt: { x: number; y: number } | null = null;
    let dragged = false;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    let pressTimer = 0;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 1) {
        downAt = local(e);
        dragged = false;
        // 부대를 길게 누르면 여러 부대 고르기.
        const at = downAt;
        clearTimeout(pressTimer);
        pressTimer = window.setTimeout(() => {
          if (dragged || pointers.size !== 1) return;
          const hit = this.unitAt(at.x, at.y);
          if (!hit) return;
          dragged = true; // 손을 떼도 탭으로 처리하지 않는다.
          this.togglePick(hit.id);
          this.setTab('army');
        }, 450);
      }
      if (pointers.size === 2) {
        dragged = true;
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    c.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) this.zoomAt(d / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = d;
      } else {
        if (downAt && !dragged && Math.hypot(p.x - downAt.x, p.y - downAt.y) > 6) dragged = true;
        if (!dragged) return;
        this.ox += p.x - prev.x;
        this.oy += p.y - prev.y;
        this.clampPan();
      }
      this.draw();
    });
    const up = (e: PointerEvent) => {
      clearTimeout(pressTimer);
      pointers.delete(e.pointerId);
      if (pointers.size === 0 && downAt && !dragged) {
        const p = local(e);
        this.tapAt(p.x, p.y);
      }
      if (pointers.size === 0) downAt = null;
      pinch = 0;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = local(e);
        this.zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
        this.draw();
      },
      { passive: false },
    );
  }
}
