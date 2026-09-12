import { BUILD_LABELS } from '../world/build';
import { TERRAIN_KEYS } from '../world/terrain';

export interface HudData {
  fps: number;
  zoom: number;
  tile: { tx: number; ty: number } | null;
  terrain: number | null;
  height: number | null;
  chunk: { cx: number; cy: number } | null;
  visibleChunks: number;
  loadedMeshes: number;
  placeholderArt: boolean;
  /** 지금 조종 중인 도시. 1단계에서 추가. */
  city: string;
  /* ---------- 2단계 ---------- */
  /** 지금 켜져 있는 도구 이름. */
  tool: string;
  /** 커서 칸에 지어진 것. 없으면 null. */
  build: number | null;
  /** 커서 칸이 도로에 접해 있는가. 지구가 아니면 null. */
  roadAccess: boolean | null;
  /** 배치가 거부됐을 때의 사유. 없으면 빈 문자열. */
  message: string;
  /* ---------- 3.1단계 ---------- */
  /** 커서 칸에 서 있는 건물 설명. 없으면 null. */
  building: string | null;
  /** 화면에 그려지고 있는 건물 수. */
  visibleBuildings: number;
  /* ---------- 3.3단계 ---------- */
  /** 커서 칸의 필수 서비스 상태. 커서가 없으면 null. */
  service: string | null;
  /** 커서 칸의 복지 상태. 점수와 계층별 요구량을 나란히 담는다. */
  amenity: string | null;
  incident: string | null;
  /** 화면에 그려지고 있는 시설 수. */
  visibleFacilities: number;
  /** 메모리에 남아 있는 필지 수. 지형 청크와 따로 센다. */
  parcels: number;
  /* ---------- 3.2단계 ---------- */
  activeVehicles: number;
  averageCongestion: number;
  daytimeHour: number;
  daytimeIsDay: boolean;
  sunriseHour: number;
  sunsetHour: number;
  season: string;
  weekday: string;
  gametimeDay: number;
  gametimeHour: number;
}

/** Compact player context with stable, keyboard-accessible diagnostic disclosure. */
export class Hud {
  private summary: HTMLElement;
  private context: HTMLElement;
  private debug: HTMLElement;
  private message: HTMLElement;
  private lastPaint = 0;

  constructor(selector = '#hud') {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`HUD 컨테이너를 찾을 수 없습니다: ${selector}`);
    el.innerHTML =
      '<div class="hud-summary"></div><div class="hud-context"></div><div class="hud-message" role="status"></div><details class="hud-diagnostics"><summary>진단 정보</summary><div class="hud-debug"></div></details>';
    this.summary = el.querySelector('.hud-summary')!;
    this.context = el.querySelector('.hud-context')!;
    this.debug = el.querySelector('.hud-debug')!;
    this.message = el.querySelector('.hud-message')!;
  }

  update(now: number, source: HudData | (() => HudData)): void {
    if (now - this.lastPaint < 200) return;
    this.lastPaint = now;
    const data = typeof source === 'function' ? source() : source;

    const tile = data.tile ? `${data.tile.tx}, ${data.tile.ty}` : '—';
    const chunk = data.chunk ? `${data.chunk.cx}, ${data.chunk.cy}` : '—';
    const terrain =
      data.terrain === null ? '—' : (TERRAIN_KEYS[data.terrain] ?? String(data.terrain));

    const build =
      data.build === null || data.build === undefined ? '—' : (BUILD_LABELS[data.build] ?? '빈 땅');

    this.summary.innerHTML = `<b>1–9 도시</b><span>${escapeHtml(data.weekday)}요일 · ${escapeHtml(data.season)} ${formatHour(data.daytimeHour)}</span><small>${escapeHtml(data.tool)} · 확대 ${Math.round(data.zoom * 100)}%</small>`;
    const context = [];
    if (data.building)
      context.push(
        `<b>${escapeHtml(data.building.split(' · ')[0])}</b>`,
        escapeHtml(data.building.split(' · ').slice(1).join(' · ')),
      );
    else if (data.tile)
      context.push(
        `<b>${escapeHtml(build)}</b>`,
        `고도 ${data.height ?? '—'}${data.roadAccess === null ? '' : data.roadAccess ? ' · 도로 연결' : ' · 도로 미연결'}`,
      );
    else
      context.push(
        '<span class="hud-hint">건물을 가리키거나 선택하면 상태를 볼 수 있습니다.</span>',
      );
    if (data.service && data.building) context.push(escapeHtml(data.service));
    if (data.amenity && data.building) context.push(escapeHtml(data.amenity));
    if (data.incident) context.push(`<strong class="warn">${escapeHtml(data.incident)}</strong>`);
    this.context.innerHTML = context
      .filter(Boolean)
      .map((s) => `<div>${s}</div>`)
      .join('');
    this.message.textContent = data.message ?? '';
    const lines = [
      `${data.fps.toFixed(0)} fps · 확대 ${data.zoom.toFixed(2)}x`,
      `도시 ID ${data.city}`,
      `선택 도구 ${data.tool}`,
      `타일 좌표 ${tile}`,
      `청크 ${chunk}   지형 종류 ${terrain}`,
      `고도 ${data.height === null ? '—' : data.height}`,
      `시설 ${build}${data.roadAccess === null ? '' : data.roadAccess ? '   도로 연결' : '   도로 미연결'}`,
      `건물 ${data.building ?? '—'}`,
      `필수 ${data.service ?? '—'}`,
      `복지 ${data.amenity ?? '—'}`,
      `사건 ${data.incident ?? '없음'}`,
      `화면 청크 ${data.visibleChunks}   메시 ${data.loadedMeshes}   필지 ${data.parcels}`,
      `화면 건물 ${data.visibleBuildings}   화면 시설 ${data.visibleFacilities}`,
      `차량 ${data.activeVehicles}   평균 혼잡 ${Math.round(data.averageCongestion * 100)}%`,
      `daytime ${data.weekday}요일 · ${data.season} ${formatHour(data.daytimeHour)} (${data.daytimeIsDay ? '낮' : '밤'})   일출 ${formatHour(data.sunriseHour)} / 일몰 ${formatHour(data.sunsetHour)}`,
      `gametime ${data.gametimeDay}일 ${String(data.gametimeHour).padStart(2, '0')}:00`,
    ];
    if (data.placeholderArt) lines.push('그림: 임시 타일 사용 중');
    this.debug.textContent = lines.join('\n');
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function formatHour(hour: number): string {
  const h = Math.floor(hour) % 24;
  const m = Math.floor((hour - Math.floor(hour)) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
