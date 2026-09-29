import type { DaytimeSnapshot } from '../sim/time';

/** A one-hour twilight either side of sunrise/sunset. UI stays outside this filter. */
export function daylightAt(life: DaytimeSnapshot): number {
  const rise = Math.max(0, Math.min(1, life.hour - life.sunriseHour + 0.5));
  const set = Math.max(0, Math.min(1, life.sunsetHour - life.hour + 0.5));
  const t = Math.min(rise, set);
  return t * t * (3 - 2 * t);
}

/** Preserve colour at night: blue ambient moonlight, warm twilight, bright UI layers. */
export function lightingColor(life: DaytimeSnapshot, cloud = 0): number {
  const light = daylightAt(life);
  const dusk = 4 * light * (1 - light);
  const shade = 1 - cloud * 0.08;
  const r = Math.round((145 + 110 * light + 12 * dusk) * shade);
  const g = Math.round((163 + 92 * light - 12 * dusk) * shade);
  const b = Math.round((207 + 48 * light - 30 * dusk) * shade);
  return (Math.min(255, r) << 16) | (Math.min(255, g) << 8) | Math.min(255, b);
}
