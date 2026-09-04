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
  /** 메모리에 남아 있는 필지 수. 지형 청크와 따로 센다. */
  parcels: number;
}

/** 개발용 상태 표시. 학생용 UI 는 2단계에서 따로 만든다. */
export class Hud {
  private el: HTMLElement;
  private lastPaint = 0;

  constructor(selector = '#hud') {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`HUD 컨테이너를 찾을 수 없습니다: ${selector}`);
    this.el = el;
  }

  update(now: number, data: HudData): void {
    if (now - this.lastPaint < 200) return;
    this.lastPaint = now;

    const tile = data.tile ? `${data.tile.tx}, ${data.tile.ty}` : '—';
    const chunk = data.chunk ? `${data.chunk.cx}, ${data.chunk.cy}` : '—';
    const terrain =
      data.terrain === null ? '—' : (TERRAIN_KEYS[data.terrain] ?? String(data.terrain));

    const build =
      data.build === null || data.build === undefined
        ? '—'
        : (BUILD_LABELS[data.build] ?? '빈 땅');

    const lines = [
      `<b>${data.fps.toFixed(0)} fps</b>   확대 ${data.zoom.toFixed(2)}x`,
      `도시 ID ${data.city}`,
      `선택 도구 ${data.tool}`,
      `타일 좌표 ${tile}`,
      `청크 ${chunk}   지형 종류 ${terrain}`,
      `고도 ${data.height === null ? '—' : data.height}`,
      `시설 ${build}${data.roadAccess === null ? '' : data.roadAccess ? '   도로 연결' : '   도로 미연결'}`,
      `건물 ${data.building ?? '—'}`,
      `화면 청크 ${data.visibleChunks}   메시 ${data.loadedMeshes}   필지 ${data.parcels}`,
      `화면 건물 ${data.visibleBuildings}`,
    ];
    if (data.placeholderArt) lines.push('그림: 임시 타일 사용 중');
    if (data.message) lines.push(`<b class="warn">${data.message}</b>`);

    this.el.innerHTML = lines.join('\n');
  }
}
