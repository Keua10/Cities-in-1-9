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

    const lines = [
      `<b>${data.fps.toFixed(0)} fps</b>   배율 ${data.zoom.toFixed(2)}x`,
      `타일 ${tile}`,
      `청크 ${chunk}   지형 ${terrain}`,
      `고도 ${data.height === null ? '—' : data.height}`,
      `화면 청크 ${data.visibleChunks}   메시 ${data.loadedMeshes}`,
    ];
    if (data.placeholderArt) lines.push('그림: 임시 타일 사용 중');

    this.el.innerHTML = lines.join('\n');
  }
}
