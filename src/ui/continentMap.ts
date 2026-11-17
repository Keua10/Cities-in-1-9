import type { PassSession } from '../net/passes';
import type { PassRule } from '../sim/military/waters';
import { parseChunkKey } from '../core/iso';
import type { PublicCity } from '../net/publicCities';
import { sharedClockOffset, sharedNow } from '../sim/sharedClock';
import { loadOverview } from './startPicker';
import { unitPosition, type Unit } from '../sim/military/army';
import type { ArmySystem } from '../sim/military/armySystem';
import type { WarSession } from '../net/warSession';
import type { AllianceSession } from '../net/alliances';
import { MapView } from './continent/mapView';
import { makeBlurred, paintCities, paintGround, paintLabels } from './continent/groundPaint';
import { EdgeAlerts, shakeOffset } from './continent/edgeAlerts';
import { UnitPainter } from './continent/unitPaint';
import { paintEffects } from './continent/effectPaint';
import { paintSky } from './continent/skyPaint';
import { WarBar } from './continent/warBar';
import { DiplomacyPanel } from './continent/diplomacyPanel';
import { ArmyPanel, LONG_PRESS_MS } from './continent/armyPanel';
import { ago, cityColor, type MapSelection } from './continent/shared';
import './continentMap.css';

/**
 * 대륙 지도: 모든 도시의 영토·수도·레벨·접속, 전쟁 지휘(부대 이동·점령·미사일), 외교.
 *
 * 이 파일은 화면 틀·갱신 주기·도시 목록·지도 입력만 맡는다. 나머지는 continent/ 아래:
 *   mapView        확대·이동, 청크 ↔ 화면 좌표
 *   groundPaint    지형(아는 곳만 선명)·영토·수도·이름표
 *   unitPaint      점령지·부대(보간 이동·전투·진행 고리)
 *   effectPaint    미사일·폭발·요격·점령 깃발·교전 섬광
 *   skyPaint       밤·날씨
 *   edgeAlerts     화면 밖 공격 화살표, 내 땅 피격 흔들림
 *   warBar         위쪽 전쟁 줄(항복·휴전)
 *   diplomacyPanel 동맹·통과·선전포고·대규모 전쟁 참가
 *   armyPanel      모집·부대 목록·영해 규율·무단 진입
 *
 * 내 도시는 지금 화면의 최신 영토로 그린다(공개 문서는 저장할 때만 바뀌므로).
 */

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

/** 움직이는 것이 있을 때 / 없을 때 다음 프레임까지(ms). */
const FRAME_MS_ACTIVE = 16;
const FRAME_MS_IDLE = 120;
const REFRESH_MS = 60_000;

export class ContinentMap {
  private root = document.createElement('div');
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private view = new MapView(this.canvas);
  private list: HTMLElement;
  private status: HTMLElement;
  private overview: HTMLImageElement | null = null;
  private blurred: HTMLCanvasElement | null = null;
  private units = new UnitPainter();
  private alerts = new EdgeAlerts();
  /** 이번 프레임에 움직이는 것(부대 이동·전투·효과·날씨)이 있었는가. */
  private animating = false;
  /** 아직 못 찾은 도시 수. */
  private hiddenCount = 0;
  private cities: PublicCity[] = [];
  private refreshTimer: number | null = null;
  private sel: MapSelection = { city: null, unit: null, picked: new Set(), airlift: false };
  private tab: 'cities' | 'army' = 'cities';
  private frame = 0;
  private openWarsRev = -1;
  private allyRev = -1;
  private passRev = -1;
  private warBar: WarBar;
  private diplomacy: DiplomacyPanel;
  private armyPanel: ArmyPanel;

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
    this.warBar = new WarBar(
      this.root.querySelector('.cm-war')!,
      () => this.source.war,
      () => this.source.mine().capital,
      source.announce,
    );
    this.diplomacy = new DiplomacyPanel(
      this.root,
      source,
      this.sel,
      () => this.cities,
      () => this.warBar.render(),
    );
    this.armyPanel = new ArmyPanel(this.root, source, this.sel, {
      visible: () => this.tab === 'army',
      cities: () => this.cities,
      draw: () => this.draw(),
      focusUnit: (u) => this.focusUnit(u),
    });
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.cm-tabs button'))
      b.addEventListener('click', () => this.setTab(b.dataset.tab as 'cities' | 'army'));
    this.root.querySelector('.cm-close')!.addEventListener('click', () => this.close());
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    document.body.append(this.root);
    this.bindPointer();
    window.addEventListener('resize', () => {
      if (!this.root.hidden) {
        this.view.fit();
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
    this.view.fit();
    const mine = this.source.mine();
    this.cities = [mine];
    this.sel.city = mine.uid;
    this.focus(mine);
    this.renderList();
    this.draw();
    this.armyPanel.render(true);
    const loop = () => {
      if (this.root.hidden) return;
      this.tick();
      this.draw();
      this.frame = window.setTimeout(
        () => requestAnimationFrame(loop),
        this.animating ? FRAME_MS_ACTIVE : FRAME_MS_IDLE,
      );
    };
    loop();
    await this.refresh();
    if (this.refreshTimer === null)
      this.refreshTimer = window.setInterval(() => void this.refresh(), REFRESH_MS);
  }

  /** 프레임마다: 바뀐 것이 있는 칸만 다시 그린다. */
  private tick(): void {
    this.armyPanel.render(false);
    this.warBar.render();
    const { war, passes, alliances } = this.source;
    if (war && war.revision !== this.openWarsRev) {
      this.openWarsRev = war.revision;
      this.diplomacy.renderOpenWars();
    }
    if (passes && passes.revision !== this.passRev) {
      this.passRev = passes.revision;
      this.diplomacy.renderIncoming();
      this.diplomacy.renderDeclare();
    }
    this.armyPanel.renderTrespass();
    if (alliances && alliances.revision !== this.allyRev) {
      this.allyRev = alliances.revision;
      this.diplomacy.renderIncoming();
      this.diplomacy.renderDeclare();
      this.renderList();
    }
  }

  private setTab(tab: 'cities' | 'army'): void {
    this.tab = tab;
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.cm-tabs button'))
      b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
    for (const p of this.root.querySelectorAll<HTMLElement>('.cm-pane'))
      p.hidden = p.dataset.pane !== tab;
    if (tab === 'army') this.armyPanel.render(true);
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

  private renderList(): void {
    this.list.innerHTML = '';
    const mineUid = this.source.mine().uid;
    for (const c of this.cities) {
      const li = document.createElement('li');
      li.className = 'cm-city' + (c.uid === this.sel.city ? ' selected' : '');
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
        this.sel.city = c.uid;
        this.focus(c);
        this.renderList();
        this.diplomacy.renderDeclare();
        this.draw();
      });
      this.list.append(li);
    }
  }

  /* ---------------- 시점 ---------------- */

  /** 도시가 화면 가운데 오게, 적당히 확대해서. 모르는 수도면 아는 영토 한 칸으로. */
  private focus(c: PublicCity): void {
    const known = this.knownSet();
    const anchor =
      !known || c.uid === this.source.mine().uid || known.has(c.capital)
        ? c.capital
        : (c.owned.find((k) => known.has(k)) ?? this.source.mine().capital);
    const { cx, cy } = parseChunkKey(anchor);
    this.view.centerOn(cx + 1, cy + 1, 3);
  }

  private focusUnit(u: Unit): void {
    const p = unitPosition(u);
    this.view.centerOn(p.x, p.y, 5, true);
  }

  /* ---------------- 그리기 ---------------- */

  /**
   * 그리는 순서(효과가 서로 묻히지 않게):
   * 땅·영토 → 밤·날씨 → 점령지·부대 → 효과 → 이름표 → 화면 밖 화살표.
   * 내 땅에 폭발이 떨어진 직후에는 화살표를 뺀 전부가 살짝 흔들린다.
   */
  private draw(): void {
    const ctx = this.ctx;
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const army = this.source.army;
    const now = performance.now();
    // 내 땅 목록은 만들 때 비용이 있어 효과나 전쟁이 있을 때만 읽는다.
    const owned: ReadonlySet<string> =
      army.effects.length || army.war ? army.mySide().owned : new Set<string>();
    const shake = shakeOffset(army.effects, owned, now);
    ctx.save();
    ctx.translate(shake.x, shake.y);
    const known = this.knownSet();
    if (known && this.overview && !this.blurred) this.blurred = makeBlurred(this.overview);
    paintGround(ctx, this.view, this.overview, this.blurred, known);
    const labels = paintCities(ctx, this.view, this.cities, {
      mineUid: this.source.mine().uid,
      selected: this.sel.city,
      known,
      atWarWith: (uid) => !!this.source.war?.atWarWith(uid),
    });
    const sky = paintSky(ctx, this.view, known, now);
    const moving = this.units.paint(ctx, this.view, army, this.sel, now);
    const fx = paintEffects(ctx, this.view, army.effects, now);
    paintLabels(ctx, labels, this.units.hits);
    ctx.restore();
    this.alerts.update(army, owned, now);
    const arrows = this.alerts.paint(ctx, this.view, now);
    this.animating = moving || fx || sky || arrows || shake.x !== 0;
  }

  /* ---------------- 입력 ---------------- */

  /**
   * 화면 좌표 근처의 내 부대(지난 프레임에 그린 표 기준).
   * 여러 부대가 묶인 표를 다시 누르면 다음 부대로 넘어간다.
   */
  private unitAt(px: number, py: number): Unit | null {
    let best: { ids: string[] } | null = null;
    let bd = Infinity;
    for (const h of this.units.hits) {
      if (!h.ids.length) continue;
      const d = Math.hypot(px - h.x, py - h.y);
      if (d < Math.max(9, h.r * 1.15) && d < bd) {
        bd = d;
        best = h;
      }
    }
    if (!best) return null;
    const at = this.sel.unit ? best.ids.indexOf(this.sel.unit) : -1;
    const id = at >= 0 && best.ids.length > 1 ? best.ids[(at + 1) % best.ids.length] : best.ids[0];
    return this.source.army.units.find((u) => u.id === id) ?? null;
  }

  private tapAt(px: number, py: number): void {
    const army = this.source.army;
    const panel = this.armyPanel;
    const arrow = this.alerts.hitAt(px, py);
    if (arrow) {
      this.view.centerOn(arrow.cx + 0.5, arrow.cy + 0.5, 5, true);
      this.draw();
      return;
    }
    const hit = this.unitAt(px, py);
    if (hit && this.sel.picked.size) {
      panel.togglePick(hit.id);
      this.setTab('army');
      return;
    }
    const { cx, cy } = this.view.chunkAt(px, py);
    if (!hit && this.sel.picked.size && !this.sel.airlift) {
      // 여러 부대에 한꺼번에 이동 명령.
      let ok = 0;
      let why = '';
      for (const id of panel.pickedIds()) {
        const r = army.order(id, cx, cy);
        if (r) why = r;
        else ok++;
      }
      panel.say(
        ok ? `${ok}개 부대에 이동 명령을 내렸습니다${why ? ` · 못 간 부대: ${why}` : ''}` : why,
      );
      panel.refresh();
      return;
    }
    if (hit) {
      // 묶음이면 unitAt 이 다음 부대를 준다. 한 부대짜리를 다시 누르면 고르기 해제.
      this.sel.unit = hit.id === this.sel.unit ? null : hit.id;
      this.setTab('army');
      panel.refresh();
      return;
    }
    if (!this.sel.unit) return;
    if (this.sel.airlift) {
      this.sel.airlift = false;
      const why = army.airlift(this.sel.unit, cx, cy);
      panel.say(why || '✈ 이륙! 잠시 뒤 내립니다');
      if (why) this.source.announce(why);
      panel.render(true);
      this.draw();
      return;
    }
    const missile = army.units.find((u) => u.id === this.sel.unit)?.type === 'missile';
    const why = army.order(this.sel.unit, cx, cy);
    if (missile && !why) this.sel.unit = null;
    panel.say(why || (missile ? '미사일 발사!' : '이동 명령을 내렸습니다'));
    if (why) this.source.announce(why);
    panel.render(true);
    this.draw();
  }

  /** 끌기 = 이동, 두 손가락·휠 = 확대, 누르기 = tapAt, 부대 길게 누르기 = 여러 개 고르기. */
  private bindPointer(): void {
    const c = this.canvas;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    let downAt: { x: number; y: number } | null = null;
    let dragged = false;
    let pressTimer = 0;
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
        const at = downAt;
        clearTimeout(pressTimer);
        pressTimer = window.setTimeout(() => {
          if (dragged || pointers.size !== 1) return;
          const hit = this.unitAt(at.x, at.y);
          if (!hit) return;
          dragged = true; // 손을 떼도 탭으로 처리하지 않는다.
          this.armyPanel.togglePick(hit.id);
          this.setTab('army');
        }, LONG_PRESS_MS);
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
        if (pinch > 0) this.view.zoomAt(d / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = d;
      } else {
        if (downAt && !dragged && Math.hypot(p.x - downAt.x, p.y - downAt.y) > 6) dragged = true;
        if (!dragged) return;
        this.view.pan(p.x - prev.x, p.y - prev.y);
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
        this.view.zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
        this.draw();
      },
      { passive: false },
    );
  }
}
