import { FACILITY_SPECS } from '../sim/facilities';
import type { MacroSim } from '../sim/macro';
import type { World } from '../world/world';

export interface FacilityLocation {
  tx: number;
  ty: number;
  kind: number;
  span: number;
}

/** Reuses service records, then checks live anchors so demolished facilities cannot be selected. */
export function findFacilities(world: World, sim: MacroSim, kind: number): FacilityLocation[] {
  return sim.services
    .facilityList()
    .filter((f) => f.kind === kind && world.buildingCovering(f.tx, f.ty)?.kind === kind)
    .map((f) => ({ tx: f.tx, ty: f.ty, kind, span: FACILITY_SPECS[kind].span }))
    .sort((a, b) => a.ty - b.ty || a.tx - b.tx);
}

export class FacilityFinder {
  private root = document.createElement('details');
  private select = document.createElement('select');
  private previous = document.createElement('button');
  private next = document.createElement('button');
  private status = document.createElement('p');
  private current: FacilityLocation | null = null;
  private lastPaint = -Infinity;
  constructor(
    private world: World,
    private sim: MacroSim,
    private focus: (f: FacilityLocation | null) => void,
  ) {
    this.root.className = 'facility-finder';
    const summary = document.createElement('summary');
    summary.textContent = '시설 찾기';
    this.select.setAttribute('aria-label', '찾을 시설 종류');
    for (const spec of FACILITY_SPECS) {
      const option = document.createElement('option');
      option.value = String(spec.kind);
      option.textContent = spec.name;
      this.select.append(option);
    }
    this.previous.textContent = '이전 위치';
    this.next.textContent = '다음 위치';
    this.previous.type = this.next.type = 'button';
    this.status.setAttribute('role', 'status');
    this.root.append(summary, this.select, this.previous, this.next, this.status);
    document.getElementById('hud')!.append(this.root);
    this.select.addEventListener('change', () => {
      this.current = null;
      this.move(1);
    });
    this.previous.addEventListener('click', () => this.move(-1));
    this.next.addEventListener('click', () => this.move(1));
    this.root.addEventListener('toggle', () => {
      if (!this.root.open) {
        this.current = null;
        this.focus(null);
      } else this.refresh();
    });
  }
  update(now: number): void {
    if (!this.root.open || now - this.lastPaint < 500) return;
    this.lastPaint = now;
    this.refresh();
  }
  private refresh(): void {
    const kind = Number(this.select.value),
      list = findFacilities(this.world, this.sim, kind);
    this.previous.disabled = this.next.disabled = list.length === 0;
    if (this.current && !list.some((f) => f.tx === this.current!.tx && f.ty === this.current!.ty)) {
      this.current = null;
      this.focus(null);
    }
    const i = this.current
      ? list.findIndex((f) => f.tx === this.current!.tx && f.ty === this.current!.ty)
      : -1;
    this.status.textContent =
      list.length === 0
        ? '이 시설은 아직 설치되지 않았습니다.'
        : `${FACILITY_SPECS[kind].name} ${list.length}곳${i < 0 ? ' · 다음 위치로 찾아보기' : ` · ${i + 1}/${list.length} · 좌표 ${this.current!.tx}, ${this.current!.ty}`}`;
    const counts = this.sim.services.countsByKind();
    for (const option of this.select.options)
      option.textContent = `${FACILITY_SPECS[Number(option.value)].name} (${counts[Number(option.value)] ?? 0})`;
  }
  private move(direction: number): void {
    const list = findFacilities(this.world, this.sim, Number(this.select.value));
    if (!list.length) {
      this.current = null;
      this.focus(null);
      this.refresh();
      return;
    }
    const current = this.current
      ? list.findIndex((f) => f.tx === this.current!.tx && f.ty === this.current!.ty)
      : -1;
    const i =
      current < 0
        ? direction > 0
          ? 0
          : list.length - 1
        : (current + direction + list.length) % list.length;
    this.current = list[i];
    this.focus(this.current);
    this.refresh();
  }
}
