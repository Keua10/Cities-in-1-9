import { CONTINENT_H, CONTINENT_W, CONTINENT_X0, CONTINENT_Y0 } from '../world/continent';
import { parseChunkKey } from '../core/iso';
import type { PublicCity } from '../net/publicCities';
import { sharedClockOffset, sharedNow } from '../sim/sharedClock';
import { loadOverview } from './startPicker';
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
}

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

  constructor(private source: ContinentMapSource) {
    this.root.id = 'continent-map';
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="cm-head">
        <b>대륙 지도</b>
        <span class="cm-status" role="status"></span>
        <button type="button" class="cm-close" aria-label="대륙 지도 닫기">×</button>
      </header>
      <div class="cm-body">
        <div class="cm-map"></div>
        <aside class="cm-side">
          <div class="cm-legend">금색 테두리 = 수도 · ● 접속 중 · 전쟁은 양쪽이 접속해 있어야 합니다</div>
          <ol class="cm-list"></ol>
        </aside>
      </div>`;
    this.root.querySelector('.cm-map')!.append(this.canvas);
    this.list = this.root.querySelector('.cm-list')!;
    this.status = this.root.querySelector('.cm-status')!;
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
    await this.refresh();
    if (this.refreshTimer === null)
      this.refreshTimer = window.setInterval(() => void this.refresh(), 60_000);
  }

  close(): void {
    this.root.hidden = true;
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
        `${c.cityName}${c.uid === mineUid ? ' (내 도시)' : ''}`;
      li.querySelector('.cm-meta')!.textContent =
        `${dot} ${c.uid === mineUid ? '접속 중' : c.online ? '접속 중' : ago(c.lastSeen)} · Lv.${c.cityLevel} · 인구 ${Math.round(c.population).toLocaleString('ko-KR')} · 영토 ${c.owned.length}청크 · 수도 Lv.${c.capitalLevel}`;
      li.addEventListener('click', () => {
        this.selected = c.uid;
        this.focus(c);
        this.renderList();
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
  }

  /* ---------------- 입력 ---------------- */

  private bindPointer(): void {
    const c = this.canvas;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 2) {
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
        this.ox += p.x - prev.x;
        this.oy += p.y - prev.y;
        this.clampPan();
      }
      this.draw();
    });
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
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
