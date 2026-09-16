import { chunkIndexOf } from '../core/iso';
import type { MacroState } from '../net/types';
import { DIRS, Build } from '../world/build';
import type { World } from '../world/world';
import { canPlaceFacility } from './facilities';
import { facCode } from './buildings';

export const METRO_FACILITY = 26;
export const METRO_COLORS = [
  '#68b6ac',
  '#ce9960',
  '#a993c3',
  '#839dc2',
  '#b5b677',
  '#c77e84',
] as const;
export interface MetroLine {
  id: string;
  name: string;
  color: string;
  stops: string[];
}

export interface MetroState {
  /** Independent underground layer. Surface roads, buildings and utilities are untouched. */
  tunnels: Record<string, true>;
  stations: Record<string, { name: string; surface?: { x: number; y: number } }>;
  nextStation: number;
  lines?: MetroLine[];
  nextLine?: number;
}
export const METRO_TUNNEL_COST = 1200;
export const METRO_STATION_COST = 18000;
export const METRO_MAX_TILES = 10000;
export type MetroEdit = 'tunnel' | 'station' | 'erase';
const keyOf = (x: number, y: number) => `${x},${y}`;

export class MetroNetwork {
  revision = 0;
  private cachedRevision = -1;
  private components = new Map<string, number>();
  constructor(
    private world: World,
    private macro: MacroState,
    private changed: () => void,
  ) {}
  get state(): Readonly<MetroState> {
    return this.macro.metro ?? { tunnels: {}, stations: {}, nextStation: 1 };
  }
  get surfaceRevision(): number {
    return this.world.walkRevision;
  }
  canPlaceStation(x: number, y: number) {
    if (this.stationAtSurface(x, y))
      return {
        ok: false,
        reason: '기존 역 부지입니다. 지하철 보기에서 역을 복구하거나 철거하세요.',
      };
    return canPlaceFacility(this.world, x, y, METRO_FACILITY, 1);
  }
  stationAccess(key: string): boolean {
    const s = this.state.stations[key]?.surface;
    return (
      !!s &&
      this.world.getBld(s.x, s.y) === facCode(METRO_FACILITY) &&
      DIRS.some(([dx, dy]) => this.world.getBuild(s.x + dx, s.y + dy) === Build.Road)
    );
  }
  stationAtSurface(x: number, y: number): string | undefined {
    return Object.keys(this.state.stations).find((k) => {
      const s = this.state.stations[k].surface;
      return s?.x === x && s.y === y;
    });
  }
  repairSurface(key: string): { ok: boolean; message: string } {
    const station = this.state.stations[key];
    if (!station) return { ok: false, message: '역이 없습니다.' };
    if (this.stationAccess(key)) return { ok: true, message: '지상 역이 연결되어 있습니다.' };
    const existing = station.surface;
    if (existing && this.world.getBld(existing.x, existing.y) === facCode(METRO_FACILITY))
      return { ok: false, message: '기존 지상 역 옆에 도로를 연결하세요.' };
    const [x, y] = key.split(',').map(Number);
    const candidate = [[x, y], ...DIRS.map(([dx, dy]) => [x + dx, y + dy])].find(([a, b]) => {
      const owner = this.stationAtSurface(a, b);
      return (!owner || owner === key) && canPlaceFacility(this.world, a, b, METRO_FACILITY, 1).ok;
    });
    if (!candidate)
      return { ok: false, message: '역 칸 또는 바로 옆에 도로와 접한 빈 육지가 필요합니다.' };
    const [sx, sy] = candidate;
    this.world.placeFacility(sx, sy, METRO_FACILITY, 0);
    station.surface = { x: sx, y: sy };
    this.revision++;
    this.changed();
    return { ok: true, message: '기존 역의 지상 역 건물을 복구했습니다.' };
  }
  linePath(stops: readonly string[]): string[] | null {
    if (stops.length < 2 || stops.some((k) => !this.state.stations[k])) return null;
    const route: string[] = [];
    for (let i = 1; i < stops.length; i++) {
      const part = this.path(stops[i - 1], stops[i]);
      if (!part) return null;
      route.push(...(i === 1 ? part : part.slice(1)));
    }
    return route;
  }
  saveLine(
    id: string | null,
    name: string,
    color: string,
    stops: string[],
  ): { ok: boolean; message: string; id?: string } {
    const title = name.trim();
    if (!title || title.length > 24)
      return { ok: false, message: '노선 이름은 1~24자로 입력하세요.' };
    if (!(METRO_COLORS as readonly string[]).includes(color))
      return { ok: false, message: '목록에서 노선 색상을 선택하세요.' };
    if (stops.length < 2 || stops.length > 32 || new Set(stops).size !== stops.length)
      return { ok: false, message: '서로 다른 역 2~32개를 순서대로 지정하세요.' };
    if (stops.some((k) => !this.stationAccess(k)))
      return { ok: false, message: '모든 정차역에 지상 역과 진입 도로가 필요합니다.' };
    if (!this.linePath(stops)) return { ok: false, message: '정차역 사이의 터널이 끊겨 있습니다.' };
    const state = this.macro.metro!;
    const lines = (state.lines ??= []);
    if (id && !lines.some((l) => l.id === id))
      return { ok: false, message: '편집하던 노선이 삭제됐습니다.' };
    const lineId = id ?? `metro-${state.nextLine ?? 1}`;
    if (!id) {
      if (lines.length >= 32) return { ok: false, message: '최대 32개 노선까지 만들 수 있습니다.' };
      state.nextLine = (state.nextLine ?? 1) + 1;
    }
    const line = { id: lineId, name: title, color, stops: [...stops] };
    const index = lines.findIndex((l) => l.id === lineId);
    if (index < 0) lines.push(line);
    else lines[index] = line;
    this.revision++;
    this.changed();
    return {
      ok: true,
      message: '노선을 저장했습니다. 열차 운행은 다음 단계에 연결됩니다.',
      id: lineId,
    };
  }
  deleteLine(id: string): void {
    if (!this.macro.metro?.lines) return;
    this.macro.metro.lines = this.macro.metro.lines.filter((l) => l.id !== id);
    this.revision++;
    this.changed();
  }
  edit(x: number, y: number, action: MetroEdit): { ok: boolean; message: string } {
    if (
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(y) ||
      !this.world.isExplored(chunkIndexOf(x), chunkIndexOf(y))
    )
      return { ok: false, message: '개척한 지역에서만 지하철을 건설할 수 있습니다.' };
    const key = keyOf(x, y),
      state = this.state;
    if (action === 'erase') {
      if (!state.tunnels[key]) return { ok: true, message: '제거할 지하철 시설이 없습니다.' };
      delete state.tunnels[key];
      const surface = state.stations[key]?.surface;
      if (surface && this.world.getBld(surface.x, surface.y) === facCode(METRO_FACILITY))
        this.world.removeFacilityAt(surface.x, surface.y);
      delete state.stations[key];
      this.revision++;
      this.changed();
      return {
        ok: true,
        message: '해당 역 건물과 지하철 시설을 제거했습니다. 다른 지상 시설은 유지됩니다.',
      };
    }
    if (action === 'station' && !state.stations[key]) {
      const placement = this.canPlaceStation(x, y);
      if (!placement.ok) return { ok: false, message: placement.reason };
    }
    if (
      (action === 'tunnel' && state.tunnels[key]) ||
      (action === 'station' && state.stations[key])
    )
      return { ok: true, message: '이미 설치되어 있습니다.' };
    if (!state.tunnels[key] && Object.keys(state.tunnels).length >= METRO_MAX_TILES)
      return { ok: false, message: '이 도시의 지하철 건설 한도에 도달했습니다.' };
    const cost = action === 'station' ? METRO_STATION_COST : METRO_TUNNEL_COST;
    if (this.macro.money < cost) return { ok: false, message: '지하철 건설 자금이 부족합니다.' };
    const mutable = (this.macro.metro ??= { tunnels: {}, stations: {}, nextStation: 1 });
    mutable.tunnels[key] = true;
    if (action === 'station') {
      this.world.placeFacility(x, y, METRO_FACILITY, 0);
      mutable.stations[key] = { name: `지하철 ${mutable.nextStation++}역`, surface: { x, y } };
    }
    this.macro.money -= cost;
    this.revision++;
    this.changed();
    return {
      ok: true,
      message:
        action === 'station'
          ? '역 설치 · 별도 출입구는 필요 없습니다.'
          : '터널 연결 · 인접 터널과 자동 연결됩니다.',
    };
  }
  reset(): void {
    for (const station of Object.values(this.state.stations)) {
      const s = station.surface;
      if (s && this.world.getBld(s.x, s.y) === facCode(METRO_FACILITY))
        this.world.removeFacilityAt(s.x, s.y);
    }
    delete this.macro.metro;
    this.revision++;
    this.changed();
  }
  private rebuild(): void {
    if (this.cachedRevision === this.revision) return;
    this.cachedRevision = this.revision;
    this.components.clear();
    let id = 0;
    for (const key of Object.keys(this.state.tunnels)) {
      if (this.components.has(key)) continue;
      const queue = [key];
      this.components.set(key, id);
      for (let i = 0; i < queue.length; i++) {
        const [x, y] = queue[i].split(',').map(Number);
        for (const [dx, dy] of DIRS) {
          const next = keyOf(x + dx, y + dy);
          if (this.state.tunnels[next] && !this.components.has(next)) {
            this.components.set(next, id);
            queue.push(next);
          }
        }
      }
      id++;
    }
  }
  connectedStations(key: string): string[] {
    this.rebuild();
    const component = this.components.get(key);
    if (component === undefined) return [];
    return Object.keys(this.state.stations).filter(
      (k) => k !== key && this.components.get(k) === component,
    );
  }
  path(from: string, to: string): string[] | null {
    this.rebuild();
    if (!this.components.has(from) || this.components.get(from) !== this.components.get(to))
      return null;
    const queue = [from],
      parent = new Map<string, string | null>([[from, null]]);
    for (let i = 0; i < queue.length; i++) {
      const key = queue[i];
      if (key === to) {
        const result: string[] = [];
        for (let p: string | null = to; p !== null; p = parent.get(p)!) result.push(p);
        return result.reverse();
      }
      const [x, y] = key.split(',').map(Number);
      for (const [dx, dy] of DIRS) {
        const next = keyOf(x + dx, y + dy);
        if (this.state.tunnels[next] && !parent.has(next)) {
          parent.set(next, key);
          queue.push(next);
        }
      }
    }
    return null;
  }
}
