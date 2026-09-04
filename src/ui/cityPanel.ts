import type { MacroSim } from '../sim/macro';
import {
  LEVEL_COUNT,
  TIER_NAMES,
  ZONE_C,
  ZONE_I,
  ZONE_NAMES,
  ZONE_R,
} from '../sim/buildings';
import { TICKS_PER_DAY } from '../sim/simConstants';

/**
 * 학생이 보는 도시 상태판.
 *
 * HUD(디버그 표시)와 따로 둔다. HUD 는 fps·청크 같은 개발용 숫자고, 이쪽은
 * 돈·인구·수요처럼 게임을 하는 데 필요한 정보만 담는다.
 *
 * 갱신 비용을 낮추려고 두 가지를 지킨다.
 *   1) 250ms 에 한 번만 다시 그린다. 매크로 틱이 1초에 한 번이라 더 자주 그릴
 *      이유가 없다.
 *   2) 수요 막대는 CSS 변수로 폭만 바꾼다. DOM 을 새로 만들지 않는다.
 */
export class CityPanel {
  private root: HTMLElement;
  private moneyEl: HTMLElement;
  private popEl: HTMLElement;
  private dateEl: HTMLElement;
  private occupancyEl: HTMLElement;
  private occupancyFillEl: HTMLElement;
  private noteEl: HTMLElement;
  private bars: HTMLElement[][] = [];
  private lastPaint = 0;

  constructor(selector = '#city-panel') {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`도시 상태판을 찾을 수 없습니다: ${selector}`);
    this.root = el;
    this.root.innerHTML = template();

    this.moneyEl = must(el, '.cp-money');
    this.popEl = must(el, '.cp-pop');
    this.dateEl = must(el, '.cp-date');
    this.occupancyEl = must(el, '.cp-occupancy-value');
    this.occupancyFillEl = must(el, '.cp-occupancy-fill');
    this.noteEl = must(el, '.cp-note');

    for (let z = 0; z < 3; z++) {
      const row: HTMLElement[] = [];
      for (let t = 0; t < LEVEL_COUNT; t++) {
        row.push(must(el, `.cp-bar[data-z="${z}"][data-t="${t}"] i`));
      }
      this.bars.push(row);
    }
  }

  update(now: number, sim: MacroSim): void {
    if (now - this.lastPaint < 250) return;
    this.lastPaint = now;

    this.moneyEl.textContent = formatMoney(sim.money);
    this.moneyEl.classList.toggle('broke', sim.money <= 0);
    this.popEl.textContent = Math.round(sim.stats.population).toLocaleString('ko-KR');

    const occupancy = Math.max(0, Math.min(1, sim.stats.occupancy));
    const vacancy = 1 - occupancy;
    this.occupancyEl.textContent = `${Math.round(vacancy * 100)}%`;
    this.occupancyFillEl.style.width = `${Math.round(occupancy * 100)}%`;
    this.occupancyFillEl.classList.toggle('warning', occupancy < 0.75);
    this.occupancyFillEl.classList.toggle('critical', occupancy < 0.5);

    const day = sim.day;
    const hour = sim.tick % TICKS_PER_DAY;
    this.dateEl.textContent = `${day}일차 ${String(hour).padStart(2, '0')}시`;

    for (let z = 0; z < 3; z++) {
      for (let t = 0; t < LEVEL_COUNT; t++) {
        const v = sim.demand[z][t];
        const bar = this.bars[z][t];
        // 왼쪽이 마이너스, 오른쪽이 플러스. 가운데가 0.
        const pct = Math.min(50, Math.abs(v) * 50);
        bar.style.width = `${pct}%`;
        bar.style.left = v >= 0 ? '50%' : `${50 - pct}%`;
        bar.classList.toggle('neg', v < 0);
      }
    }

    this.noteEl.textContent = describe(sim);
  }
}

function describe(sim: MacroSim): string {
  if (sim.catchupLeft > 0) {
    return `도시 변화를 계산하는 중… (${sim.catchupLeft}시간 남음)`;
  }
  if (sim.money <= 0) return '도시 자금이 부족해 새 건설이 멈췄습니다';
  if (sim.stats.buildings === 0) {
    return '도로 주변에 주거·상업·공업 지구를 지정해 보세요';
  }
  if (sim.stats.strandedBuildings > 0) {
    return `도로와 연결되지 않은 건물 ${sim.stats.strandedBuildings}채가 비어 있습니다`;
  }
  if (sim.stats.occupancy < 0.5) {
    return '공실이 많아 도시 성장이 느려졌습니다';
  }
  if (sim.stats.occupancy < 0.75) return '공실이 늘고 있습니다. 도로 연결을 확인하세요';
  return `건물 ${sim.stats.buildings}채 · 도시가 안정적으로 성장 중입니다`;
}

function formatMoney(v: number): string {
  const rounded = Math.round(v);
  return `${rounded < 0 ? '-' : ''}₩${Math.abs(rounded).toLocaleString('ko-KR')}`;
}

function must(root: HTMLElement, sel: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`도시 상태판 요소가 없습니다: ${sel}`);
  return el;
}

function template(): string {
  const zones = [ZONE_R, ZONE_C, ZONE_I];
  const rows = zones
    .map((z) => {
      const cells = Array.from({ length: LEVEL_COUNT }, (_, t) => {
        return `<div class="cp-bar" data-z="${z}" data-t="${t}" title="${ZONE_NAMES[z]} · ${TIER_NAMES[t]}"><i></i></div>`;
      }).join('');
      return `<div class="cp-row cp-z${z}"><span>${ZONE_NAMES[z]}</span><div class="cp-bars">${cells}</div></div>`;
    })
    .join('');

  return `
    <div class="cp-top">
      <div class="cp-label">도시 자금</div>
      <div class="cp-money">₩0</div>
      <div class="cp-meta">
        <span>인구 <b class="cp-pop">0</b>명</span>
        <span class="cp-date">0일차 00시</span>
      </div>
    </div>
    <div class="cp-occupancy">
      <div class="cp-occupancy-head"><span>공실률</span><b class="cp-occupancy-value">100%</b></div>
      <div class="cp-occupancy-track" aria-hidden="true"><i class="cp-occupancy-fill"></i></div>
      <div class="cp-occupancy-scale"><span>공실 많음</span><span>입주 안정</span></div>
    </div>
    <div class="cp-demand">
      <div class="cp-section-title">건물 수요</div>
      <div class="cp-legend"><span>저소득</span><span>중산층</span><span>고소득</span></div>
      ${rows}
    </div>
    <div class="cp-note"></div>
  `;
}
