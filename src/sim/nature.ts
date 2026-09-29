import type { MacroState } from '../net/types';
import type { World } from '../world/world';
import { isWater } from '../world/terrain';
import { CHUNK_SIZE } from '../core/constants';
import { isAnchor, isFacilityAnchor } from './buildings';
import { sessionDaytimeAt } from './time';
import { DAYTIME_DAY_MS } from './simConstants';

export type Precipitation = 'clear' | 'rain' | 'snow';
export type HazardKind = 'typhoon' | 'flood' | 'blizzard' | 'earthquake';
export interface Weather {
  precipitation: Precipitation;
  intensity: number;
  windSpeed: number;
  direction: number;
  temperature: number;
  cloud: number;
}
export interface Hazard {
  kind: HazardKind;
  strength: number;
  x: number;
  y: number;
  direction: number;
  speed: number;
  started: number;
  duration: number;
}
export interface NatureState {
  override?: Weather;
  hazard?: Hazard;
  /** Metres of surface water/snow and accumulated structural damage, sparse by tile. */
  water: Record<string, number>;
  snow: Record<string, number>;
  damage: Record<string, number>;
  lastStep: number;
  destroyed: number;
}
export const HAZARD_NAMES: Record<HazardKind, string> = {
  typhoon: '태풍',
  flood: '홍수',
  blizzard: '폭설',
  earthquake: '지진',
};
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));
const rad = (degrees: number) => (degrees * Math.PI) / 180;
const key = (x: number, y: number) => `${x},${y}`;

/** Gameplay-scale weather/hydrology; SI weather units, life-clock integration. */
export class NatureSystem {
  private stepTime: number | null = null;
  private sites: { x: number; y: number }[] = [];
  private siteRevision = -1;
  constructor(
    private world: World,
    private macro: MacroState,
    private changed: () => void,
  ) {
    macro.nature ??= {
      water: {},
      snow: {},
      damage: {},
      lastStep: macro.lifeElapsedMs ?? 0,
      destroyed: 0,
    };
  }
  get state(): NatureState {
    return (this.macro.nature ??= {
      water: {},
      snow: {},
      damage: {},
      lastStep: this.macro.lifeElapsedMs ?? 0,
      destroyed: 0,
    });
  }
  get elapsed(): number {
    return this.stepTime ?? this.macro.lifeElapsedMs ?? 0;
  }
  get weather(): Weather {
    if (this.state.override) return this.state.override;
    const t = sessionDaytimeAt(this.elapsed, Math.floor(this.macro.tick / 24));
    const front = (Math.sin(((this.elapsed / DAYTIME_DAY_MS) * Math.PI * 2) / 2.7) + 1) / 2;
    const temperature =
      12 +
      17 * Math.sin((2 * Math.PI * t.gameDayOfYear) / 360) +
      4 * Math.sin(((t.hour - 9) / 24) * Math.PI * 2);
    return {
      precipitation: front > 0.7 ? (temperature <= 0 ? 'snow' : 'rain') : 'clear',
      intensity: clamp((front - 0.7) / 0.3),
      windSpeed: 2 + 8 * front,
      direction: (210 + 45 * Math.sin(this.elapsed / DAYTIME_DAY_MS)) % 360,
      temperature,
      cloud: 0.15 + 0.8 * front,
    };
  }
  setWeather(value: Weather | null): void {
    if (!value) delete this.state.override;
    else
      this.state.override = {
        precipitation: ['clear', 'rain', 'snow'].includes(value.precipitation)
          ? value.precipitation
          : 'clear',
        intensity: clamp(value.intensity),
        windSpeed: clamp(value.windSpeed, 0, 70),
        direction: clamp(value.direction, 0, 360),
        temperature: clamp(value.temperature, -40, 45),
        cloud: clamp(value.cloud),
      };
    this.changed();
  }
  start(
    kind: HazardKind,
    strength: number,
    x: number,
    y: number,
    direction: number,
    speed: number,
  ): void {
    if (!(kind in HAZARD_NAMES) || ![x, y, direction, speed, strength].every(Number.isFinite))
      return;
    this.state.hazard = {
      kind,
      strength: clamp(strength, 1, 5),
      x,
      y,
      direction: clamp(direction, 0, 360),
      speed: clamp(speed, 0, 40),
      started: this.elapsed,
      duration: DAYTIME_DAY_MS * (kind === 'earthquake' ? 0.02 : 0.5),
    };
    this.changed();
  }
  stop(): void {
    delete this.state.hazard;
    this.changed();
  }
  center(): { x: number; y: number } | null {
    const h = this.state.hazard;
    if (!h) return null;
    const distance =
      h.kind === 'typhoon' || h.kind === 'blizzard'
        ? ((this.elapsed - h.started) / DAYTIME_DAY_MS) * 24 * h.speed
        : 0;
    return {
      x: h.x + Math.sin(rad(h.direction)) * distance,
      y: h.y - Math.cos(rad(h.direction)) * distance,
    };
  }
  windAt(x: number, y: number): { x: number; y: number; speed: number } {
    const w = this.weather;
    let vx = Math.sin(rad(w.direction)) * w.windSpeed,
      vy = -Math.cos(rad(w.direction)) * w.windSpeed;
    const h = this.state.hazard,
      c = this.center();
    if (h?.kind === 'typhoon' && c) {
      const dx = x - c.x,
        dy = y - c.y,
        d = Math.hypot(dx, dy);
      const radius = 8 + h.strength * 3;
      // Calm eye, peak eyewall and exponential decay. Counterclockwise circulation.
      const v =
        (18 + h.strength * 10) *
        Math.min(1, d / radius) *
        Math.exp(-Math.max(0, d - radius) / (radius * 2));
      vx += ((dy - dx * 0.15) / Math.max(1, d)) * v;
      vy += ((-dx - dy * 0.15) / Math.max(1, d)) * v;
    }
    return { x: vx, y: vy, speed: Math.hypot(vx, vy) };
  }
  exposure(x: number, y: number): number {
    const h = this.state.hazard,
      c = this.center();
    return h && c ? clamp(1 - Math.hypot(x - c.x, y - c.y) / (24 + h.strength * 12)) : 0;
  }
  precipitationAt(x: number, y: number): { type: Precipitation; rate: number } {
    const w = this.weather,
      h = this.state.hazard;
    const exposure = this.exposure(x, y);
    if (h && exposure > 0 && h.kind !== 'earthquake')
      return {
        type: h.kind === 'blizzard' ? 'snow' : 'rain',
        rate: (20 + h.strength * 25) * exposure,
      };
    return { type: w.precipitation, rate: w.precipitation === 'clear' ? 0 : w.intensity * 15 };
  }
  currentAt(x: number, y: number): { x: number; y: number } {
    const head = (a: number, b: number) =>
      this.world.sampleHeight(a, b) * 3 + (this.state.water[key(a, b)] ?? 0);
    const wind = this.windAt(x, y);
    return {
      x: clamp((head(x - 1, y) - head(x + 1, y)) * 0.2 + wind.x * 0.008, -2, 2),
      y: clamp((head(x, y - 1) - head(x, y + 1)) * 0.2 + wind.y * 0.008, -2, 2),
    };
  }
  roadGripAt(x: number, y: number): number {
    const p = this.precipitationAt(x, y);
    return clamp(
      1 -
        p.rate / 250 -
        (this.state.snow[key(x, y)] ?? 0) * 0.7 -
        (this.state.water[key(x, y)] ?? 0) * 0.6,
      0.2,
      1,
    );
  }
  update(): void {
    // Fixed life-clock steps make damage independent of render FPS/speed controls.
    let steps = 0;
    while (this.elapsed - this.state.lastStep >= 1000 && steps++ < 10) {
      this.state.lastStep += 1000;
      this.stepTime = this.state.lastStep;
      if (
        this.state.hazard &&
        this.elapsed - this.state.hazard.started >= this.state.hazard.duration
      )
        this.stop();
      this.step((24 * 1000) / DAYTIME_DAY_MS);
      this.stepTime = null;
    }
  }
  private step(hours: number): void {
    if (this.siteRevision !== this.world.walkRevision) {
      this.siteRevision = this.world.walkRevision;
      this.sites = [];
      for (const p of this.world.developedParcels())
        if (p.bld)
          for (let i = 0; i < p.bld.length; i++) {
            if (isAnchor(p.bld[i]) || isFacilityAnchor(p.bld[i]))
              this.sites.push({
                x: p.cx * CHUNK_SIZE + (i % CHUNK_SIZE),
                y: p.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE),
              });
          }
    }
    const nextWater: Record<string, number> = {};
    const cells = new Set([
      ...Object.keys(this.state.water),
      ...Object.keys(this.state.snow),
      ...this.sites.map((s) => key(s.x, s.y)),
    ]);
    const add = (k: string, amount: number) => {
      if (amount > 0.0001) nextWater[k] = (nextWater[k] ?? 0) + amount;
    };
    for (const k of cells) {
      const [x, y] = k.split(',').map(Number);
      const p = this.precipitationAt(x, y),
        w = this.weather;
      let snow = this.state.snow[k] ?? 0;
      snow += p.type === 'snow' ? (p.rate * hours) / 100 : 0;
      const melt = Math.min(snow, Math.max(0, w.temperature) * 0.002 * hours);
      snow -= melt;
      if (snow > 0.001) this.state.snow[k] = snow;
      else delete this.state.snow[k];
      const depth = Math.max(
        0,
        (this.state.water[k] ?? 0) +
          (p.type === 'rain' ? (p.rate / 1000) * hours : 0) +
          melt / 10 -
          0.008 * hours,
      );
      if (isWater(this.world.getTile(x, y))) continue; // Receiving open water is the drainage boundary.
      const neighbors = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];
      const head = this.world.sampleHeight(x, y) * 3 + depth;
      const lower = neighbors
        .map(([a, b]) => ({
          a,
          b,
          drop: Math.max(
            0,
            head - this.world.sampleHeight(a, b) * 3 - (this.state.water[key(a, b)] ?? 0),
          ),
        }))
        .filter((n) => n.drop > 0);
      const total = lower.reduce((sum, n) => sum + n.drop, 0);
      const runoff = Math.min(depth * 0.45, total * hours * 0.2);
      add(k, depth - runoff);
      for (const n of lower)
        if (this.world.isExplored(Math.floor(n.a / CHUNK_SIZE), Math.floor(n.b / CHUNK_SIZE)))
          add(key(n.a, n.b), (runoff * n.drop) / total);
    }
    this.state.water = nextWater;
    const h = this.state.hazard;
    if (h)
      for (const s of this.sites) {
        const e = this.exposure(s.x, s.y);
        if (!e) continue;
        const k = key(s.x, s.y),
          info = this.world.buildingCovering(s.x, s.y);
        if (!info) continue;
        const wind = Math.max(0, this.windAt(s.x, s.y).speed - 28) / 40;
        const flood = Math.max(0, (this.state.water[k] ?? 0) - 0.12) * 3;
        const snow = Math.max(0, (this.state.snow[k] ?? 0) - 0.4);
        const quake = h.kind === 'earthquake' ? h.strength * e * 4 : 0;
        const rate =
          (wind * wind + flood + snow + quake) / (1 + (info.kind === null ? info.level : 2) * 0.3);
        const damage = (this.state.damage[k] ?? 0) + rate * hours * 0.15;
        if (damage >= 1) {
          if (info.kind !== null) this.world.removeFacilityAt(s.x, s.y);
          else this.world.demolishAt(s.x, s.y);
          delete this.state.damage[k];
          this.state.destroyed++;
        } else if (damage > 0) this.state.damage[k] = damage;
      }
    this.changed();
  }
}
