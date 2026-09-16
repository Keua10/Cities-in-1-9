import { chunkIndexOf } from '../core/iso';
import type { MacroState } from '../net/types';
import { DIRS, Build } from '../world/build';
import { isWater } from '../world/terrain';
import type { World } from '../world/world';

export interface MetroState {
  /** Independent underground layer. Surface roads, buildings and utilities are untouched. */
  tunnels: Record<string, true>;
  stations: Record<string, { name: string }>;
  nextStation: number;
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
      delete state.stations[key];
      this.revision++;
      this.changed();
      return { ok: true, message: '지하철 시설 제거 · 지상 시설은 유지됩니다.' };
    }
    if (action === 'station' && !state.stations[key]) {
      if (isWater(this.world.getTile(x, y)))
        return {
          ok: false,
          message: '역은 육지 아래에 설치하세요. 터널은 수역 아래로 연결할 수 있습니다.',
        };
      if (
        this.world.getBuild(x, y) !== Build.Road &&
        !DIRS.some(([dx, dy]) => this.world.getBuild(x + dx, y + dy) === Build.Road)
      )
        return { ok: false, message: '역은 도로 아래 또는 도로 바로 옆에 설치하세요.' };
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
    if (action === 'station') mutable.stations[key] = { name: `지하철 ${mutable.nextStation++}역` };
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
