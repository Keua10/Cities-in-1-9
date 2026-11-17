import type { PublicCity } from '../../net/publicCities';
import {
  AIRLIFT_COST,
  AIRLIFT_RANGE_CHUNKS,
  expRank,
  UNIT_SPECS,
  type UnitType,
} from '../../sim/config/military';
import type { Unit } from '../../sim/military/army';
import {
  airspace,
  bound,
  INCIDENT_COOLDOWN_MS,
  PASS_RULE_NAMES,
  passValid,
  territorialSea,
  type PassRule,
} from '../../sim/military/waters';
import { FACILITY_SPECS } from '../../sim/facilities';
import { formatMoney } from '../money';
import type { ContinentMapSource } from '../continentMap';
import { button, row } from './diplomacyPanel';
import { STATE_TEXT, UNIT_LETTER, type MapSelection } from './shared';

/** 길게 누르기로 보는 시간(ms). 지도와 목록이 같은 값을 쓴다. */
export const LONG_PRESS_MS = 450;

export interface ArmyPanelHost {
  /** 군대 칸이 보이는가. */
  visible: () => boolean;
  /** 다른 도시들(무단 진입 찾기). */
  cities: () => readonly PublicCity[];
  /** 지도를 다시 그린다. */
  draw: () => void;
  /** 그 부대로 지도를 옮긴다. */
  focusUnit: (u: Unit) => void;
}

/**
 * 군대 칸: 영해·영공 규율, 무단 진입 알림, 모집 버튼, 부대 목록(고르기·길게 눌러 여러 개·
 * 합치기·나누기·공중 수송·해산).
 */
export class ArmyPanel {
  private unitsEl: HTMLElement;
  private recruitEl: HTMLElement;
  private infoEl: HTMLElement;
  private msgEl: HTMLElement;
  private pickEl: HTMLElement;
  private trespassEl: HTMLElement;
  private lastRevision = -1;
  private trespassSig = '';
  private space = { sig: '', sea: new Set<string>(), air: new Set<string>() };

  constructor(
    root: HTMLElement,
    private source: ContinentMapSource,
    private sel: MapSelection,
    private host: ArmyPanelHost,
  ) {
    this.unitsEl = root.querySelector('.cm-units')!;
    this.recruitEl = root.querySelector('.cm-recruit')!;
    this.infoEl = root.querySelector('.cm-army-info')!;
    this.msgEl = root.querySelector('.cm-army-msg')!;
    this.pickEl = root.querySelector('.cm-pick')!;
    this.trespassEl = root.querySelector('.cm-trespass')!;
    this.bindPick();
    this.bindPassRule(root);
    for (const type of Object.keys(UNIT_SPECS) as UnitType[]) {
      const spec = UNIT_SPECS[type];
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.unit = type;
      b.innerHTML = `<b>${spec.name} 모집</b><small></small>`;
      b.addEventListener('click', () => {
        const why = this.source.army.recruit(type);
        this.say(
          why ||
            `${spec.name} 모집 · ${Math.round(spec.buildSec / 60)}분 뒤 출동 (${FACILITY_SPECS[spec.facility].name})`,
        );
        this.render(true);
      });
      this.recruitEl.append(b);
    }
  }

  /** 군대 칸 아래 한 줄 알림. */
  say(text: string): void {
    this.msgEl.textContent = text;
  }

  private bindPick(): void {
    const army = this.source.army;
    this.pickEl.querySelector('.cm-pick-merge')!.addEventListener('click', () => {
      const ids = this.pickedIds();
      const why = army.merge(ids);
      this.say(why || '부대를 합쳤습니다');
      if (!why) {
        this.sel.unit = ids[0];
        this.sel.picked.clear();
      }
      this.refresh();
    });
    this.pickEl.querySelector('.cm-pick-split')!.addEventListener('click', () => {
      const id = this.pickedIds()[0];
      if (!id) return;
      const r = army.split(id);
      this.say(typeof r === 'string' ? r : '부대를 둘로 나눴습니다');
      if (typeof r !== 'string') {
        this.sel.picked = new Set([id, r.id]);
        this.sel.unit = null;
      }
      this.refresh();
    });
    this.pickEl.querySelector('.cm-pick-clear')!.addEventListener('click', () => {
      this.sel.picked.clear();
      this.refresh();
    });
  }

  private bindPassRule(root: HTMLElement): void {
    const label = root.querySelector<HTMLElement>('.cm-pass-rule')!;
    const select = label.querySelector('select')!;
    select.value = this.source.passRule?.() ?? 'open';
    label.hidden = !this.source.setPassRule;
    select.addEventListener('change', () => {
      this.source.setPassRule?.(select.value as PassRule);
      this.source.announce(`영해·영공: ${PASS_RULE_NAMES[select.value as PassRule]}`);
    });
  }

  /** 지금 고른 부대들(길게 눌러 고른 것 + 눌러 고른 것). */
  pickedIds(): string[] {
    const live = new Set(this.source.army.units.map((u) => u.id));
    const out = [...this.sel.picked].filter((id) => live.has(id));
    if (this.sel.unit && live.has(this.sel.unit) && !out.includes(this.sel.unit))
      out.unshift(this.sel.unit);
    return out;
  }

  /** 길게 누르기: 여러 부대 고르기에 넣거나 뺀다. */
  togglePick(id: string): void {
    const { picked } = this.sel;
    if (picked.has(id)) picked.delete(id);
    else picked.add(id);
    if (this.sel.unit && !picked.has(this.sel.unit)) {
      picked.add(this.sel.unit);
      this.sel.unit = null;
    }
    this.refresh();
  }

  /** 목록을 처음부터 다시 그리고 지도도 다시 그린다. */
  refresh(): void {
    this.lastRevision = -1;
    this.render(true);
    this.renderPick();
    this.host.draw();
  }

  private renderPick(): void {
    const ids = this.pickedIds();
    const many = this.sel.picked.size > 0;
    this.pickEl.hidden = !many;
    if (!many) return;
    this.pickEl.querySelector('.cm-pick-text')!.textContent = `${ids.length}개 선택`;
    this.pickEl.querySelector<HTMLButtonElement>('.cm-pick-merge')!.disabled = ids.length < 2;
    this.pickEl.querySelector<HTMLButtonElement>('.cm-pick-split')!.disabled = ids.length !== 1;
  }

  /** 모집 버튼 상태, 부대 목록. force 가 아니면 바뀐 게 있을 때만 목록을 다시 만든다. */
  render(force: boolean): void {
    const army = this.source.army;
    if (!force && army.revision === this.lastRevision && !this.host.visible()) return;
    const units = army.units;
    this.infoEl.textContent =
      `병영 ${army.barracks().length}곳 · 부대 ${units.length}개 · 병력 ${Math.round(army.soldiers).toLocaleString('ko-KR')}명 · 더 뽑을 수 있는 인원 ${army.draftRoom().toLocaleString('ko-KR')}명` +
      ` · 유지비 ${formatMoney(army.upkeepMoney)}/일` +
      '\n부대를 누르고 지도에서 갈 곳을 누르세요. 적 땅 부대가 없는 적 청크에 1분 머물면 점령합니다(땅 부대만).' +
      (army.missiles().length
        ? `\n미사일 ${army.missiles().length}발 · 미사일을 누르고 적 땅을 누르면 발사(60청크)`
        : '');
    this.renderRecruit();
    if (!force && army.revision === this.lastRevision) {
      // 진행 막대만 고친다.
      for (const li of this.unitsEl.querySelectorAll<HTMLElement>('li[data-id]')) {
        const u = units.find((x) => x.id === li.dataset.id);
        if (u) fillUnitRow(li, u);
      }
      return;
    }
    this.lastRevision = army.revision;
    this.unitsEl.innerHTML = '';
    if (!units.length) {
      const li = document.createElement('li');
      li.className = 'cm-empty';
      li.textContent = '부대가 없습니다. 내 영토에 병영을 짓고 위에서 모집하세요.';
      this.unitsEl.append(li);
    }
    for (const u of units) this.unitsEl.append(this.unitRow(u));
  }

  private renderRecruit(): void {
    const army = this.source.army;
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
  }

  /** 부대 한 줄: 누르면 고르기, 길게 누르면 여러 개 고르기, ✈·해산 버튼. */
  private unitRow(u: Unit): HTMLLIElement {
    const army = this.source.army;
    const li = document.createElement('li');
    li.dataset.id = u.id;
    li.className =
      'cm-unit' +
      (u.id === this.sel.unit ? ' selected' : '') +
      (this.sel.picked.has(u.id) ? ' picked' : '');
    let pressTimer = 0;
    let pressed = false;
    li.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      pressed = false;
      pressTimer = window.setTimeout(() => {
        pressed = true;
        this.togglePick(u.id);
      }, LONG_PRESS_MS);
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
      if (this.sel.picked.size) {
        this.togglePick(u.id);
        return;
      }
      this.sel.unit = u.id === this.sel.unit ? null : u.id;
      if (this.sel.unit) this.host.focusUnit(u);
      this.lastRevision = -1;
      this.render(true);
      this.host.draw();
    });
    const fly = li.querySelector<HTMLButtonElement>('.cm-airlift')!;
    fly.hidden =
      UNIT_SPECS[u.type].domain !== 'ground' ||
      u.state === 'training' ||
      !!u.airlift ||
      !army.airportAt(u.cx, u.cy);
    fly.addEventListener('click', () => {
      this.sel.unit = u.id;
      this.sel.airlift = true;
      this.say(
        `✈ 공중 수송: 내릴 내 땅을 지도에서 누르세요 (${formatMoney(AIRLIFT_COST)}, ${AIRLIFT_RANGE_CHUNKS}청크 안)`,
      );
      this.lastRevision = -1;
      this.render(true);
      this.host.draw();
    });
    li.querySelector('.cm-disband')!.addEventListener('click', () => {
      if (u.state === 'fighting') {
        this.say('전투 중인 부대는 해산할 수 없습니다');
        return;
      }
      army.disband(u.id);
      if (this.sel.unit === u.id) this.sel.unit = null;
      this.say(`${UNIT_SPECS[u.type].name} 부대를 해산했습니다 · 인원이 도시로 돌아갑니다`);
      this.render(true);
    });
    fillUnitRow(li, u);
    return li;
  }

  /** 내 영해·영공에 규율을 어기고 들어온 다른 나라 군함·군용기(전쟁 없이 공격 가능). */
  renderTrespass(): void {
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
    for (const c of this.host.cities()) {
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
    for (const f of found)
      this.trespassEl.append(
        row(
          `⚠ ${f.name} ${UNIT_SPECS[f.t].name} 무단 진입 (${f.cx},${f.cy})`,
          button('공격', async () => {
            const power = this.source.army.incidentPower(f.cx, f.cy);
            const why = await ps.attack(f.uid, `${f.cx},${f.cy}`, power, INCIDENT_COOLDOWN_MS);
            this.say(why || '공격했습니다');
          }),
        ),
      );
  }
}

/** 부대 줄의 글자·조직력 막대만 고친다(1초마다). */
function fillUnitRow(li: HTMLElement, u: Unit): void {
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
