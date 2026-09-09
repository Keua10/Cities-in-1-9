import { LEVEL_COUNT, TIER_NAMES, ZONE_C, ZONE_I, ZONE_NAMES, ZONE_R } from '../sim/buildings';
import type { MacroSim } from '../sim/macro';
import { BUILDING_UNLOCK_LEVEL, CITY_LEVELS } from '../sim/progression';
import { SERVICE_KIND_COUNT } from '../sim/services';
import { FACILITY_NAMES, TICKS_PER_DAY } from '../sim/simConstants';

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
  onIncidentFocus: (() => void) | null = null;
  private safetyEl: HTMLElement;
  private safetyNoteEl: HTMLElement;
  private incidentButton: HTMLButtonElement;
  private root: HTMLElement;
  private moneyEl: HTMLElement;
  private levelEl: HTMLElement;
  private prosperityEl: HTMLElement;
  private unlockEl: HTMLElement;
  private waterEl: HTMLElement;
  private popEl: HTMLElement;
  private dateEl: HTMLElement;
  private occupancyEl: HTMLElement;
  private occupancyFillEl: HTMLElement;
  private noteEl: HTMLElement;
  private bars: HTMLElement[][] = [];
  /** 3.3단계: kind 0~3 커버율 게이지. */
  private serviceFills: HTMLElement[] = [];
  private serviceValues: HTMLElement[] = [];
  /** 복지 충족률 게이지. 커버율과 **같은 무게** 로 보여준다. */
  private amenityFillEl: HTMLElement;
  private amenityValueEl: HTMLElement;
  private facilityNoteEl: HTMLElement;
  private lastPaint = 0;

  constructor(selector = '#city-panel') {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`도시 상태판을 찾을 수 없습니다: ${selector}`);
    this.root = el;
    this.root.innerHTML = template();
    this.safetyEl = must(el, '.cp-safety-counts');
    this.safetyNoteEl = must(el, '.cp-safety-note');
    this.incidentButton = must(el, '.cp-incident-focus') as HTMLButtonElement;
    this.incidentButton.addEventListener('click', () => this.onIncidentFocus?.());

    this.moneyEl = must(el, '.cp-money');
    this.levelEl = must(el, '.cp-city-level');
    this.prosperityEl = must(el, '.cp-prosperity');
    this.unlockEl = must(el, '.cp-unlock');
    this.waterEl = must(el, '.cp-water');
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

    for (let kind = 0; kind < SERVICE_KIND_COUNT; kind++) {
      this.serviceFills.push(must(el, `.cp-svc[data-kind="${kind}"] .cp-gauge-fill`));
      this.serviceValues.push(must(el, `.cp-svc[data-kind="${kind}"] .cp-gauge-value`));
    }
    this.amenityFillEl = must(el, '.cp-amenity .cp-gauge-fill');
    this.amenityValueEl = must(el, '.cp-amenity .cp-gauge-value');
    this.facilityNoteEl = must(el, '.cp-facility-note');
  }

  update(now: number, sim: MacroSim): void {
    if (now - this.lastPaint < 250) return;
    this.lastPaint = now;

    setText(this.moneyEl, formatMoney(sim.money));
    this.moneyEl.classList.toggle('broke', sim.money <= 0);
    setText(this.popEl, Math.round(sim.stats.population).toLocaleString('ko-KR'));
    const milestone = CITY_LEVELS[sim.cityLevel - 1];
    const next = CITY_LEVELS[sim.cityLevel];
    setText(this.levelEl, `도시 Lv.${sim.cityLevel} · ${milestone.name}`);
    setText(
      this.prosperityEl,
      next
        ? `번영도 ${sim.prosperity.toLocaleString('ko-KR')} / ${next.points.toLocaleString('ko-KR')}`
        : `번영도 ${sim.prosperity.toLocaleString('ko-KR')} · 최고 레벨`,
    );
    setText(this.unlockEl, next ? `다음: ${next.unlock}` : '현재 모든 건물·시설 잠금해제');

    const occupancy = Math.max(0, Math.min(1, sim.stats.occupancy));
    const vacancy = 1 - occupancy;
    setText(this.occupancyEl, `${Math.round(vacancy * 100)}%`);
    this.occupancyFillEl.style.width = `${Math.round(occupancy * 100)}%`;
    this.occupancyFillEl.classList.toggle('warning', occupancy < 0.75);
    this.occupancyFillEl.classList.toggle('critical', occupancy < 0.5);

    const day = sim.day;
    const hour = sim.tick % TICKS_PER_DAY;
    setText(this.dateEl, `${day}일차 ${String(hour).padStart(2, '0')}시`);

    for (let z = 0; z < 3; z++) {
      for (let t = 0; t < LEVEL_COUNT; t++) {
        const v = sim.demand[z][t];
        const bar = this.bars[z][t];
        const locked = t >= sim.maxBuildingTier;
        bar.parentElement!.classList.toggle('locked', locked);
        bar.parentElement!.title = locked
          ? `도시 레벨 ${BUILDING_UNLOCK_LEVEL[t]}에서 잠금해제`
          : `${TIER_NAMES[t]} 수요`;
        // 왼쪽이 마이너스, 오른쪽이 플러스. 가운데가 0.
        const pct = Math.min(50, Math.abs(v) * 50);
        bar.style.width = `${pct}%`;
        bar.style.left = v >= 0 ? '50%' : `${50 - pct}%`;
        bar.classList.toggle('neg', v < 0);
      }
    }

    for (let kind = 0; kind < SERVICE_KIND_COUNT; kind++) {
      const v = Math.max(0, Math.min(1, sim.stats.serviceCoverage[kind] ?? 0));
      this.serviceFills[kind].style.width = `${Math.round(v * 100)}%`;
      this.serviceFills[kind].classList.toggle('warning', v < 0.7);
      this.serviceFills[kind].classList.toggle('critical', v < 0.4);
      setText(this.serviceValues[kind], `${Math.round(v * 100)}%`);
    }

    const amenity = Math.max(0, Math.min(1, sim.stats.amenityFulfilled));
    this.amenityFillEl.style.width = `${Math.round(amenity * 100)}%`;
    this.amenityFillEl.classList.toggle('warning', amenity < 0.7);
    this.amenityFillEl.classList.toggle('critical', amenity < 0.4);
    setText(this.amenityValueEl, `${Math.round(amenity * 100)}%`);

    setText(this.facilityNoteEl, describeFacilities(sim));
    const water = sim.water.summary;
    setText(
      this.waterEl,
      `급수 ${Math.round(water.supply * 100)}% · 하수 ${Math.round(water.drainage * 100)}%\n` +
        `연결 용량: 급수 ${water.waterCapacity.toLocaleString('ko-KR')} / 하수 ${water.sewerCapacity.toLocaleString('ko-KR')} · 도시 수요 ${Math.round(water.demand).toLocaleString('ko-KR')}\n` +
        (water.contaminatedBuildings
          ? `오염된 물을 받는 건물 ${water.contaminatedBuildings}채 · 빨간 배관을 분리하세요`
          : '상·하수도관은 한 칸 이상 띄워 설치하세요') +
        (sim.waterGraceDaysLeft > 0 ? `\n부족 감점 유예 ${sim.waterGraceDaysLeft}일 남음` : ''),
    );
    this.updateSafety(sim);
    setText(this.noteEl, describe(sim));
  }

  private updateSafety(sim: MacroSim): void {
    const [fires, crimes, illnesses] = sim.disasters.counts;
    setText(this.safetyEl, `화재 ${fires} · 범죄 ${crimes} · 질병 ${illnesses}`);
    this.safetyEl.classList.toggle('active', fires + crimes + illnesses > 0);
    this.incidentButton.disabled = fires + crimes + illnesses === 0;
    this.safetyNoteEl.textContent =
      fires > 0
        ? '화재 건물은 비어 있습니다. 소방서의 도로 연결과 과부하를 확인하세요.'
        : crimes + illnesses > 0
          ? '범죄·질병으로 입주가 줄었습니다. 경찰서·병원 품질이 높을수록 빨리 회복합니다.'
          : '진행 중인 사건이 없습니다. 소방서·경찰서·병원이 사고를 줄입니다.';
    if (sim.disasters.burned || sim.disasters.extinguished) {
      this.safetyNoteEl.textContent += ` 누적 진압 ${sim.disasters.extinguished} · 전소 ${sim.disasters.burned}채`;
    }
  }
}

/**
 * 시설 안내 문구. 학생이 읽는 문장이다.
 *
 * 마지막 줄이 중요하다. 복지 부족은 **미달이 계층마다 다르게 나타나서** 학생이
 * 원인을 짚기 어렵다. 저소득 동네는 멀쩡한데 같은 자리에 고급 아파트가 안
 * 들어서는 상황이 정상 동작이기 때문이다. 상태판이 계층을 짚어주지 않으면
 * 학생은 그걸 버그로 읽는다.
 */
function describeFacilities(sim: MacroSim): string {
  const s = sim.stats;
  if (s.buildings === 0) return '';

  if (s.deadFacilities > 0) {
    return `도로에 닿지 않은 시설이 ${s.deadFacilities}개 있습니다`;
  }

  // 가장 부족한 필수 서비스를 하나만 짚는다. 넷을 한꺼번에 늘어놓으면 안 읽힌다.
  let worst = -1;
  for (let kind = 0; kind < SERVICE_KIND_COUNT; kind++) {
    const v = s.serviceCoverage[kind] ?? 0;
    if (v >= 0.7) continue;
    if (worst < 0 || v < (s.serviceCoverage[worst] ?? 0)) worst = kind;
  }
  if (worst >= 0) {
    const pct = Math.round((s.serviceCoverage[worst] ?? 0) * 100);
    return `${FACILITY_NAMES[worst]}이(가) 부족합니다 (커버 ${pct}%)`;
  }

  if (s.overloadedFacilities > 0) {
    return `담당 정원을 넘긴 시설이 ${s.overloadedFacilities}개 있습니다`;
  }

  if (s.amenityFulfilled < 0.75) {
    const short = Math.round((1 - s.amenityFulfilled) * 100);
    if (s.facilityCounts[5] === 0 && s.facilityCounts[6] === 0) {
      return '중산층 이상은 소공원만으로 부족합니다. 공원을 지어 보세요';
    }
    return `공원이 부족합니다 (주민의 ${short}%가 부족한 동네에 삽니다)`;
  }

  return '';
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
  const gauges = gaugeRows();

  return `
    <div class="cp-top">
      <div class="cp-label">도시 자금</div>
      <div class="cp-money">₩0</div>
      <div class="cp-meta">
        <span>인구 <b class="cp-pop">0</b>명</span>
        <span class="cp-date">0일차 00시</span>
      </div>
    </div>
    <div class="cp-progression">
      <b class="cp-city-level" role="status">도시 Lv.1 · 마을</b>
      <div class="cp-prosperity">번영도 0 / 100</div>
      <div class="cp-unlock"></div>
      <div class="cp-progression-help">인구·입주율·하루 수지에 따라 매일 누적</div>
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
    <div class="cp-services">
      <div class="cp-section-title">서비스 · 복지</div>
      ${gauges}
    </div>
    <div class="cp-facility-note"></div>
    <div class="cp-section-title">상하수도</div>
    <div class="cp-water"></div>
    <div class="cp-safety">
      <div class="cp-section-title">도시 안전 <button class="cp-incident-focus" type="button" disabled>사건 위치 보기</button></div>
      <div class="cp-safety-counts" role="status" aria-live="polite">화재 0 · 범죄 0 · 질병 0</div>
      <div class="cp-safety-note"></div>
    </div>
    <div class="cp-note"></div>
  `;
}

/**
 * 커버율 게이지 4개 + 복지 충족률 게이지 1개.
 *
 * **복지도 커버율과 같은 무게로 보여준다.** 게이지 하나가 덜 중요해 보이면 안 된다.
 */
function gaugeRows(): string {
  const services = Array.from({ length: SERVICE_KIND_COUNT }, (_, kind) => {
    return gaugeRow('cp-svc', FACILITY_NAMES[kind], `data-kind="${kind}"`);
  }).join('');
  // 요구를 채운 주거 건물 수 / 전체 주거 건물 수.
  return services + gaugeRow('cp-amenity', '공원·복지', '');
}

function gaugeRow(cls: string, label: string, attrs: string): string {
  return `
    <div class="cp-gauge ${cls}" ${attrs}>
      <span class="cp-gauge-label">${label}</span>
      <div class="cp-gauge-track" aria-hidden="true"><i class="cp-gauge-fill"></i></div>
      <b class="cp-gauge-value">0%</b>
    </div>
  `;
}

/** Skip unchanged text to avoid replacing DOM text nodes and repeating live announcements. */
function setText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}
