import { BASE_CHUNK_SPAN } from '../core/constants';
import { CONTINENT_H, CONTINENT_W, CONTINENT_X0, CONTINENT_Y0 } from '../world/continent';
import {
  canStartAt,
  centerDistance,
  ChunkStatTable,
  siteSummary,
  SITE_FAR,
  SITE_NEAR,
  spacingBlock,
  type Origin,
  type SiteSummary,
} from '../world/sites';
import './startPicker.css';

/**
 * 시작 지점 선택 화면 (Warnament 방식).
 *
 * 대륙 전체 지도에서 4×4 청크 시작 영토(가운데 2×2 가 수도)를 고른다. 초록 칸은 지금 고를 수 있는
 * 곳, 어두운 칸은 다른 도시와 가까워 막힌 곳이다. **누구의 도시인지는 보여주지
 * 않는다.** 한 번 정한 자리는 바꿀 수 없으므로 두 번 눌러야 확정된다.
 */

/** 미리 만든 대륙 자료 (tools/map/buildContinentMap.ts). */
const MAP_BIN = '/maps/continent-v3.bin';
const MAP_PNG = '/maps/continent-v3.png';
/** 미리보기 지도 1청크 = 2픽셀 (16칸/픽셀). */
const PX_PER_CHUNK = 2;
const SPAN = BASE_CHUNK_SPAN;
const HALF = SPAN / 2;
const ORIGINS_W = CONTINENT_W - BASE_CHUNK_SPAN + 1;
const ORIGINS_H = CONTINENT_H - BASE_CHUNK_SPAN + 1;

const enum Spacing {
  Pending = 0,
  Ok = 1,
  Blocked = 2,
}

export interface StartPickerOptions {
  /** 이미 자리를 잡은 도시들. */
  claimed: Origin[];
  /** 서버에 저장되지 않는 둘러보기인가. */
  offline: boolean;
  /**
   * 자리를 확정한다. 실패하면 화면에 보여줄 이유를 돌려주고, 최신 자리 목록이
   * 있으면 함께 돌려준다. 성공하면 빈 문자열.
   */
  confirm(origin: Origin): Promise<{ error: string; claimed?: Origin[] }>;
}

export async function loadContinentTable(): Promise<ChunkStatTable> {
  const res = await fetch(MAP_BIN);
  if (!res.ok) throw new Error(`대륙 자료를 받지 못했습니다 (${res.status})`);
  return new ChunkStatTable(new Uint8Array(await res.arrayBuffer()));
}

async function loadOverview(): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = MAP_PNG;
  await img.decode();
  return img;
}

export async function pickStartOrigin(options: StartPickerOptions): Promise<Origin> {
  const [table, overview] = await Promise.all([loadContinentTable(), loadOverview()]);
  return new StartPicker(table, overview, options).result;
}

class StartPicker {
  readonly result: Promise<Origin>;
  private resolve!: (o: Origin) => void;

  private root = document.createElement('div');
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private overlay = document.createElement('canvas');
  private info = document.createElement('div');
  private button = document.createElement('button');
  private status = document.createElement('p');

  private terrainOk = new Uint8Array(ORIGINS_W * ORIGINS_H);
  private spacing = new Uint8Array(ORIGINS_W * ORIGINS_H);
  private pending: number[] = [];
  private claimed: Origin[];

  private scale = 1;
  private ox = 0;
  private oy = 0;
  private fitScale = 1;
  private selected: Origin | null = null;
  private hover: Origin | null = null;
  private armed = false;
  private busy = false;
  private raf = 0;

  constructor(
    private table: ChunkStatTable,
    private overview: HTMLImageElement,
    private options: StartPickerOptions,
  ) {
    this.result = new Promise((r) => (this.resolve = r));
    this.claimed = options.claimed.slice();
    this.ctx = this.canvas.getContext('2d')!;
    this.overlay.width = CONTINENT_W;
    this.overlay.height = CONTINENT_H;
    this.build();
    this.computeTerrain();
    this.computeSpacing();
    this.fit();
    this.paintOverlay();
    this.draw();
  }

  /* ---------------- 화면 구성 ---------------- */

  private build(): void {
    const r = this.root;
    r.id = 'start-picker';
    r.innerHTML = `
      <header class="sp-head">
        <h1>시작할 땅을 고르세요</h1>
        <p>초록색 칸만 고를 수 있습니다. 하천이 흐르고 평지가 넉넉한 4×4 청크(가운데 2×2 가 수도)입니다.
        산·큰 강·바다로 갈린 곳은 다른 도시 가까이에도 지을 수 있지만, 평지로 이어진
        곳은 멀리 떨어져야 합니다.</p>
      </header>
      <div class="sp-body">
        <div class="sp-map">
          <div class="sp-zoom">
            <button type="button" data-z="out" aria-label="축소">−</button>
            <button type="button" data-z="fit" aria-label="전체 보기">⤢</button>
            <button type="button" data-z="in" aria-label="확대">+</button>
          </div>
          <div class="sp-legend">
            <span><i class="ok"></i>고를 수 있음</span>
            <span><i class="blocked"></i>다른 도시 근처</span>
            <span><i class="sel"></i>고른 자리</span>
          </div>
        </div>
        <aside class="sp-side"></aside>
      </div>`;
    r.querySelector('.sp-map')!.prepend(this.canvas);
    const side = r.querySelector('.sp-side')!;
    this.info.className = 'sp-info';
    this.status.className = 'sp-status';
    this.button.type = 'button';
    this.button.className = 'login-btn primary sp-confirm';
    side.append(this.info, this.status, this.button);
    document.body.appendChild(r);

    for (const b of r.querySelectorAll<HTMLButtonElement>('.sp-zoom button')) {
      b.addEventListener('click', () => {
        const z = b.dataset.z;
        if (z === 'fit') this.fit();
        else
          this.zoomAt(
            z === 'in' ? 1.6 : 1 / 1.6,
            this.canvas.clientWidth / 2,
            this.canvas.clientHeight / 2,
          );
        this.draw();
      });
    }
    this.button.addEventListener('click', () => void this.onConfirm());
    this.bindPointer();
    window.addEventListener('resize', this.onResize);
    this.renderInfo();
  }

  private onResize = (): void => {
    this.fit();
    this.draw();
  };

  private close(origin: Origin): void {
    window.removeEventListener('resize', this.onResize);
    cancelAnimationFrame(this.raf);
    this.root.remove();
    this.resolve(origin);
  }

  /* ---------------- 자리 판정 ---------------- */

  private idx(o: Origin): number {
    return (o.cy - CONTINENT_Y0) * ORIGINS_W + (o.cx - CONTINENT_X0);
  }

  private originAt(i: number): Origin {
    return { cx: CONTINENT_X0 + (i % ORIGINS_W), cy: CONTINENT_Y0 + Math.floor(i / ORIGINS_W) };
  }

  private computeTerrain(): void {
    for (let i = 0; i < this.terrainOk.length; i++)
      this.terrainOk[i] = siteSummary(this.originAt(i), this.table).ok ? 1 : 0;
  }

  /**
   * 간격 판정. 가까운 도시가 없으면 바로 통과, 너무 가까우면 바로 막는다.
   * 그 사이(장애물 검사가 필요한 곳)는 선을 따라 지형을 읽어야 해서 느리므로
   * 화면을 멈추지 않게 프레임마다 조금씩 나눠 처리한다.
   */
  private computeSpacing(): void {
    this.pending = [];
    for (let i = 0; i < this.spacing.length; i++) {
      if (!this.terrainOk[i]) {
        this.spacing[i] = Spacing.Ok;
        continue;
      }
      const o = this.originAt(i);
      let state = Spacing.Ok;
      for (const c of this.claimed) {
        const d = centerDistance(o, c);
        if (d < SITE_NEAR) {
          state = Spacing.Blocked;
          break;
        }
        if (d < SITE_FAR) state = Spacing.Pending;
      }
      this.spacing[i] = state;
      if (state === Spacing.Pending) this.pending.push(i);
    }
    this.pumpSpacing();
  }

  private pumpSpacing = (): void => {
    const until = performance.now() + 10;
    let changed = false;
    while (this.pending.length && performance.now() < until) {
      const i = this.pending.pop()!;
      this.spacing[i] = spacingBlock(this.originAt(i), this.claimed) ? Spacing.Blocked : Spacing.Ok;
      changed = true;
    }
    if (changed) {
      this.paintOverlay();
      this.draw();
    }
    if (this.pending.length) this.raf = requestAnimationFrame(this.pumpSpacing);
  };

  /** 칸마다 초록(고를 수 있는 자리에 속함) / 어두움(막힌 자리에만 속함). */
  private paintOverlay(): void {
    const ctx = this.overlay.getContext('2d')!;
    const img = ctx.createImageData(CONTINENT_W, CONTINENT_H);
    for (let y = 0; y < CONTINENT_H; y++) {
      for (let x = 0; x < CONTINENT_W; x++) {
        let ok = false;
        let blocked = false;
        for (let dy = 1 - SPAN; dy <= 0; dy++)
          for (let dx = 1 - SPAN; dx <= 0; dx++) {
            const ox = x + dx;
            const oy = y + dy;
            if (ox < 0 || oy < 0 || ox >= ORIGINS_W || oy >= ORIGINS_H) continue;
            const i = oy * ORIGINS_W + ox;
            if (!this.terrainOk[i]) continue;
            if (this.spacing[i] === Spacing.Ok) ok = true;
            else if (this.spacing[i] === Spacing.Blocked) blocked = true;
          }
        const p = (y * CONTINENT_W + x) * 4;
        if (ok) img.data.set([70, 214, 150, 78], p);
        else if (blocked) img.data.set([6, 10, 13, 170], p);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /** 누른 칸을 포함하는 네 자리 중 고를 수 있고 누른 곳에 가장 가까운 자리. */
  private originNear(fx: number, fy: number): Origin {
    const cx = Math.floor(fx);
    const cy = Math.floor(fy);
    let best: Origin | null = null;
    let bestScore = Infinity;
    for (let dy = 1 - SPAN; dy <= 0; dy++)
      for (let dx = 1 - SPAN; dx <= 0; dx++) {
        const o = { cx: cx + dx, cy: cy + dy };
        const ix = o.cx - CONTINENT_X0;
        const iy = o.cy - CONTINENT_Y0;
        if (ix < 0 || iy < 0 || ix >= ORIGINS_W || iy >= ORIGINS_H) continue;
        const i = this.idx(o);
        const rank = !this.terrainOk[i] ? 2 : this.spacing[i] === Spacing.Blocked ? 1 : 0;
        const dist = Math.hypot(o.cx + HALF - fx, o.cy + HALF - fy);
        const score = rank * 100 + dist;
        if (score < bestScore) {
          bestScore = score;
          best = o;
        }
      }
    return best ?? { cx, cy };
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
    this.scale = this.fitScale;
    this.ox = (w - mw * this.scale) / 2;
    this.oy = (h - mh * this.scale) / 2;
  }

  private zoomAt(factor: number, px: number, py: number): void {
    const next = Math.min(10, Math.max(this.fitScale, this.scale * factor));
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

  private toChunk(px: number, py: number): [number, number] {
    const s = this.scale * PX_PER_CHUNK;
    return [CONTINENT_X0 + (px - this.ox) / s, CONTINENT_Y0 + (py - this.oy) / s];
  }

  private draw(): void {
    const ctx = this.ctx;
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#122a38';
    ctx.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    const mw = CONTINENT_W * PX_PER_CHUNK * this.scale;
    const mh = CONTINENT_H * PX_PER_CHUNK * this.scale;
    ctx.imageSmoothingEnabled = this.scale < 1.5;
    ctx.drawImage(this.overview, this.ox, this.oy, mw, mh);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.overlay, this.ox, this.oy, mw, mh);
    const s = this.scale * PX_PER_CHUNK;
    const frame = (o: Origin, color: string, width: number) => {
      const x = this.ox + (o.cx - CONTINENT_X0) * s;
      const y = this.oy + (o.cy - CONTINENT_Y0) * s;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.strokeRect(x, y, s * SPAN, s * SPAN);
      // 가운데 2×2 = 수도
      ctx.lineWidth = 1;
      ctx.strokeRect(x + s * (HALF - 1), y + s * (HALF - 1), s * 2, s * 2);
    };
    if (this.hover && !sameOrigin(this.hover, this.selected))
      frame(this.hover, 'rgba(255,255,255,0.7)', 1);
    if (this.selected) {
      frame(this.selected, '#1b1408', 4);
      frame(this.selected, '#f2cf7a', 2);
    }
  }

  /* ---------------- 입력 ---------------- */

  private bindPointer(): void {
    const c = this.canvas;
    const pointers = new Map<number, { x: number; y: number }>();
    let downAt: { x: number; y: number } | null = null;
    let dragged = false;
    let pinch = 0;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pointers.size === 1) {
        downAt = p;
        dragged = false;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
        dragged = true;
      }
    });
    c.addEventListener('pointermove', (e) => {
      const p = local(e);
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        const [fx, fy] = this.toChunk(p.x, p.y);
        const h = this.originNear(fx, fy);
        if (!sameOrigin(h, this.hover)) {
          this.hover = h;
          this.draw();
        }
        return;
      }
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) this.zoomAt(d / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = d;
        this.draw();
        return;
      }
      if (downAt && !dragged && Math.hypot(p.x - downAt.x, p.y - downAt.y) > 6) dragged = true;
      if (dragged) {
        this.ox += p.x - prev.x;
        this.oy += p.y - prev.y;
        this.clampPan();
        this.draw();
      }
    });
    const up = (e: PointerEvent) => {
      const p = local(e);
      pointers.delete(e.pointerId);
      if (pointers.size === 0 && !dragged && downAt) {
        const [fx, fy] = this.toChunk(p.x, p.y);
        this.select(this.originNear(fx, fy));
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

  private select(o: Origin): void {
    this.selected = o;
    this.armed = false;
    this.status.textContent = '';
    this.renderInfo();
    this.draw();
  }

  /* ---------------- 정보와 확정 ---------------- */

  private evaluate(): { ok: boolean; reason: string; summary: SiteSummary } | null {
    return this.selected ? canStartAt(this.selected, this.claimed, this.table) : null;
  }

  private renderInfo(): void {
    const v = this.evaluate();
    if (!v || !this.selected) {
      this.info.innerHTML = `<h2>자리를 고르세요</h2>
        <p class="sp-hint">지도에서 초록색 칸을 누르면 그 땅의 모습이 여기에 나옵니다.
        끌어서 움직이고, 두 손가락이나 휠로 확대합니다.</p>`;
      this.button.textContent = '여기서 시작';
      this.button.disabled = true;
      return;
    }
    const s = v.summary;
    const fert = s.fertility >= 85 ? '높음' : s.fertility >= 65 ? '보통' : '낮음';
    const water = s.bigRiver ? '큰 강이 흐름' : s.river ? '개울이 흐름' : '없음';
    this.info.innerHTML = `
      <h2>${regionName(this.selected)}</h2>
      <dl class="sp-facts">
        <div><dt>평지</dt><dd>${s.flatPct}%</dd></div>
        <div><dt>산</dt><dd>${s.mountainPct}%</dd></div>
        <div><dt>물</dt><dd>${s.waterPct}%</dd></div>
        <div><dt>하천</dt><dd>${water}</dd></div>
        <div><dt>바다</dt><dd>${s.coast ? '해안에 닿음' : '내륙'}</dd></div>
        <div><dt>농사</dt><dd>비옥도 ${fert} (${s.fertility}%)</dd></div>
      </dl>
      ${v.ok ? '<p class="sp-ok">이 땅에서 시작할 수 있습니다.</p>' : `<p class="sp-bad">${v.reason}</p>`}`;
    this.button.disabled = !v.ok || this.busy;
    this.button.textContent = this.armed ? '정말 여기서 시작할까요? (바꿀 수 없음)' : '여기서 시작';
    this.button.classList.toggle('armed', this.armed);
  }

  private async onConfirm(): Promise<void> {
    const v = this.evaluate();
    if (!v?.ok || !this.selected || this.busy) return;
    if (!this.armed) {
      this.armed = true;
      this.status.textContent = this.options.offline
        ? '둘러보기에서는 저장되지 않습니다.'
        : '한 번 정한 자리는 바꿀 수 없습니다. 한 번 더 누르면 확정됩니다.';
      this.renderInfo();
      return;
    }
    this.busy = true;
    this.button.disabled = true;
    this.status.textContent = '자리를 확정하는 중…';
    const origin = this.selected;
    try {
      const { error, claimed } = await this.options.confirm(origin);
      if (!error) {
        this.close(origin);
        return;
      }
      this.status.textContent = error;
      if (claimed) {
        this.claimed = claimed;
        this.computeSpacing();
        this.paintOverlay();
        this.draw();
      }
    } catch (err) {
      console.error(err);
      this.status.textContent = '저장하지 못했습니다. 인터넷 연결을 확인하고 다시 눌러 주세요.';
    } finally {
      this.busy = false;
      this.armed = false;
      this.renderInfo();
    }
  }
}

function sameOrigin(a: Origin | null, b: Origin | null): boolean {
  return !!a && !!b && a.cx === b.cx && a.cy === b.cy;
}

/** "대륙 북서부" 처럼 대략의 위치. 좌표 숫자는 학생에게 의미가 없다. */
function regionName(o: Origin): string {
  const fx = (o.cx + HALF - CONTINENT_X0) / CONTINENT_W;
  const fy = (o.cy + HALF - CONTINENT_Y0) / CONTINENT_H;
  const ns = fy < 0.36 ? '북' : fy > 0.64 ? '남' : '';
  const ew = fx < 0.36 ? '서' : fx > 0.64 ? '동' : '';
  return ns || ew ? `대륙 ${ns}${ew}부` : '대륙 중부';
}
