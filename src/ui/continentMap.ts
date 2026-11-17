import { CONTINENT_H, CONTINENT_W, CONTINENT_X0, CONTINENT_Y0 } from '../world/continent';
import { parseChunkKey } from '../core/iso';
import type { PublicCity } from '../net/publicCities';
import { sharedClockOffset, sharedNow } from '../sim/sharedClock';
import { loadOverview } from './startPicker';
import { UNIT_SPECS, VISION_CHUNKS, type UnitType } from '../sim/config/military';
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
  /** 다른 도시 영토를 새로 읽었을 때(자동 점령 막기). */
  onForeign?: (owned: Set<string>) => void;
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
  private cities: PublicCity[] = [];
  private scale = 1;
  private fitScale = 1;
  private ox = 0;
  private oy = 0;
  private refreshTimer: number | null = null;
  private selected: string | null = null;
  /** 고른 내 부대 id. */
  private selectedUnit: string | null = null;
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

  constructor(private source: ContinentMapSource) {
    this.root.id = 'continent-map';
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="cm-head">
        <b>대륙 지도</b>
        <span class="cm-status" role="status"></span>
        <div class="cm-war" hidden>
          <span class="cm-war-text"></span>
          <button type="button" class="cm-war-surrender">항복 신청</button>
          <button type="button" class="cm-war-accept" hidden>항복 받아들이기</button>
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
              <button type="button" data-war="small">소규모 전쟁 선포 (준비 5분)</button>
              <button type="button" data-war="surprise">기습 (준비 없이)</button>
              <button type="button" data-war="large">대규모 전쟁 선포</button>
              <div class="cm-declare-msg" role="status"></div>
            </div>
          </div>
          <div class="cm-pane" data-pane="army" hidden>
            <div class="cm-army-info cm-legend"></div>
            <div class="cm-recruit"></div>
            <div class="cm-army-msg" role="status"></div>
            <ol class="cm-units"></ol>
          </div>
        </aside>
      </div>`;
    this.root.querySelector('.cm-map')!.append(this.canvas);
    this.list = this.root.querySelector('.cm-list')!;
    this.status = this.root.querySelector('.cm-status')!;
    this.unitsEl = this.root.querySelector('.cm-units')!;
    this.recruitEl = this.root.querySelector('.cm-recruit')!;
    this.armyInfoEl = this.root.querySelector('.cm-army-info')!;
    this.armyMsgEl = this.root.querySelector('.cm-army-msg')!;
    this.warEl = this.root.querySelector('.cm-war')!;
    this.declareEl = this.root.querySelector('.cm-declare')!;
    this.incomingEl = this.root.querySelector('.cm-incoming')!;
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
      if (war.status().surrenderPending) void war.withdrawSurrender();
      else void war.offerSurrender();
    });
    this.root.querySelector('.cm-war-accept')!.addEventListener('click', () => {
      void this.source.war?.acceptSurrender();
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
      if (this.source.alliances && this.source.alliances.revision !== this.allyRev) {
        this.allyRev = this.source.alliances.revision;
        this.renderIncoming();
        this.renderDeclare();
        this.renderList();
      }
      this.draw();
      this.frame = window.setTimeout(() => requestAnimationFrame(loop), 120);
    };
    loop();
    await this.refresh();
    if (this.refreshTimer === null)
      this.refreshTimer = window.setInterval(() => void this.refresh(), 60_000);
  }

  /** 위쪽 전쟁 줄: 상대·단계·남은 시간·점수, 항복 버튼. */
  private renderWar(): void {
    const war = this.source.war;
    const st = war?.status();
    if (!war || !st || st.phase === 'none' || st.phase === 'ended') {
      this.warEl.hidden = true;
      return;
    }
    this.warEl.hidden = false;
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
      (st.allies.length ? ` · 우리 진영: ${st.allies.join(', ')}` : '');
    const surrender = this.warEl.querySelector<HTMLButtonElement>('.cm-war-surrender')!;
    // 항복 신청·철회는 진영 대표만.
    surrender.hidden = !st.isLeader;
    surrender.textContent = st.surrenderPending ? '항복 철회' : '항복 신청';
    const accept = this.warEl.querySelector<HTMLButtonElement>('.cm-war-accept')!;
    accept.hidden = !st.surrenderOffered;
    accept.textContent = st.allies.length ? '항복에 동의(대표 동의 또는 2/3)' : '항복 받아들이기';
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
  private renderIncoming(): void {
    const al = this.source.alliances;
    const list = al?.incoming() ?? [];
    this.incomingEl.hidden = !list.length;
    this.incomingEl.innerHTML = '';
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
      li.className = 'cm-unit' + (u.id === this.selectedUnit ? ' selected' : '');
      li.innerHTML = `<span class="cm-unit-badge"></span><span class="cm-unit-text"></span>
        <span class="cm-bar"><i class="org"></i></span>
        <button type="button" class="cm-disband" title="해산: 남은 인원이 인구로 돌아갑니다">해산</button>`;
      li.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.cm-disband')) return;
        this.selectedUnit = u.id === this.selectedUnit ? null : u.id;
        if (this.selectedUnit) this.focusUnit(u);
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
      (u.path.length ? ` · ${u.path.length}청크 남음` : '');
    (li.querySelector('.cm-bar i') as HTMLElement).style.width = `${Math.round(u.org)}%`;
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
        this.cities = [mine, ...others];
        // 평시에는 남의 영토로 부대를 보낼 수 없다.
        const foreign = new Set<string>();
        for (const c of others) for (const k of c.owned) foreign.add(k);
        this.source.army.foreignOwned = foreign;
        this.source.onForeign?.(foreign);
        const online = this.cities.filter((c) => c.online).length;
        const clock = sharedClockOffset();
        this.status.textContent =
          `도시 ${this.cities.length}곳 · 접속 중 ${online}곳` +
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
    const { cx, cy } = parseChunkKey(c.capital);
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
    if (this.overview) {
      ctx.imageSmoothingEnabled = this.scale < 1.5;
      ctx.drawImage(this.overview, this.ox, this.oy, mw, mh);
    }
    const X = (cx: number) => this.ox + (cx - CONTINENT_X0) * s;
    const Y = (cy: number) => this.oy + (cy - CONTINENT_Y0) * s;
    const mineUid = this.source.mine().uid;
    for (const c of this.cities) {
      const owned = new Set(c.owned);
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
      const cap = parseChunkKey(c.capital);
      const span = [2, 4, 6][c.capitalLevel - 1];
      ctx.strokeStyle = '#1b1408';
      ctx.lineWidth = 3;
      ctx.strokeRect(X(cap.cx), Y(cap.cy), span * s, span * s);
      ctx.strokeStyle = '#f2cf7a';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(X(cap.cx), Y(cap.cy), span * s, span * s);
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
    const drawUnit = (u: Unit, mine: boolean) => {
      const p = unitPosition(u);
      const x = X(p.x - 0.5) + s / 2;
      const y = Y(p.y - 0.5) + s / 2;
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
      ctx.strokeStyle = mine && u.id === this.selectedUnit ? '#f2cf7a' : '#0d1418';
      ctx.lineWidth = mine && u.id === this.selectedUnit ? 3 : 1.5;
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
    };
    for (const u of army.units) drawUnit(u, true);
    if (war) {
      // 적 부대는 내 부대·영토에서 시야(2청크), 레이더(6청크) 안에 있을 때만 보인다.
      const radar = army.visionSources();
      const seeing = (e: Unit) => {
        for (const u of army.units)
          if (
            u.state !== 'training' &&
            Math.max(Math.abs(u.cx - e.cx), Math.abs(u.cy - e.cy)) <= VISION_CHUNKS
          )
            return true;
        for (let dy = -VISION_CHUNKS; dy <= VISION_CHUNKS; dy++)
          for (let dx = -VISION_CHUNKS; dx <= VISION_CHUNKS; dx++)
            if (this.source.army.mySide().owned.has(`${e.cx + dx},${e.cy + dy}`)) return true;
        for (const r of radar)
          if (Math.max(Math.abs(r.cx - e.cx), Math.abs(r.cy - e.cy)) <= r.r) return true;
        return false;
      };
      for (const e of war.enemy.units) if (e.state !== 'training' && seeing(e)) drawUnit(e, false);
    }
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
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 1) {
        downAt = local(e);
        dragged = false;
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
